import { describe, expect, it } from 'vitest';
import { uTube } from '../../src/scenes';
import { parseGrid } from '../ascii';
import { AIR, FluidGrid, LIQUID, SOLID } from './fluid-grid';
import {
  advectVelocity,
  applyGravity,
  DEFAULT_MULTIGRID,
  DEFAULT_SOLVER,
  extrapolate,
  maxDivergence,
  MultigridSolver,
  PressureSolver,
  sampleU,
  sampleV,
  zeroSolidFaces,
} from './solver';
import { convergenceFactor, firstProjection, multigridResiduals, pool, warmStart } from './solver-experiments';

const PARAMS = { ...DEFAULT_SOLVER, gravity: 0.05 };

// Small deterministic generator in [0, 1) so a failure can be replayed.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Open-topped tank with 2-cell walls: `inner` columns wide, `depth` rows of `fill`, `air` rows of headroom.
function tankRows(inner: number, depth: number, air: number, fill = 'w'): string[] {
  const wall = '##';
  return [
    ...Array.from({ length: air }, () => `${wall}${'.'.repeat(inner)}${wall}`),
    ...Array.from({ length: depth }, () => `${wall}${fill.repeat(inner)}${wall}`),
    '#'.repeat(inner + 4),
    '#'.repeat(inner + 4),
  ];
}

type MakeSolver = (grid: FluidGrid) => PressureSolver;

const sor: MakeSolver = (grid) => new PressureSolver(grid);

function makeFluid(rows: string[], k = 1, make = sor): { grid: FluidGrid; solver: PressureSolver } {
  const { cells, width, height } = parseGrid(rows);
  const grid = new FluidGrid(width, height, k);
  grid.classify(cells);
  return { grid, solver: make(grid) };
}

function step(grid: FluidGrid, solver: PressureSolver, params = PARAMS, tolerance = 1e-6): { iterations: number; residual: number } {
  applyGravity(grid, params.gravity);
  zeroSolidFaces(grid);
  return solver.project(params, tolerance);
}

function maxLiquidSpeed(grid: FluidGrid): number {
  let max = 0;
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      if (grid.flags[grid.cellIndex(i, j)] !== LIQUID) continue;
      max = Math.max(
        max,
        Math.abs(grid.u[grid.uIndex(i, j)]),
        Math.abs(grid.u[grid.uIndex(i + 1, j)]),
        Math.abs(grid.v[grid.vIndex(i, j)]),
        Math.abs(grid.v[grid.vIndex(i, j + 1)]),
      );
    }
  }
  return max;
}

// The small test grids would be a single multigrid level at the default coarsest size; 2 gives them several.
const multigrid: MakeSolver = (grid) => new MultigridSolver(grid, { ...DEFAULT_MULTIGRID, coarsestSize: 2 });

describe.each([
  ['SOR', sor],
  ['multigrid', multigrid],
])('pressure projection (%s)', (_name, make) => {
  const fluid = (rows: string[], k = 1): ReturnType<typeof makeFluid> => makeFluid(rows, k, make);

  it('gives a static pool hydrostatic pressure (depth x g within 1%) and almost no velocity', () => {
    const { grid, solver } = fluid(tankRows(12, 20, 6));
    const result = step(grid, solver);
    expect(result.residual).toBeLessThan(1e-5);
    // Surface is the top face of the 20th liquid row; a cell center sits half a cell below its row top.
    const floorRow = 2;
    for (let j = floorRow; j < floorRow + 20; j++) {
      const depth = floorRow + 20 - (j + 0.5);
      const p = grid.p[grid.cellIndex(5, j)];
      expect(Math.abs(p - PARAMS.gravity * depth) / (PARAMS.gravity * depth), `row ${j}`).toBeLessThan(0.01);
    }
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
    expect(maxDivergence(grid)).toBeLessThan(1e-4);
  });

  it('keeps a pool at rest over many steps with a warm start', () => {
    const { grid, solver } = fluid(tankRows(12, 20, 6));
    for (let n = 0; n < 20; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
    expect(maxDivergence(grid)).toBeLessThan(1e-4);
  });

  it('keeps a sealed full chamber at rest (AC8 at the solver level)', () => {
    const rows = ['######', '#wwww#', '#wwww#', '#wwww#', '#wwww#', '######'];
    const { grid, solver } = fluid(rows);
    for (let n = 0; n < 20; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
  });

  it('removes the divergence from an arbitrary velocity field', () => {
    const { grid, solver } = fluid(tankRows(10, 10, 4));
    const rand = lcg(5);
    for (let i = 0; i < grid.u.length; i++) grid.u[i] = (rand() - 0.5) * 0.4;
    for (let i = 0; i < grid.v.length; i++) grid.v[i] = (rand() - 0.5) * 0.4;
    zeroSolidFaces(grid);
    expect(maxDivergence(grid)).toBeGreaterThan(0.05);
    solver.project(PARAMS, 1e-6);
    expect(maxDivergence(grid)).toBeLessThan(1e-4);
  });

  it('holds two liquid layers at rest, the lighter on top', () => {
    const layer = (ch: string, n: number): string[] => Array.from({ length: n }, () => `##${ch.repeat(10)}##`);
    const floor = '#'.repeat(14);
    const { grid, solver } = fluid([...layer('.', 6), ...layer('o', 6), ...layer('w', 8), floor, floor]);
    for (let n = 0; n < 10; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
    // Hydrostatic at the bottom cell: 0.8 per oil row over 6 rows, then 1 per water row down to 7.5 rows.
    expect(grid.p[grid.cellIndex(5, 2)]).toBeCloseTo(PARAMS.gravity * (0.8 * 6 + 7.5), 3);
  });

  it('is hydrostatic on a coarse grid too (k = 2, pressure in fluid-cell units)', () => {
    const { grid, solver } = fluid(tankRows(12, 20, 6).flatMap((row) => [row, row]).map((row) => row.replace(/(.)/g, '$1$1')), 2);
    expect([grid.nx, grid.ny]).toEqual([16, 28]);
    const result = step(grid, solver);
    expect(result.residual).toBeLessThan(1e-5);
    expect(grid.p[grid.cellIndex(8, 2)]).toBeCloseTo(PARAMS.gravity * (22 - 2.5), 2);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
  });

  it('leaves faces that touch no liquid alone in the pressure update', () => {
    const { grid, solver } = fluid(tankRows(6, 4, 4));
    grid.u[grid.uIndex(5, 7)] = 0.7;
    step(grid, solver);
    expect(grid.u[grid.uIndex(5, 7)]).toBeCloseTo(0.7, 6);
  });
});

describe('multigrid', () => {
  it('builds every coarse operator as P^T A P of the fine one (brute force, random blob with air, solid, two densities)', () => {
    const grid = new FluidGrid(24, 20);
    const rand = lcg(11);
    for (let c = 0; c < grid.flags.length; c++) {
      const x = rand();
      grid.flags[c] = x < 0.15 ? SOLID : x < 0.4 ? AIR : LIQUID;
      grid.density[c] = grid.flags[c] === LIQUID ? (rand() < 0.5 ? 1 : 0.8) : 0;
    }
    const solver = new MultigridSolver(grid, { ...DEFAULT_MULTIGRID, coarsestSize: 2 });
    solver.prepare(PARAMS.theta);
    solver.buildLevels();
    const [fine, ...coarse] = solver.levels;
    expect(coarse.length).toBeGreaterThanOrEqual(3);

    // The fine operator as (row, column, value) entries over liquid cells: the diagonal, minus each liquid coupling.
    const entries: [number, number, number][] = [];
    const active = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < fine.nx && j < fine.ny && fine.diag[j * fine.nx + i] > 0;
    for (let j = 0; j < fine.ny; j++) {
      for (let i = 0; i < fine.nx; i++) {
        const c = j * fine.nx + i;
        if (!active(i, j)) continue;
        entries.push([c, c, fine.diag[c]]);
        if (active(i - 1, j)) entries.push([c, c - 1, -fine.wl[c]]);
        if (active(i + 1, j)) entries.push([c, c + 1, -fine.wr[c]]);
        if (active(i, j - 1)) entries.push([c, c - fine.nx, -fine.wb[c]]);
        if (active(i, j + 1)) entries.push([c, c + fine.nx, -fine.wt[c]]);
      }
    }
    coarse.forEach((level, index) => {
      const shift = index + 1;
      // P maps fine cell (i, j) to coarse cell (i >> shift, j >> shift), so (P^T A P)[I, J] sums A over both blocks.
      const block = (c: number): number => ((Math.floor(c / fine.nx) >> shift) * level.nx) + ((c % fine.nx) >> shift);
      const expected = new Map<string, number>();
      for (const [row, column, value] of entries) {
        const key = `${block(row)},${block(column)}`;
        expected.set(key, (expected.get(key) ?? 0) + value);
      }
      const at = (I: number, J: number): number => expected.get(`${I},${J}`) ?? 0;
      const close = (actual: number, wanted: number, what: string): void => {
        expect(Math.abs(actual - wanted), what).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(wanted)));
      };
      for (let J = 0; J < level.ny; J++) {
        for (let I = 0; I < level.nx; I++) {
          const C = J * level.nx + I;
          const where = `level ${shift} cell (${I}, ${J})`;
          close(level.diag[C], at(C, C), `${where} diagonal`);
          if (I > 0) close(level.wl[C], -at(C, C - 1), `${where} left`);
          if (I < level.nx - 1) close(level.wr[C], -at(C, C + 1), `${where} right`);
          if (J > 0) close(level.wb[C], -at(C, C - level.nx), `${where} bottom`);
          if (J < level.ny - 1) close(level.wt[C], -at(C, C + level.nx), `${where} top`);
        }
      }
    });
  });

  it('gives a sealed pocket no coarse diagonal and still keeps it at rest', () => {
    // A 4x4 chamber full of water aligned with one level-2 block: that coarse cell has no exit, its diagonal is 0.
    const rows = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => (x >= 4 && x < 8 && y >= 8 && y < 12 ? 'w' : '#')).join(''));
    const { grid, solver } = makeFluid(rows, 1, multigrid);
    for (let n = 0; n < 10; n++) step(grid, solver);
    const level = (solver as MultigridSolver).levels[2];
    expect(level.diag[1 * level.nx + 1]).toBe(0);
    expect(grid.p.every(Number.isFinite)).toBe(true);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
  });

  // E1 and E2 of the M1.5c experiments at a size the suite can afford; the screen sizes are in solver-screen.test.ts.
  const problems = [pool(128, 300, 250), uTube({ leftArm: 32, rightArm: 32 })];

  it.each(problems.map((scene) => [`${scene.name} ${scene.width}x${scene.height}`, scene] as const))(
    'cuts the first projection residual at least 3x per iteration (E1) on %s',
    (_name, scene) => {
      const residuals = multigridResiduals(scene, DEFAULT_MULTIGRID, 6);
      expect(convergenceFactor(residuals), residuals.map((r) => r.toExponential(1)).join(' ')).toBeLessThanOrEqual(0.35);
      // Conjugate gradients stop early on a direction of non-positive curvature; the step's budget must be spent.
      expect(new MultigridSolver(firstProjection(scene)).project(PARAMS).iterations).toBe(DEFAULT_MULTIGRID.cycles);
    },
  );

  it.each(problems.map((scene) => [`${scene.name} ${scene.width}x${scene.height}`, scene] as const))(
    'keeps the residual at most 0.05 from a warm start after a perturbed step (E2) on %s',
    (_name, scene) => {
      expect(warmStart(scene, DEFAULT_MULTIGRID, 5)).toBeLessThanOrEqual(0.05);
    },
  );
});

describe('velocity extrapolation', () => {
  it('copies the mean of valid neighbors into air for the requested number of cells, no further', () => {
    const { grid } = makeFluid(['#....#', '#....#', '#....#', '#....#', '#wwww#', '######']);
    for (let i = 1; i < 5; i++) grid.v[grid.vIndex(i, 2)] = 0.5;
    extrapolate(grid, 2);
    expect(grid.v[grid.vIndex(2, 3)]).toBeCloseTo(0.5, 6);
    expect(grid.v[grid.vIndex(2, 4)]).toBeCloseTo(0.5, 6);
    expect(grid.v[grid.vIndex(2, 5)]).toBe(0);
  });

  it('keeps faces beside solids at zero', () => {
    const { grid } = makeFluid(['#....#', '#....#', '#....#', '#....#', '#wwww#', '######']);
    for (let i = 1; i < 5; i++) grid.v[grid.vIndex(i, 2)] = 0.5;
    extrapolate(grid, 2);
    expect(grid.u[grid.uIndex(1, 3)]).toBe(0.0);
    expect(grid.v[grid.vIndex(0, 3)]).toBe(0);
    expect(grid.v[grid.vIndex(5, 3)]).toBe(0);
  });
});

describe('advection', () => {
  it('samples exactly at face positions and interpolates between them', () => {
    const { grid } = makeFluid(tankRows(6, 4, 4));
    grid.u[grid.uIndex(3, 3)] = 1;
    grid.u[grid.uIndex(4, 3)] = 3;
    expect(sampleU(grid, 3, 3.5)).toBeCloseTo(1, 6);
    expect(sampleU(grid, 3.5, 3.5)).toBeCloseTo(2, 6);
    grid.v[grid.vIndex(3, 3)] = 2;
    grid.v[grid.vIndex(3, 4)] = 4;
    expect(sampleV(grid, 3.5, 3)).toBeCloseTo(2, 6);
    expect(sampleV(grid, 3.5, 3.5)).toBeCloseTo(3, 6);
  });

  it('carries a uniform flow through unchanged', () => {
    const { grid } = makeFluid(tankRows(10, 6, 4));
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i <= grid.nx; i++) grid.u[grid.uIndex(i, j)] = 0.3;
    }
    advectVelocity(grid);
    expect(grid.u[grid.uIndex(8, 4)]).toBeCloseTo(0.3, 6);
  });
});
