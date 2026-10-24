import {
  FLUID,
  oilKey,
  oilKeyIndex,
  oilShare,
  PARTICLE_STRIDE,
  PARTICLE_KIND,
  rasterKey,
  rasterKeyIndex,
  rasterQuality,
  spawnParticles,
} from '../../src/fluid-params';
import { PARTICLE_TYPES as T } from '../../src/particles';
import type { Scene } from '../../src/scenes';
import type { LiquidModel } from '../liquid-model';
import { mulberry32 } from '../random';
import { AIR, FluidGrid, LIQUID, LIQUID_DENSITY, SOLID } from './fluid-grid';
import { sandDispatch, type SandState } from './sand-ca';
import {
  applyGravity,
  DEFAULT_SOLVER,
  extrapolate,
  PressureSolver,
  sampleU,
  sampleV,
  type SolverParams,
  zeroSolidFaces,
} from './solver';

export interface FlipOptions {
  /** Grid cells per fluid cell: the pressure solve runs on the coarser grid, particles keep their own resolution. */
  k: 1 | 2;
  solver: SolverParams;
  /** Share of the grid's velocity change that is added to the particle's own velocity (1 = pure FLIP, 0 = pure PIC). */
  flipRatio: number;
  /** Fraction of velocity removed each step. */
  damping: number;
  /** Outflow per step demanded of a cell for each full particle-density it holds above rest. */
  stiffness: number;
  /** Same for a cell below rest density that is surrounded by liquid, which pulls the gap closed. */
  pull: number;
  /** Layers one cell deep that rest on a solid do not flow sideways (wetting, stands in for surface tension). */
  film: boolean;
}

export const DEFAULT_FLIP: FlipOptions = {
  k: FLUID.k,
  solver: DEFAULT_SOLVER,
  flipRatio: FLUID.flipRatio,
  damping: FLUID.damping,
  stiffness: FLUID.stiffness,
  pull: FLUID.pull,
  film: FLUID.film,
};

const isOpenType = (type: number): boolean => type === T.EMPTY || type === T.WATER || type === T.OIL;
const isBlockingType = (type: number): boolean => type === T.WALL || type === T.SAND;

/**
 * Rasterization key of every cell (see `rasterKey`), 0 for cells that cannot receive liquid. Candidates are the
 * empty, water and oil cells that hold a particle, plus the open cells within `FLUID.paddingRings` steps of one
 * (the padding rings, nearest first, picked only when particle cells run out). Wall, sand, smoke and fire are
 * never candidates and the rings do not grow through them.
 */
export function rasterKeys(cells: Uint32Array, counts: ArrayLike<number>, width: number, height: number): Float64Array {
  const keys = new Float64Array(width * height);
  const rings = FLUID.paddingRings;
  let frontier: number[] = [];
  for (let c = 0; c < width * height; c++) {
    if (!isOpenType(cells[c] & 0xff) || counts[c] === 0) continue;
    const x = c % width;
    const side = (n: number, inside: boolean): number => (inside && !isBlockingType(cells[n] & 0xff) ? counts[n] : counts[c]);
    const liquidNow = (cells[c] & 0xff) !== T.EMPTY;
    keys[c] = rasterKey(rasterQuality(counts[c], side(c - 1, x > 0), side(c + 1, x < width - 1), liquidNow), c);
    frontier.push(c);
  }
  // Padding rings: open cells at 4-neighbor distance 1..rings from a cell holding a particle, nearer rings first.
  for (let ring = 1; ring <= rings; ring++) {
    const next: number[] = [];
    for (const c of frontier) {
      const x = c % width;
      for (const n of [x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1, c >= width ? c - width : -1, c + width < width * height ? c + width : -1]) {
        if (n < 0 || keys[n] > 0 || !isOpenType(cells[n] & 0xff)) continue;
        keys[n] = rasterKey(FLUID.weightPadding + rings - ring, n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return keys;
}

/**
 * Candidate C2: liquid is a set of particles carrying position and velocity. Each step moves velocity to the
 * grid, projects it, moves the change back (FLIP), advects the particles, then writes liquid into the cell grid
 * so the CA sees it: the N most crowded cells become liquid, N being the particle count / 4, which keeps the
 * cell count of each liquid exactly constant.
 */
export class FlipModel implements LiquidModel {
  readonly options: FlipOptions;
  /** Cells the last rasterization could not fill because fewer cells could hold the particles than the volume needs. */
  shortfall = 0;
  /** Largest `shortfall` since `load`; the volume tests assert it is 0. */
  maxShortfall = 0;
  private state!: SandState;
  private grid!: FluidGrid;
  private prev!: FluidGrid;
  private solver!: PressureSolver;
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private kind = new Uint8Array(0);
  private usum = new Float32Array(0);
  private uw = new Float32Array(0);
  private vsum = new Float32Array(0);
  private vw = new Float32Array(0);
  private count = new Uint16Array(0);
  private oilCount = new Uint16Array(0);
  /** Particle counts per grid cell, for rasterizing. */
  private cellCount = new Uint16Array(0);
  private cellOil = new Uint16Array(0);
  private source = new Float32Array(0);
  /** Residual divergence of the last projection, for the iteration-budget measurements. */
  lastResidual = 0;
  private width = 0;

  constructor(options: Partial<FlipOptions> = {}) {
    this.options = { ...DEFAULT_FLIP, ...options, solver: { ...DEFAULT_FLIP.solver, ...options.solver } };
  }

  load(scene: Scene): void {
    const { width, height } = scene;
    this.width = width;
    const n = width * height;
    this.state = { width, height, cells: Uint32Array.from(scene.cells) };
    const { k } = this.options;
    this.grid = new FluidGrid(width, height, k);
    this.prev = new FluidGrid(width, height, k);
    this.solver = new PressureSolver(this.grid);
    this.usum = new Float32Array(this.grid.u.length);
    this.uw = new Float32Array(this.grid.u.length);
    this.vsum = new Float32Array(this.grid.v.length);
    this.vw = new Float32Array(this.grid.v.length);
    const fluidCells = this.grid.nx * this.grid.ny;
    this.count = new Uint16Array(fluidCells);
    this.oilCount = new Uint16Array(fluidCells);
    this.cellCount = new Uint16Array(n);
    this.cellOil = new Uint16Array(n);
    this.source = new Float32Array(fluidCells);
    this.solver.source = this.source;

    this.shortfall = 0;
    this.maxShortfall = 0;

    const spawned = spawnParticles(this.state.cells, width, height);
    const total = spawned.count;
    this.px = new Float32Array(total);
    this.py = new Float32Array(total);
    this.vx = new Float32Array(total);
    this.vy = new Float32Array(total);
    this.kind = new Uint8Array(total);
    for (let p = 0; p < total; p++) {
      this.px[p] = spawned.floats[p * PARTICLE_STRIDE];
      this.py[p] = spawned.floats[p * PARTICLE_STRIDE + 1];
      this.kind[p] = spawned.words[p * PARTICLE_STRIDE + 4];
    }
  }

  /** Random particle velocities, uniform in [-0.5, 0.5) per component, so parity tests exercise a non-zero field. */
  seedVelocities(seed: number): void {
    const rand = mulberry32(seed);
    for (let p = 0; p < this.px.length; p++) {
      this.vx[p] = rand() / 2 ** 32 - 0.5;
      this.vy[p] = rand() / 2 ** 32 - 0.5;
    }
  }

  /** Test hook: forgets the last `n` particles, to build a model whose particle count is not a multiple of 4. */
  dropParticles(n: number): void {
    this.removeParticles(new Uint8Array(this.px.length).fill(1, Math.max(0, this.px.length - n)));
  }

  /** The particles and the grid fields as they stand between two `step*` calls; the arrays are live, not copies. */
  debugState(): {
    px: Float32Array;
    py: Float32Array;
    vx: Float32Array;
    vy: Float32Array;
    kind: Uint8Array;
    u: Float32Array;
    v: Float32Array;
    p: Float32Array;
    flags: Uint8Array;
    density: Float32Array;
  } {
    const { px, py, vx, vy, kind, grid } = this;
    return { px, py, vx, vy, kind, u: grid.u, v: grid.v, p: grid.p, flags: grid.flags, density: grid.density };
  }

  step(n: number): void {
    for (let s = 0; s < n; s++) this.superstep();
  }

  cells(): Uint32Array {
    return this.state.cells;
  }

  volume(type: number): number {
    let count = 0;
    for (const c of this.state.cells) if ((c & 0xff) === type) count++;
    return count;
  }

  maxSpeed(): number {
    let max = 0;
    for (let p = 0; p < this.px.length; p++) max = Math.max(max, Math.abs(this.vx[p]), Math.abs(this.vy[p]));
    return max;
  }

  private isSolidCell(cell: number): boolean {
    const type = cell & 0xff;
    return type === T.WALL || type === T.SAND;
  }

  private isLiquidCell(cell: number): boolean {
    const type = cell & 0xff;
    return type === T.WATER || type === T.OIL;
  }

  private superstep(): void {
    this.stepGrid();
    this.stepParticles();
    this.stepRaster();
    this.stepCa();
  }

  /** Resolve, count, classify, particle to grid, projection, and the extrapolation after it. */
  stepGrid(): void {
    const { grid, prev, solver, options } = this;
    this.resolveSolids();
    this.countParticles();
    this.classifyFromParticles();
    this.particlesToGrid();
    zeroSolidFaces(grid);
    extrapolate(grid, 2);
    prev.u.set(grid.u);
    prev.v.set(grid.v);

    applyGravity(grid, options.solver.gravity / options.k);
    if (options.damping > 0) {
      const keep = 1 - options.damping;
      for (let i = 0; i < grid.u.length; i++) grid.u[i] *= keep;
      for (let i = 0; i < grid.v.length; i++) grid.v[i] *= keep;
    }
    zeroSolidFaces(grid);
    this.densitySource();
    this.lastResidual = solver.project(options.solver).residual;
    if (options.film) this.pinFilms();
    extrapolate(grid, 2);
  }

  /** Grid to particle: velocity update and advection. */
  stepParticles(): void {
    this.gridToParticles();
  }

  /** Writes the liquid into the cell grid. */
  stepRaster(): void {
    this.rasterize();
  }

  /** The two sand dispatches. */
  stepCa(): void {
    sandDispatch(this.state, 0);
    sandDispatch(this.state, 1);
  }

  /** Oil in a fire cell burns away; particles inside a cell that became sand or wall move up to the first free cell. */
  private resolveSolids(): void {
    const { width, height, cells } = this.state;
    const burnt = new Uint8Array(this.px.length);
    let anyBurnt = false;
    for (let p = 0; p < this.px.length; p++) {
      const i = Math.floor(this.px[p]);
      const j = Math.floor(this.py[p]);
      const cell = cells[j * width + i];
      if (this.kind[p] === PARTICLE_KIND.OIL && (cell & 0xff) === T.FIRE) {
        burnt[p] = 1;
        anyBurnt = true;
        continue;
      }
      if (!this.isSolidCell(cell)) continue;
      let jj = j + 1;
      while (jj < height && this.isSolidCell(cells[jj * width + i])) jj++;
      if (jj < height) {
        this.py[p] = jj + 0.05;
        this.vy[p] = 0;
      }
    }
    if (anyBurnt) this.removeParticles(burnt);
  }

  /** Drops the flagged particles, keeping the order of the rest. */
  private removeParticles(dead: Uint8Array): void {
    const { px, py, vx, vy, kind } = this;
    let n = 0;
    for (let p = 0; p < px.length; p++) {
      if (dead[p] === 1) continue;
      px[n] = px[p];
      py[n] = py[p];
      vx[n] = vx[p];
      vy[n] = vy[p];
      kind[n] = kind[p];
      n++;
    }
    this.px = px.subarray(0, n);
    this.py = py.subarray(0, n);
    this.vx = vx.subarray(0, n);
    this.vy = vy.subarray(0, n);
    this.kind = kind.subarray(0, n);
  }

  private countParticles(): void {
    const { count, oilCount, cellCount, cellOil, px, py, kind, grid, width } = this;
    const k = this.options.k;
    count.fill(0);
    oilCount.fill(0);
    cellCount.fill(0);
    cellOil.fill(0);
    for (let p = 0; p < px.length; p++) {
      const gx = Math.floor(px[p]);
      const gy = Math.floor(py[p]);
      const c = Math.floor(gy / k) * grid.nx + Math.floor(gx / k);
      count[c]++;
      cellCount[gy * width + gx]++;
      if (kind[p] === 1) {
        oilCount[c]++;
        cellOil[gy * width + gx]++;
      }
    }
  }

  /** Solid from the cell grid, liquid wherever a particle sits, density from the mix of particle kinds. */
  private classifyFromParticles(): void {
    const { grid, count, oilCount, state } = this;
    grid.classify(state.cells);
    for (let c = 0; c < count.length; c++) {
      if (grid.flags[c] === SOLID) continue;
      if (count[c] > 0) {
        grid.flags[c] = LIQUID;
        grid.density[c] = (count[c] - oilCount[c] + (oilCount[c] * LIQUID_DENSITY[T.OIL])) / count[c];
      } else {
        grid.flags[c] = AIR;
        grid.density[c] = 0;
      }
    }
  }

  private particlesToGrid(): void {
    const { grid, usum, uw, vsum, vw, px, py, vx, vy } = this;
    const { nx, ny } = grid;
    const k = this.options.k;
    usum.fill(0);
    uw.fill(0);
    vsum.fill(0);
    vw.fill(0);
    for (let p = 0; p < px.length; p++) {
      let fx = px[p] / k;
      let fy = py[p] / k - 0.5;
      let i0 = Math.floor(fx);
      let j0 = Math.floor(fy);
      let tx = fx - i0;
      let ty = fy - j0;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= ny) continue;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di;
          if (i < 0 || i > nx) continue;
          const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
          usum[j * (nx + 1) + i] += (w * vx[p]) / k;
          uw[j * (nx + 1) + i] += w;
        }
      }
      fx = px[p] / k - 0.5;
      fy = py[p] / k;
      i0 = Math.floor(fx);
      j0 = Math.floor(fy);
      tx = fx - i0;
      ty = fy - j0;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j > ny) continue;
        for (let di = 0; di < 2; di++) {
          const i = i0 + di;
          if (i < 0 || i >= nx) continue;
          const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
          vsum[j * nx + i] += (w * vy[p]) / k;
          vw[j * nx + i] += w;
        }
      }
    }
    for (let i = 0; i < grid.u.length; i++) grid.u[i] = uw[i] > 1e-6 ? usum[i] / uw[i] : 0;
    for (let i = 0; i < grid.v.length; i++) grid.v[i] = vw[i] > 1e-6 ? vsum[i] / vw[i] : 0;
  }

  /** Cells holding more particles than at rest ask the projection for outflow, which pushes the particles apart. */
  private densitySource(): void {
    const { grid, count, source, options } = this;
    const { k } = options;
    for (let c = 0; c < source.length; c++) {
      source[c] = 0;
      if (grid.flags[c] !== LIQUID) continue;
      const i = c % grid.nx;
      const j = (c - i) / grid.nx;
      const ratio = count[c] / (FLUID.perCell * k * k) - 1;
      const interior = [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([di, dj]) => grid.flagAt(i + di, j + dj) !== AIR);
      if (ratio > 0) source[c] = options.stiffness * ratio;
      else if (interior) source[c] = options.pull * ratio;
    }
  }

  private isFilm(i: number, j: number): boolean {
    const { grid } = this;
    return grid.flagAt(i, j) === LIQUID && grid.flagAt(i, j - 1) === SOLID && grid.flagAt(i, j + 1) === AIR;
  }

  private pinFilms(): void {
    const { grid } = this;
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 1; i < grid.nx; i++) {
        const left = this.isFilm(i - 1, j);
        const right = this.isFilm(i, j);
        if ((left && (right || grid.flagAt(i, j) === AIR)) || (right && grid.flagAt(i - 1, j) === AIR)) {
          grid.u[grid.uIndex(i, j)] = 0;
        }
      }
    }
  }

  /** Exact wall or sand test at grid resolution, so particles are blocked by the real shape even when k > 1. */
  private solidAt(x: number, y: number): boolean {
    const { width, height, cells } = this.state;
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    const type = cells[y * width + x] & 0xff;
    return type === T.WALL || type === T.SAND;
  }

  private gridToParticles(): void {
    const { grid, prev, px, py, vx, vy, options } = this;
    const { k } = options;
    const a = options.flipRatio;
    const g = options.solver.gravity;
    const clamp = (x: number): number => Math.max(-FLUID.maxSpeed, Math.min(FLUID.maxSpeed, x));
    for (let p = 0; p < px.length; p++) {
      const x = px[p];
      const y = py[p];
      if (grid.flagAt(Math.floor(x / k), Math.floor(y / k)) === LIQUID) {
        const nu = sampleU(grid, x / k, y / k) * k;
        const nv = sampleV(grid, x / k, y / k) * k;
        vx[p] = clamp((1 - a) * nu + a * (vx[p] + nu - sampleU(prev, x / k, y / k) * k));
        vy[p] = clamp((1 - a) * nv + a * (vy[p] + nv - sampleV(prev, x / k, y / k) * k));
      } else {
        vy[p] = clamp(vy[p] - g);
      }
      const x1 = x + vx[p];
      // The position is stored as float32, which can round x1 up to the wall boundary it was just tested against.
      const stored = Math.fround(x1);
      if (this.solidAt(Math.floor(x1), Math.floor(y)) || this.solidAt(Math.floor(stored), Math.floor(y))) vx[p] = 0;
      else px[p] = stored;
      const y1 = y + vy[p];
      const storedY = Math.fround(y1);
      if (this.solidAt(Math.floor(px[p]), Math.floor(y1)) || this.solidAt(Math.floor(px[p]), Math.floor(storedY))) vy[p] = 0;
      else py[p] = storedY;
    }
  }

  /**
   * The most crowded cells become liquid, as many as the particles add up to; the oiliest of them become oil.
   * Cells are ranked by their integer `rasterKey`, which is unique, so the choice has no ties. Only empty, water
   * and oil cells are ever written: wall, sand, smoke and fire keep their cell.
   */
  private rasterize(): void {
    const { width, height, cells } = this.state;
    this.countParticles();
    const { cellCount: count, cellOil: oilCount, px, kind } = this;
    let oil = 0;
    for (let p = 0; p < px.length; p++) oil += kind[p];
    const wanted = Math.floor(px.length / FLUID.perCell);
    const oilWanted = Math.floor(oil / FLUID.perCell);

    const keys = rasterKeys(cells, count, width, height);
    let candidates = 0;
    for (const key of keys) if (key > 0) candidates++;
    const ranked = new Float64Array(candidates);
    let n = 0;
    for (const key of keys) if (key > 0) ranked[n++] = key;
    ranked.sort();
    const take = Math.min(wanted, candidates);
    const chosen: number[] = [];
    for (let r = 0; r < take; r++) chosen.push(rasterKeyIndex(ranked[candidates - 1 - r]));
    this.shortfall = wanted - take;
    this.maxShortfall = Math.max(this.maxShortfall, this.shortfall);

    for (let c = 0; c < width * height; c++) if (this.isLiquidCell(cells[c])) cells[c] = T.EMPTY;
    const oiliest = chosen
      .map((c) => oilKey(oilShare(oilCount[c], count[c]), c))
      .sort((a, b) => b - a)
      .slice(0, oilWanted)
      .map(oilKeyIndex);
    for (const c of chosen) cells[c] = T.WATER;
    for (const c of oiliest) cells[c] = T.OIL;
  }
}
