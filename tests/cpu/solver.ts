import { FLUID } from '../../src/fluid-params';
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

export const DEFAULT_SOLVER: SolverParams = {
  gravity: FLUID.gravity,
  iterations: FLUID.iterations,
  omega: FLUID.omega,
  theta: FLUID.theta,
};

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
  protected readonly wl: Float32Array;
  protected readonly wr: Float32Array;
  protected readonly wb: Float32Array;
  protected readonly wt: Float32Array;
  protected readonly diag: Float32Array;
  protected readonly div: Float32Array;
  /** Optional per-cell outflow the projection should leave behind instead of zero divergence (density correction). */
  source: Float32Array | null = null;

  constructor(protected readonly grid: FluidGrid) {
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

export interface MultigridParams {
  cycles: number;
  preSweeps: number;
  postSweeps: number;
  smootherOmega: number;
  correctionScale: number;
  coarsestSize: number;
  coarsestSweeps: number;
  /** Use each V-cycle as the preconditioner of a conjugate-gradient step instead of on its own. */
  preconditioned: boolean;
}

export const DEFAULT_MULTIGRID: MultigridParams = {
  cycles: FLUID.cycles,
  preSweeps: FLUID.preSweeps,
  postSweeps: FLUID.postSweeps,
  smootherOmega: FLUID.smootherOmega,
  correctionScale: FLUID.correctionScale,
  coarsestSize: FLUID.coarsestSize,
  coarsestSweeps: FLUID.coarsestSweeps,
  preconditioned: FLUID.preconditioned,
};

/**
 * One multigrid level: cell `c` satisfies `diag[c] p[c] - sum of w*[c] p[neighbor] = -div[c]`. On level 0 the
 * weights are `PressureSolver`'s, so a weight towards air is the surface weight (harmless: air holds p = 0);
 * on coarser levels they are liquid-liquid couplings only. `diag == 0` marks a cell without liquid.
 */
export interface MultigridLevel {
  nx: number;
  ny: number;
  wl: Float32Array;
  wr: Float32Array;
  wb: Float32Array;
  wt: Float32Array;
  diag: Float32Array;
  div: Float32Array;
  p: Float32Array;
}

function newLevel(nx: number, ny: number): MultigridLevel {
  const n = nx * ny;
  const array = (): Float32Array => new Float32Array(n);
  return { nx, ny, wl: array(), wr: array(), wb: array(), wt: array(), diag: array(), div: array(), p: array() };
}

/** One red-black half-sweep of Gauss-Seidel with relaxation `omega` on any level. */
function smoothLevel(level: MultigridLevel, color: number, omega: number): void {
  const { nx, ny, wl, wr, wb, wt, diag, div, p } = level;
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

/** `pairs` red-black pairs; `reverse` runs black first, so post-smoothing mirrors pre-smoothing (a symmetric cycle). */
function smoothPairs(level: MultigridLevel, pairs: number, omega: number, reverse = false): void {
  const first = reverse ? 1 : 0;
  for (let s = 0; s < pairs; s++) {
    smoothLevel(level, first, omega);
    smoothLevel(level, 1 - first, omega);
  }
}

/** `rhs - A p` in one cell, with `rhs = -div`. */
function residualAt(level: MultigridLevel, i: number, j: number): number {
  const { nx, ny, wl, wr, wb, wt, diag, div, p } = level;
  const c = j * nx + i;
  let sum = 0;
  if (i > 0) sum += wl[c] * p[c - 1];
  if (i < nx - 1) sum += wr[c] * p[c + 1];
  if (j > 0) sum += wb[c] * p[c - nx];
  if (j < ny - 1) sum += wt[c] * p[c + nx];
  return sum - diag[c] * p[c] - div[c];
}

// A coarse cell whose diagonal falls below this share of its children's is enclosed with no exit (a sealed pocket):
// in exact arithmetic its diagonal is 0, and rounding would leave a tiny divisor.
const SEALED_DIAGONAL = 1e-5;

/**
 * Galerkin coarse operator `Pᵀ A P` for piecewise-constant transfer over 2 x 2 blocks: couplings are summed over the
 * fine faces between two blocks, the diagonal is the children's diagonals minus twice the couplings inside the block.
 */
function buildCoarse(fine: MultigridLevel, coarse: MultigridLevel): void {
  const { nx, ny, wl, wr, wb, wt, diag } = fine;
  const active = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < ny && diag[j * nx + i] > 0;
  const cnx = coarse.nx;
  for (let J = 0; J < coarse.ny; J++) {
    for (let I = 0; I < cnx; I++) {
      let cl = 0;
      let cr = 0;
      let cb = 0;
      let ct = 0;
      let d = 0;
      let childDiag = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = 2 * I + dx;
          const j = 2 * J + dy;
          if (!active(i, j)) continue;
          const c = j * nx + i;
          d += diag[c];
          childDiag += diag[c];
          // Each neighbor is either inside the block (subtracted from the diagonal) or across a block edge (a coupling).
          if (active(i - 1, j)) { if (dx === 1) d -= wl[c]; else cl += wl[c]; }
          if (active(i + 1, j)) { if (dx === 0) d -= wr[c]; else cr += wr[c]; }
          if (active(i, j - 1)) { if (dy === 1) d -= wb[c]; else cb += wb[c]; }
          if (active(i, j + 1)) { if (dy === 0) d -= wt[c]; else ct += wt[c]; }
        }
      }
      const C = J * cnx + I;
      coarse.wl[C] = cl;
      coarse.wr[C] = cr;
      coarse.wb[C] = cb;
      coarse.wt[C] = ct;
      coarse.diag[C] = d > SEALED_DIAGONAL * childDiag ? d : 0;
      coarse.p[C] = 0;
      coarse.div[C] = 0;
    }
  }
}

/** Sums the fine residuals of each block into the coarse right-hand side and zeroes the coarse error. */
function restrictResidual(fine: MultigridLevel, coarse: MultigridLevel): void {
  coarse.div.fill(0);
  coarse.p.fill(0);
  const { nx, ny, diag } = fine;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (diag[j * nx + i] === 0) continue;
      coarse.div[(j >> 1) * coarse.nx + (i >> 1)] -= residualAt(fine, i, j);
    }
  }
}

/** Adds `scale` times the coarse error to every liquid cell of its block. */
function prolongAdd(coarse: MultigridLevel, fine: MultigridLevel, scale: number): void {
  const { nx, ny, diag, p } = fine;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (diag[c] !== 0) p[c] += scale * coarse.p[(j >> 1) * coarse.nx + (i >> 1)];
    }
  }
}

/**
 * Same projection as `PressureSolver`, solved by geometric multigrid: 2 x 2 aggregation, Galerkin coarse operators,
 * red-black Gauss-Seidel smoothing. With `params.preconditioned` each symmetric V-cycle preconditions a
 * conjugate-gradient iteration; otherwise the V-cycles run alone. Both start from the previous pressure.
 * The level count is fixed by `params.coarsestSize` at construction.
 */
export class MultigridSolver extends PressureSolver {
  /** Level 0 shares the base solver's weights and the grid's pressure; each next level halves both sides. */
  readonly levels: MultigridLevel[];
  /** Level 0 for the preconditioner: same weights, its own right-hand side (the CG residual) and result. */
  private readonly precondition: MultigridLevel[];
  private readonly r: Float32Array;
  private readonly d: Float32Array;
  private readonly q: Float32Array;

  constructor(grid: FluidGrid, public params: MultigridParams = DEFAULT_MULTIGRID) {
    super(grid);
    const { wl, wr, wb, wt, diag, div } = this;
    const { nx, ny } = grid;
    this.levels = [{ nx, ny, wl, wr, wb, wt, diag, div, p: grid.p }];
    let last = this.levels[0];
    while (last.nx > params.coarsestSize || last.ny > params.coarsestSize) {
      last = newLevel(Math.ceil(last.nx / 2), Math.ceil(last.ny / 2));
      this.levels.push(last);
    }
    const n = nx * ny;
    this.precondition = [{ ...this.levels[0], div: new Float32Array(n), p: new Float32Array(n) }, ...this.levels.slice(1)];
    this.r = new Float32Array(n);
    this.d = new Float32Array(n);
    this.q = new Float32Array(n);
  }

  /** Coarse operators for the weights of the last `prepare`. */
  buildLevels(): void {
    for (let l = 1; l < this.levels.length; l++) buildCoarse(this.levels[l - 1], this.levels[l]);
  }

  /** One cycle on `levels` from level `l` down, improving that level's `p` for its `div`. */
  vCycle(l = 0, levels = this.levels): void {
    const { params } = this;
    const level = levels[l];
    if (l === levels.length - 1) {
      smoothPairs(level, params.coarsestSweeps, params.smootherOmega);
      smoothPairs(level, params.coarsestSweeps, params.smootherOmega, true);
      return;
    }
    smoothPairs(level, params.preSweeps, params.smootherOmega);
    restrictResidual(level, levels[l + 1]);
    this.vCycle(l + 1, levels);
    prolongAdd(levels[l + 1], level, params.correctionScale);
    smoothPairs(level, params.postSweeps, params.smootherOmega, true);
  }

  /**
   * Solves and applies. Runs `params.cycles` iterations (V-cycles, or preconditioned CG steps of one V-cycle each),
   * or with `tolerance` keeps going until the residual falls below it or `maxCycles` is reached. Only `theta` is
   * read from `solver`.
   */
  override project(solver: SolverParams, tolerance?: number, maxCycles = 200): { iterations: number; residual: number } {
    this.prepare(solver.theta);
    this.buildLevels();
    const limit = tolerance === undefined ? this.params.cycles : maxCycles;
    const done = this.params.preconditioned ? this.conjugateGradient(limit, tolerance) : this.cycles(limit, tolerance);
    const residual = this.residual();
    this.apply();
    return { iterations: done, residual };
  }

  private cycles(limit: number, tolerance?: number): number {
    let done = 0;
    while (done < limit) {
      this.vCycle();
      done++;
      if (tolerance !== undefined && this.residual() <= tolerance) break;
    }
    return done;
  }

  // r = rhs - A p everywhere; 0 outside liquid.
  private computeResidual(): void {
    const level = this.levels[0];
    const { nx, ny, diag } = level;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        this.r[c] = diag[c] === 0 ? 0 : residualAt(level, i, j);
      }
    }
  }

  // z = M^-1 r: one symmetric V-cycle on A z = r from z = 0. Returns z (the preconditioner level's `p`).
  private applyPreconditioner(): Float32Array {
    const top = this.precondition[0];
    top.p.fill(0);
    for (let c = 0; c < this.r.length; c++) top.div[c] = -this.r[c];
    this.vCycle(0, this.precondition);
    return top.p;
  }

  // q = A d over the liquid cells.
  private multiply(d: Float32Array, q: Float32Array): void {
    const { nx, ny, wl, wr, wb, wt, diag } = this.levels[0];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (diag[c] === 0) {
          q[c] = 0;
          continue;
        }
        // Air and inactive neighbors hold d = 0, so their (surface) weights add nothing.
        let sum = 0;
        if (i > 0) sum += wl[c] * d[c - 1];
        if (i < nx - 1) sum += wr[c] * d[c + 1];
        if (j > 0) sum += wb[c] * d[c - nx];
        if (j < ny - 1) sum += wt[c] * d[c + nx];
        q[c] = diag[c] * d[c] - sum;
      }
    }
  }

  private conjugateGradient(limit: number, tolerance?: number): number {
    const { r, d, q } = this;
    const p = this.levels[0].p;
    const dot = (a: Float32Array, b: Float32Array): number => {
      let sum = 0;
      for (let c = 0; c < a.length; c++) sum += a[c] * b[c];
      return sum;
    };
    this.computeResidual();
    d.set(this.applyPreconditioner());
    let rz = dot(r, d);
    let done = 0;
    while (done < limit && rz > FLUID.cgFloor) {
      this.multiply(d, q);
      const dq = dot(d, q);
      if (dq <= 0) break;
      const alpha = rz / dq;
      let max = 0;
      for (let c = 0; c < p.length; c++) {
        p[c] += alpha * d[c];
        r[c] -= alpha * q[c];
        max = Math.max(max, Math.abs(r[c]));
      }
      done++;
      if (done === limit || (tolerance !== undefined && max <= tolerance)) break;
      const z = this.applyPreconditioner();
      const next = dot(r, z);
      const beta = next / rz;
      rz = next;
      for (let c = 0; c < d.length; c++) d[c] = z[c] + beta * d[c];
    }
    return done;
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
