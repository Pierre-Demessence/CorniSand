import { PARTICLE_TYPES } from './particles';

// Fluid constants and the pure functions both the CPU reference (tests/cpu/) and the WGSL passes must agree on.
// Each value lives here once; the shaders interpolate it, the tests import it.

export const FLUID = {
  /** Grid cells per fluid cell. */
  k: 1,
  /** Downward acceleration in cells per step squared. */
  gravity: 0.05,
  /**
   * Pressure solver, for the CPU reference (`tests/cpu/flip.ts`) and the WGSL passes alike: 'multigrid' or the plain
   * red-black 'sor' below, which the GPU keeps as the baseline of the bench.
   */
  solver: 'multigrid',
  /** Red-black sweeps per pressure projection of the plain solver. */
  iterations: 40,
  omega: 1.85,
  /**
   * Multigrid pressure solve (docs/decisions.md): conjugate gradients, each iteration preconditioned by one V-cycle
   * over 2 x 2 aggregates. Conjugate-gradient iterations (one V-cycle each) per projection, warm-started from the previous projection's pressure.
   */
  cycles: 2,
  /** Red-black smoothing pairs on each level before restricting (pre) and after prolonging (post, in reverse order). */
  preSweeps: 2,
  postSweeps: 2,
  /** Relaxation of the multigrid smoother; `omega` is the plain solver's and makes a poor smoother. */
  smootherOmega: 1,
  /** Scale of the coarse correction: piecewise-constant transfer halves it on a 2D grid, so 2 restores it. */
  correctionScale: 2,
  /** Coarsening stops at the first level whose sides are both at most this. */
  coarsestSize: 8,
  /** Red-black pairs on the coarsest level, run forward then again in reverse so the cycle stays symmetric. */
  coarsestSweeps: 10,
  /**
   * Use the V-cycle as the conjugate-gradient preconditioner; false runs bare V-cycles, which can diverge.
   * Only the CPU reference implements the bare form.
   */
  preconditioned: true,
  /**
   * Conjugate gradients stop once the residual dot product falls below this: what is left is the rounding noise of the
   * residual, and a step along it can add a large constant to a sealed body's pressure (which moves nothing, but
   * makes the next residual noisier).
   */
  cgFloor: 1e-12,
  /**
   * GPU only: the levels whose sides are both at most this are cycled by one workgroup in one dispatch (256 threads,
   * barriers between the half-sweeps) instead of ten dispatches per level.
   */
  tailSize: 64,
  /** Where the surface sits between a liquid cell center (0) and the air cell center (1). */
  theta: 0.5,
  /** Share of the grid's velocity change added to a particle's own velocity (1 = pure FLIP, 0 = pure PIC). */
  flipRatio: 0.8,
  /** Fraction of velocity removed each step. */
  damping: 0.005,
  /** Outflow per step demanded of a cell for each full particle density it holds above rest. */
  stiffness: 0.1,
  /** Same for a cell below rest density that is surrounded by liquid, which pulls the gap closed. */
  pull: 0.1,
  /** Layers one cell deep that rest on a solid do not flow sideways (wetting). */
  film: true,
  /** Particles per liquid cell, on a regular 2 x 2 lattice. */
  perCell: 4,
  /** Lattice offsets inside a cell, in the order the particles are written. */
  lattice: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  /** Velocity clamp in cells per step: nothing may skip a cell in one step. */
  maxSpeed: 1,
  /** Fixed-point scale of the GPU's particle-to-grid atomic accumulators. */
  fixedScale: 2 ** 20,
  /** A face whose particle weight is at or below this carries no velocity (a weight in particles, before the fixed-point scale). */
  minWeight: 1e-6,
  /** Density of oil relative to water; the pressure solve weights each face by 1 / density, so oil moves more easily. */
  oilDensity: 0.8,
  /** A particle found inside a wall or sand cell is put this far above the floor of the first free cell over it. */
  resolveLift: 0.05,
  /** Particles per cell beyond this count do not raise a cell's rasterization rank. */
  countClamp: 12,
  /** Rasterization key weights: own count, each side neighbor's count, already liquid, padding cell. */
  weightCount: 10,
  weightSide: 5,
  weightLiquid: 3,
  weightPadding: 1,
  /**
   * How many rings of empty cells around the particle cells can take liquid when the particles are packed into
   * fewer cells than the volume needs. Measured on the large U-tube: 1 ring leaves up to 299 cells unplaced, 3 rings
   * 64, 5 rings none; the ring quality falls from `weightPadding + paddingRings - 1` to `weightPadding`.
   */
  paddingRings: 6,
} as const;

/** Cell indices are 24 bits wide in the rasterization keys. */
export const MAX_FLUID_CELLS = 2 ** 24 - 1;
/** The largest particle count one 1D indirect dispatch of 256-thread workgroups can cover. */
export const MAX_PARTICLES = 65535 * 256;

/** One level of the multigrid hierarchy: its size and where its cells start in the level-concatenated GPU buffers. */
export interface LevelGeometry {
  width: number;
  height: number;
  offset: number;
}

/** Level 0 is the fluid grid; each next level halves both sides (rounding up) until both are at most `coarsestSize`. */
export function multigridLevels(width: number, height: number): LevelGeometry[] {
  const levels: LevelGeometry[] = [{ width, height, offset: 0 }];
  for (let last = levels[0]; last.width > FLUID.coarsestSize || last.height > FLUID.coarsestSize;) {
    const next = { width: Math.ceil(last.width / 2), height: Math.ceil(last.height / 2), offset: last.offset + last.width * last.height };
    levels.push(next);
    last = next;
  }
  return levels;
}

/** Index of the first level the single-workgroup tail cycle covers (see `FLUID.tailSize`). */
export function multigridTailStart(levels: readonly LevelGeometry[]): number {
  return levels.findIndex((level) => level.width <= FLUID.tailSize && level.height <= FLUID.tailSize);
}

/** Cells of all levels together: the length of the level-concatenated GPU buffers. */
export function multigridCells(levels: readonly LevelGeometry[]): number {
  const last = levels[levels.length - 1];
  return last.offset + last.width * last.height;
}

/** Cell flags of the fluid grid. */
export const FLUID_FLAG = { AIR: 0, LIQUID: 1, SOLID: 2 } as const;

export const PARTICLE_KIND = { WATER: 0, OIL: 1, DEAD: 2 } as const;

const KEY_SHIFT = 2 ** 24;

/**
 * Rank of a cell for rasterization, 0 to 243. Built from the clamped counts only, so every term is an integer
 * and the order is exact on the CPU and the GPU. A side neighbor that is wall, sand or outside the grid is
 * passed as the cell's own count by the caller.
 */
export function rasterQuality(count: number, sideLeft: number, sideRight: number, liquidNow: boolean): number {
  const clamp = (n: number): number => Math.min(n, FLUID.countClamp);
  return (
    FLUID.weightCount * clamp(count)
    + FLUID.weightSide * (clamp(sideLeft) + clamp(sideRight))
    + (liquidNow ? FLUID.weightLiquid : 0)
  );
}

/**
 * Unique, larger-is-better key of a candidate cell: quality in the high bits, then the inverted index, so equal
 * quality prefers the lower index (the lower row). Multiplied, not shifted: `quality << 24` is a negative int32
 * in JS from quality 128 up.
 */
export function rasterKey(quality: number, index: number): number {
  return quality * KEY_SHIFT + (MAX_FLUID_CELLS - index);
}

/** Inverse of the low part of `rasterKey`. */
export function rasterKeyIndex(key: number): number {
  return MAX_FLUID_CELLS - (key % KEY_SHIFT);
}

/** Oil share of a chosen cell, 0 to 255; padding cells (no particles) have none. */
export function oilShare(oilCount: number, count: number): number {
  return count > 0 ? Math.floor((255 * oilCount) / count) : 0;
}

/** Key choosing which of the selected cells become oil: oiliest first, higher index wins ties so oil lands on top. */
export function oilKey(share: number, index: number): number {
  return share * KEY_SHIFT + (index + 1);
}

/** Inverse of the low part of `oilKey`. */
export function oilKeyIndex(key: number): number {
  return (key % KEY_SHIFT) - 1;
}

/**
 * Particles as 5-word records, the layout of the GPU `Particle` struct { px, py, vx, vy: f32, kind: u32 }:
 * `floats` and `words` are two views of one buffer, so `words` index `PARTICLE_STRIDE * i + 4` is the kind.
 */
export const PARTICLE_STRIDE = 5;

export interface SpawnedParticles {
  floats: Float32Array;
  words: Uint32Array;
  count: number;
  water: number;
  oil: number;
}

/** `FLUID.perCell` particles at rest in every water or oil cell, on the lattice, in cell index order. */
export function spawnParticles(cells: Uint32Array, width: number, height: number): SpawnedParticles {
  let water = 0;
  let oil = 0;
  for (let i = 0; i < width * height; i++) {
    const type = cells[i] & 0xff;
    if (type === PARTICLE_TYPES.WATER) water++;
    else if (type === PARTICLE_TYPES.OIL) oil++;
  }
  const count = (water + oil) * FLUID.perCell;
  const buffer = new ArrayBuffer(count * PARTICLE_STRIDE * 4);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  let p = 0;
  for (let i = 0; i < width * height; i++) {
    const type = cells[i] & 0xff;
    if (type !== PARTICLE_TYPES.WATER && type !== PARTICLE_TYPES.OIL) continue;
    const x = i % width;
    const y = (i - x) / width;
    const kind = type === PARTICLE_TYPES.OIL ? PARTICLE_KIND.OIL : PARTICLE_KIND.WATER;
    for (const [dx, dy] of FLUID.lattice) {
      floats[p * PARTICLE_STRIDE] = x + dx;
      floats[p * PARTICLE_STRIDE + 1] = y + dy;
      words[p * PARTICLE_STRIDE + 4] = kind;
      p++;
    }
  }
  return { floats, words, count, water: water * FLUID.perCell, oil: oil * FLUID.perCell };
}
