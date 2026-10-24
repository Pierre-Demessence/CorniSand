import { PARTICLE_TYPES as T } from '../../src/particles';

// Test-only CPU reference of the fluid grid, mirroring the planned GPU buffers (docs/plans/physics-foundation.md).
// Every fluid quantity is in fluid-cell units (one fluid cell = k x k grid cells) and one step is dt = 1.

export const AIR = 0;
export const LIQUID = 1;
export const SOLID = 2;

/** Relative densities; the solver weights each face by 1 / density, so oil is pushed more easily than water. */
export const LIQUID_DENSITY: Readonly<Record<number, number>> = {
  [T.WATER]: 1,
  [T.OIL]: 0.8,
};

export function isLiquidType(type: number): boolean {
  return type === T.WATER || type === T.OIL;
}

export function isSolidType(type: number): boolean {
  return type === T.WALL || type === T.SAND;
}

/**
 * Staggered (MAC) velocity grid. `u` lives on vertical faces, `v` on horizontal faces, pressure and flags in
 * cell centers. Staggering puts each face velocity between the two pressures that drive it.
 */
export class FluidGrid {
  readonly nx: number;
  readonly ny: number;
  /** u[j * (nx + 1) + i] is the face left of cell (i, j); the face at i = nx is the right domain edge. */
  readonly u: Float32Array;
  /** v[j * nx + i] is the face below cell (i, j); the face at j = ny is the top domain edge. */
  readonly v: Float32Array;
  readonly p: Float32Array;
  readonly flags: Uint8Array;
  /** Mean density of the liquid in a cell, 0 where there is none. */
  readonly density: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly k = 1,
    /** Treat an air cell whose four neighbors are all liquid or solid as liquid (a vacancy, not a bubble). */
    readonly fillHoles = false,
  ) {
    this.nx = Math.ceil(width / k);
    this.ny = Math.ceil(height / k);
    this.u = new Float32Array((this.nx + 1) * this.ny);
    this.v = new Float32Array(this.nx * (this.ny + 1));
    this.p = new Float32Array(this.nx * this.ny);
    this.flags = new Uint8Array(this.nx * this.ny);
    this.density = new Float32Array(this.nx * this.ny);
  }

  uIndex(i: number, j: number): number {
    return j * (this.nx + 1) + i;
  }

  vIndex(i: number, j: number): number {
    return j * this.nx + i;
  }

  cellIndex(i: number, j: number): number {
    return j * this.nx + i;
  }

  /** Flag of a fluid cell; outside the domain counts as solid. */
  flagAt(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return SOLID;
    return this.flags[j * this.nx + i];
  }

  /**
   * Flags each fluid cell from the k x k grid cells it covers. Cells outside the grid count as walls. A block is
   * solid when at least half of it is wall or sand (ties go to solid so a thin wall still seals), else liquid
   * when at least half of it is liquid, else air.
   */
  classify(cells: Uint32Array): void {
    const { k, nx, ny, width, height } = this;
    const total = k * k;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let solid = 0;
        let liquid = 0;
        let densitySum = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const x = i * k + dx;
            const y = j * k + dy;
            if (x >= width || y >= height) {
              solid++;
              continue;
            }
            const type = cells[y * width + x] & 0xff;
            if (isSolidType(type)) solid++;
            else if (isLiquidType(type)) {
              liquid++;
              densitySum += LIQUID_DENSITY[type];
            }
          }
        }
        const c = j * nx + i;
        if (solid * 2 >= total) {
          this.flags[c] = SOLID;
          this.density[c] = 0;
        } else if (liquid * 2 >= total) {
          this.flags[c] = LIQUID;
          this.density[c] = densitySum / liquid;
        } else {
          this.flags[c] = AIR;
          this.density[c] = 0;
        }
      }
    }
    if (this.fillHoles) this.fillSingleHoles();
  }

  private fillSingleHoles(): void {
    const { nx, ny, flags, density } = this;
    const holes: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (flags[j * nx + i] !== AIR) continue;
        const around = [this.flagAt(i - 1, j), this.flagAt(i + 1, j), this.flagAt(i, j - 1), this.flagAt(i, j + 1)];
        if (around.includes(AIR) || !around.includes(LIQUID)) continue;
        holes.push(j * nx + i);
      }
    }
    for (const c of holes) {
      const i = c % nx;
      const j = (c - i) / nx;
      let sum = 0;
      let count = 0;
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (this.flagAt(i + di, j + dj) === LIQUID) {
          sum += density[(j + dj) * nx + i + di];
          count++;
        }
      }
      flags[c] = LIQUID;
      density[c] = sum / count;
    }
  }
}
