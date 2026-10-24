import { PARTICLE_TYPES as T } from '../../src/particles';
import type { Scene } from '../../src/scenes';
import type { LiquidModel } from '../liquid-model';
import { AIR, FluidGrid, LIQUID, LIQUID_DENSITY, SOLID } from './fluid-grid';
import { sandDispatch, type SandState } from './sand-ca';
import {
  applyGravity,
  extrapolate,
  PressureSolver,
  sampleU,
  sampleV,
  type SolverParams,
  zeroSolidFaces,
} from './solver';

/** Particles per liquid cell, on a regular 2 x 2 lattice at load. */
const PER_CELL = 4;

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
  /** Weight of the two side neighbors' particle counts when ranking cells, which keeps a surface level instead of ragged. */
  smooth: number;
  /** Layers one cell deep that rest on a solid do not flow sideways (wetting, stands in for surface tension). */
  film: boolean;
}

export const DEFAULT_FLIP: FlipOptions = {
  k: 1,
  solver: { gravity: 0.05, iterations: 40, omega: 1.85, theta: 0.5 },
  flipRatio: 0.8,
  damping: 0.005,
  stiffness: 0.5,
  pull: 0.5,
  smooth: 0.5,
  film: true,
};

/**
 * Candidate C2: liquid is a set of particles carrying position and velocity. Each step moves velocity to the
 * grid, projects it, moves the change back (FLIP), advects the particles, then writes liquid into the cell grid
 * so the CA sees it: the N most crowded cells become liquid, N being the particle count / 4, which keeps the
 * cell count of each liquid exactly constant.
 */
export class FlipModel implements LiquidModel {
  readonly options: FlipOptions;
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

    const liquid: number[] = [];
    for (let i = 0; i < n; i++) if (this.isLiquidCell(this.state.cells[i])) liquid.push(i);
    const total = liquid.length * PER_CELL;
    this.px = new Float32Array(total);
    this.py = new Float32Array(total);
    this.vx = new Float32Array(total);
    this.vy = new Float32Array(total);
    this.kind = new Uint8Array(total);
    let p = 0;
    for (const i of liquid) {
      const x = i % width;
      const y = (i - x) / width;
      const oil = (this.state.cells[i] & 0xff) === T.OIL ? 1 : 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        this.px[p] = x + dx;
        this.py[p] = y + dy;
        this.kind[p] = oil;
        p++;
      }
    }
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
    const { grid, prev, solver, options, state } = this;
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

    this.gridToParticles();
    this.rasterize();
    sandDispatch(state, 0);
    sandDispatch(state, 1);
  }

  /** Particles inside a cell that became sand or wall move up to the first free cell. */
  private resolveSolids(): void {
    const { width, height, cells } = this.state;
    for (let p = 0; p < this.px.length; p++) {
      const i = Math.floor(this.px[p]);
      const j = Math.floor(this.py[p]);
      if (!this.isSolidCell(cells[j * width + i])) continue;
      let jj = j + 1;
      while (jj < height && this.isSolidCell(cells[jj * width + i])) jj++;
      if (jj < height) {
        this.py[p] = jj + 0.05;
        this.vy[p] = 0;
      }
    }
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
      const ratio = count[c] / (PER_CELL * k * k) - 1;
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
    const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
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

  /** The most crowded cells become liquid, as many as the particles add up to; the oiliest of them become oil. */
  private rasterize(): void {
    const { width, height, cells } = this.state;
    this.countParticles();
    const { cellCount: count, cellOil: oilCount, px, kind, options } = this;
    let oil = 0;
    for (let p = 0; p < px.length; p++) oil += kind[p];
    const wanted = px.length / PER_CELL;
    const oilWanted = oil / PER_CELL;

    const key = new Float64Array(width * height);
    const candidates: number[] = [];
    for (let c = 0; c < width * height; c++) {
      const type = cells[c] & 0xff;
      if (type === T.WALL || type === T.SAND) continue;
      if (count[c] > 0) {
        const y = Math.floor(c / width);
        const x = c % width;
        const side = (n: number, inside: boolean): number => {
          const t = inside ? cells[n] & 0xff : T.WALL;
          return t === T.WALL || t === T.SAND ? count[c] : count[n];
        };
        const blur = options.smooth * (side(c - 1, x > 0) + side(c + 1, x < width - 1));
        key[c] = count[c] + blur + (this.isLiquidCell(cells[c]) ? 0.3 : 0) + (height - y) / (height * 20);
        candidates.push(c);
      }
    }
    candidates.sort((a, b) => key[b] - key[a] || a - b);
    const chosen = candidates.slice(0, wanted);
    this.padToVolume(chosen, wanted);

    for (let c = 0; c < width * height; c++) if (this.isLiquidCell(cells[c])) cells[c] = T.EMPTY;
    if (oilWanted > 0 && oilWanted < chosen.length) {
      const oilShare = (c: number): number => (count[c] > 0 ? oilCount[c] / count[c] : 0);
      chosen.sort((a, b) => oilShare(b) - oilShare(a) || b - a);
    }
    chosen.forEach((c, n) => {
      cells[c] = n < oilWanted ? T.OIL : T.WATER;
    });
  }

  /** Particles packed into fewer cells than they count for leave the liquid short: add the empty cells beside it, lowest first. */
  private padToVolume(chosen: number[], wanted: number): void {
    const { width, height, cells } = this.state;
    const taken = new Uint8Array(width * height);
    for (const c of chosen) taken[c] = 1;
    while (chosen.length < wanted) {
      const extra: number[] = [];
      for (const c of chosen) {
        const x = c % width;
        for (const n of [x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1, c >= width ? c - width : -1, c + width < width * height ? c + width : -1]) {
          const type = n >= 0 ? cells[n] & 0xff : T.WALL;
          if (n < 0 || taken[n] === 1 || type === T.WALL || type === T.SAND) continue;
          taken[n] = 1;
          extra.push(n);
        }
      }
      if (extra.length === 0) return;
      extra.sort((a, b) => a - b);
      chosen.push(...extra.slice(0, wanted - chosen.length));
    }
  }
}
