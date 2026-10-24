import { AIR, type FluidGrid, LIQUID, SOLID } from './fluid-grid';

export interface SolverParams {
  /** Downward acceleration in fluid cells per step squared. */
  gravity: number;
  /** Red-black sweeps per projection. */
  iterations: number;
  /** Over-relaxation factor: 1 is plain Gauss-Seidel, values up to 2 converge faster on a smooth problem. */
  omega: number;
  /** Where the surface sits between a liquid cell center (0) and the air cell center (1); 0.5 is the shared face. */
  theta: number;
}

export const DEFAULT_SOLVER: SolverParams = { gravity: 0.05, iterations: 40, omega: 1.85, theta: 0.5 };

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Faces next to liquid gain downward velocity. */
export function applyGravity(grid: FluidGrid, gravity: number): void {
  const { nx, ny, flags, v } = grid;
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (flags[(j - 1) * nx + i] === LIQUID || flags[j * nx + i] === LIQUID) v[j * nx + i] -= gravity;
    }
  }
}

/** Nothing flows through walls or sand, nor across the domain edge. */
export function zeroSolidFaces(grid: FluidGrid): void {
  const { nx, ny, u, v } = grid;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      if (grid.flagAt(i - 1, j) === SOLID || grid.flagAt(i, j) === SOLID) u[grid.uIndex(i, j)] = 0;
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (grid.flagAt(i, j - 1) === SOLID || grid.flagAt(i, j) === SOLID) v[grid.vIndex(i, j)] = 0;
    }
  }
}

/** Divergence of the face velocities in a cell: net outflow per step. */
function divergenceAt(grid: FluidGrid, i: number, j: number): number {
  return grid.u[grid.uIndex(i + 1, j)] - grid.u[grid.uIndex(i, j)] + grid.v[grid.vIndex(i, j + 1)] - grid.v[grid.vIndex(i, j)];
}

export function maxDivergence(grid: FluidGrid): number {
  let max = 0;
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      if (grid.flags[grid.cellIndex(i, j)] === LIQUID) max = Math.max(max, Math.abs(divergenceAt(grid, i, j)));
    }
  }
  return max;
}

/**
 * Pressure projection: finds p so that subtracting its gradient from the face velocities leaves the liquid
 * divergence-free. Solid faces carry nothing (Neumann); air cells hold p = 0 at the surface, which sits `theta`
 * of the way to the air cell center (ghost fluid). Each face is weighted by 1 / density.
 */
export class PressureSolver {
  private readonly wl: Float32Array;
  private readonly wr: Float32Array;
  private readonly wb: Float32Array;
  private readonly wt: Float32Array;
  private readonly diag: Float32Array;
  private readonly div: Float32Array;
  /** Optional per-cell outflow the projection should leave behind instead of zero divergence (density correction). */
  source: Float32Array | null = null;

  constructor(private readonly grid: FluidGrid) {
    const n = grid.nx * grid.ny;
    this.wl = new Float32Array(n);
    this.wr = new Float32Array(n);
    this.wb = new Float32Array(n);
    this.wt = new Float32Array(n);
    this.diag = new Float32Array(n);
    this.div = new Float32Array(n);
  }

  /** Face weights and divergences for the current flags and velocities. */
  prepare(theta: number): void {
    const { grid } = this;
    const { nx, ny, flags, density, p } = grid;
    const weight = (c: number, flag: number, n: number): number => {
      if (flag === SOLID) return 0;
      if (flag === AIR) return 1 / (density[c] * theta);
      return 2 / (density[c] + density[n]);
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (flags[c] !== LIQUID) {
          p[c] = 0;
          this.diag[c] = 0;
          continue;
        }
        const fl = grid.flagAt(i - 1, j);
        const fr = grid.flagAt(i + 1, j);
        const fb = grid.flagAt(i, j - 1);
        const ft = grid.flagAt(i, j + 1);
        this.wl[c] = weight(c, fl, c - 1);
        this.wr[c] = weight(c, fr, c + 1);
        this.wb[c] = weight(c, fb, c - nx);
        this.wt[c] = weight(c, ft, c + nx);
        this.diag[c] = this.wl[c] + this.wr[c] + this.wb[c] + this.wt[c];
        this.div[c] = divergenceAt(grid, i, j) - (this.source?.[c] ?? 0);
      }
    }
  }

  private sweep(color: number, omega: number): void {
    const { nx, ny, p } = this.grid;
    const { wl, wr, wb, wt, diag, div } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = (j + color) & 1; i < nx; i += 2) {
        const c = j * nx + i;
        const d = diag[c];
        if (d === 0) continue;
        let sum = 0;
        if (i > 0) sum += wl[c] * p[c - 1];
        if (i < nx - 1) sum += wr[c] * p[c + 1];
        if (j > 0) sum += wb[c] * p[c - nx];
        if (j < ny - 1) sum += wt[c] * p[c + nx];
        p[c] += omega * ((sum - div[c]) / d - p[c]);
      }
    }
  }

  /** Largest remaining divergence if the current pressure were applied. */
  residual(): number {
    const { nx, ny, p } = this.grid;
    const { wl, wr, wb, wt, diag, div } = this;
    let max = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (diag[c] === 0) continue;
        let flow = 0;
        if (i > 0) flow += wl[c] * (p[c - 1] - p[c]);
        if (i < nx - 1) flow += wr[c] * (p[c + 1] - p[c]);
        if (j > 0) flow += wb[c] * (p[c - nx] - p[c]);
        if (j < ny - 1) flow += wt[c] * (p[c + nx] - p[c]);
        // Air neighbors hold p = 0 and solid ones have weight 0, so only the liquid-liquid terms differ from -w * p[c].
        max = Math.max(max, Math.abs(div[c] - flow));
      }
    }
    return max;
  }

  /** Subtracts the pressure gradient from the face velocities. */
  apply(): void {
    const { grid } = this;
    const { nx, ny, flags, p, u, v } = grid;
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const l = j * nx + i - 1;
        const r = l + 1;
        const lLiquid = flags[l] === LIQUID;
        const rLiquid = flags[r] === LIQUID;
        if (lLiquid && rLiquid) u[grid.uIndex(i, j)] -= this.wr[l] * (p[r] - p[l]);
        else if (lLiquid && flags[r] === AIR) u[grid.uIndex(i, j)] -= this.wr[l] * -p[l];
        else if (rLiquid && flags[l] === AIR) u[grid.uIndex(i, j)] -= this.wl[r] * p[r];
      }
    }
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const b = (j - 1) * nx + i;
        const t = b + nx;
        const bLiquid = flags[b] === LIQUID;
        const tLiquid = flags[t] === LIQUID;
        if (bLiquid && tLiquid) v[grid.vIndex(i, j)] -= this.wt[b] * (p[t] - p[b]);
        else if (bLiquid && flags[t] === AIR) v[grid.vIndex(i, j)] -= this.wt[b] * -p[b];
        else if (tLiquid && flags[b] === AIR) v[grid.vIndex(i, j)] -= this.wb[t] * p[t];
      }
    }
  }

  /**
   * Solves and applies. Runs `params.iterations` sweeps, or with `tolerance` keeps sweeping (checking every 8)
   * until the residual falls below it or `maxIterations` is reached.
   */
  project(params: SolverParams, tolerance?: number, maxIterations = 5000): { iterations: number; residual: number } {
    this.prepare(params.theta);
    const limit = tolerance === undefined ? params.iterations : maxIterations;
    let done = 0;
    while (done < limit) {
      this.sweep(0, params.omega);
      this.sweep(1, params.omega);
      done++;
      if (tolerance !== undefined && done % 8 === 0 && this.residual() <= tolerance) break;
    }
    const residual = this.residual();
    this.apply();
    return { iterations: done, residual };
  }
}

/**
 * Gives faces that touch no liquid the mean of their valid neighbors, up to `passes` cells out, so the
 * surface can be moved and advected through. Faces beside solids stay zero.
 */
export function extrapolate(grid: FluidGrid, passes = 2): void {
  const { nx, ny, u, v } = grid;
  const touchesLiquid = (a: number, b: number): boolean => a === LIQUID || b === LIQUID;
  const touchesSolid = (a: number, b: number): boolean => a === SOLID || b === SOLID;

  const run = (
    values: Float32Array,
    w: number,
    h: number,
    cellsOf: (i: number, j: number) => [number, number],
  ): void => {
    const valid = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const [a, b] = cellsOf(i, j);
        const idx = j * w + i;
        if (touchesLiquid(a, b)) valid[idx] = 1;
        else values[idx] = 0;
      }
    }
    for (let pass = 0; pass < passes; pass++) {
      const next = valid.slice();
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const idx = j * w + i;
          if (valid[idx] === 1) continue;
          const [a, b] = cellsOf(i, j);
          if (touchesSolid(a, b)) continue;
          let sum = 0;
          let count = 0;
          if (i > 0 && valid[idx - 1] === 1) { sum += values[idx - 1]; count++; }
          if (i < w - 1 && valid[idx + 1] === 1) { sum += values[idx + 1]; count++; }
          if (j > 0 && valid[idx - w] === 1) { sum += values[idx - w]; count++; }
          if (j < h - 1 && valid[idx + w] === 1) { sum += values[idx + w]; count++; }
          if (count > 0) {
            values[idx] = sum / count;
            next[idx] = 1;
          }
        }
      }
      valid.set(next);
    }
  };

  run(u, nx + 1, ny, (i, j) => [grid.flagAt(i - 1, j), grid.flagAt(i, j)]);
  run(v, nx, ny + 1, (i, j) => [grid.flagAt(i, j - 1), grid.flagAt(i, j)]);
}

// Bilinear samples of the staggered fields at a position in fluid-cell units (cell (i, j) spans [i, i+1] x [j, j+1]).
export function sampleU(grid: FluidGrid, x: number, y: number): number {
  const { nx, ny, u } = grid;
  const fx = clamp(x, 0, nx);
  const fy = clamp(y - 0.5, 0, ny - 1);
  const i0 = Math.min(Math.floor(fx), nx);
  const j0 = Math.min(Math.floor(fy), ny - 1);
  const i1 = Math.min(i0 + 1, nx);
  const j1 = Math.min(j0 + 1, ny - 1);
  const tx = fx - i0;
  const ty = fy - j0;
  const w = nx + 1;
  const bottom = u[j0 * w + i0] * (1 - tx) + u[j0 * w + i1] * tx;
  const top = u[j1 * w + i0] * (1 - tx) + u[j1 * w + i1] * tx;
  return bottom * (1 - ty) + top * ty;
}

export function sampleV(grid: FluidGrid, x: number, y: number): number {
  const { nx, ny, v } = grid;
  const fx = clamp(x - 0.5, 0, nx - 1);
  const fy = clamp(y, 0, ny);
  const i0 = Math.min(Math.floor(fx), nx - 1);
  const j0 = Math.min(Math.floor(fy), ny);
  const i1 = Math.min(i0 + 1, nx - 1);
  const j1 = Math.min(j0 + 1, ny);
  const tx = fx - i0;
  const ty = fy - j0;
  const bottom = v[j0 * nx + i0] * (1 - tx) + v[j0 * nx + i1] * tx;
  const top = v[j1 * nx + i0] * (1 - tx) + v[j1 * nx + i1] * tx;
  return bottom * (1 - ty) + top * ty;
}

/** Semi-Lagrangian self-advection of the faces that touch liquid: each takes the velocity found one step upstream. */
export function advectVelocity(grid: FluidGrid): void {
  const { nx, ny, u, v } = grid;
  const newU = u.slice();
  const newV = v.slice();
  for (let j = 0; j < ny; j++) {
    for (let i = 1; i < nx; i++) {
      if (grid.flagAt(i - 1, j) !== LIQUID && grid.flagAt(i, j) !== LIQUID) continue;
      const vel = u[grid.uIndex(i, j)];
      const cross = sampleV(grid, i, j + 0.5);
      newU[grid.uIndex(i, j)] = sampleU(grid, i - vel, j + 0.5 - cross);
    }
  }
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (grid.flagAt(i, j - 1) !== LIQUID && grid.flagAt(i, j) !== LIQUID) continue;
      const vel = v[grid.vIndex(i, j)];
      const cross = sampleU(grid, i + 0.5, j);
      newV[grid.vIndex(i, j)] = sampleV(grid, i + 0.5 - cross, j - vel);
    }
  }
  u.set(newU);
  v.set(newV);
}
