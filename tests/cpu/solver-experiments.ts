import { PARTICLE_TYPES as T } from '../../src/particles';
import { mulberry32 } from '../../src/random';
import { packCell, type Scene } from '../../src/scenes';
import { FluidGrid, LIQUID } from './fluid-grid';
import { applyGravity, DEFAULT_SOLVER, MultigridSolver, type MultigridParams, PressureSolver, zeroSolidFaces } from './solver';

// The M1.5c multigrid experiments (E1, E2) on the first projection of real scenes, shared by the unit suite
// (small problems) and `solver-screen.test.ts` (screen-size problems).

/** Fluid grid of a scene at rest after one step of gravity: the problem the first projection solves. */
export function firstProjection(scene: Scene): FluidGrid {
  const grid = new FluidGrid(scene.width, scene.height, 1);
  grid.classify(scene.cells);
  applyGravity(grid, DEFAULT_SOLVER.gravity);
  zeroSolidFaces(grid);
  return grid;
}

/** The scene with every water cell from row `fromY` up turned to oil: a layered body, for the density weights. */
export function oilAbove(scene: Scene, fromY: number): Scene {
  const cells = Uint32Array.from(scene.cells);
  const water = packCell(T.WATER);
  for (let i = fromY * scene.width; i < cells.length; i++) if (cells[i] === water) cells[i] = packCell(T.OIL);
  return { ...scene, name: `${scene.name}+oil`, cells };
}

/** A tank with 2-cell walls and floor, water `depth` deep. */
export function pool(width: number, height: number, depth: number): Scene {
  const cells = new Uint32Array(width * height);
  const wall = packCell(T.WALL);
  const water = packCell(T.WATER);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || x >= width - 2 || y < 2;
      cells[y * width + x] = edge ? wall : y < 2 + depth ? water : 0;
    }
  }
  return { name: `pool${width}x${height}`, width, height, cells, floorY: 2, chambers: [] };
}

/** Largest residual from p = 0 after each of 1 to `cycles` iterations; index 0 is the starting residual. */
export function multigridResiduals(scene: Scene, params: MultigridParams, cycles: number): number[] {
  const start = new MultigridSolver(firstProjection(scene), params);
  start.prepare(DEFAULT_SOLVER.theta);
  const residuals = [start.residual()];
  // Conjugate gradients carry state between iterations, so each count is a fresh solve.
  for (let n = 1; n <= cycles; n++) {
    const solver = new MultigridSolver(firstProjection(scene), { ...params, cycles: n });
    residuals.push(solver.project(DEFAULT_SOLVER).residual);
  }
  return residuals;
}

/** Largest residual from p = 0 after `sweeps` red-black SOR pairs at the plain solver's relaxation. */
export function sorResidual(scene: Scene, sweeps: number): number {
  return new PressureSolver(firstProjection(scene)).project({ ...DEFAULT_SOLVER, iterations: sweeps }).residual;
}

/** Mean reduction per cycle over the run, `(last / first) ^ (1 / cycles)`: the convergence factor E1 bars at 0.35. */
export function convergenceFactor(residuals: number[]): number {
  return (residuals[residuals.length - 1] / residuals[0]) ** (1 / (residuals.length - 1));
}

/** Adds uniform noise in [-amplitude, amplitude) to every face that touches a liquid cell. */
function perturb(grid: FluidGrid, amplitude: number, rand: () => number): void {
  const { nx, ny, u, v } = grid;
  const noise = (): number => (rand() / 2 ** 32 - 0.5) * 2 * amplitude;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      if (grid.flagAt(i - 1, j) === LIQUID || grid.flagAt(i, j) === LIQUID) u[grid.uIndex(i, j)] += noise();
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (grid.flagAt(i, j - 1) === LIQUID || grid.flagAt(i, j) === LIQUID) v[grid.vIndex(i, j)] += noise();
    }
  }
}

/**
 * E2: converge the first projection, then `steps` times add gravity and ±0.05 noise on the liquid faces (what a step
 * of particle motion does) and solve again with the step's budget: `params.cycles` multigrid iterations, or
 * `sorSweeps` plain SOR pairs when given. Returns the largest residual over the steps.
 */
export function warmStart(scene: Scene, params: MultigridParams, steps: number, sorSweeps?: number): number {
  const grid = firstProjection(scene);
  const multigrid = new MultigridSolver(grid, params);
  multigrid.project(DEFAULT_SOLVER, 1e-4);
  const sor = new PressureSolver(grid);
  const rand = mulberry32(7);
  let worst = 0;
  for (let s = 0; s < steps; s++) {
    applyGravity(grid, DEFAULT_SOLVER.gravity);
    perturb(grid, 0.05, rand);
    zeroSolidFaces(grid);
    const result = sorSweeps === undefined
      ? multigrid.project(DEFAULT_SOLVER)
      : sor.project({ ...DEFAULT_SOLVER, iterations: sorSweeps });
    worst = Math.max(worst, result.residual);
  }
  return worst;
}
