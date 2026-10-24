import { describe, expect, it } from 'vitest';
import { parseGrid } from '../ascii';
import { FluidGrid, LIQUID } from './fluid-grid';
import {
  advectVelocity,
  applyGravity,
  DEFAULT_SOLVER,
  extrapolate,
  maxDivergence,
  PressureSolver,
  sampleU,
  sampleV,
  zeroSolidFaces,
} from './solver';

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

function makeFluid(rows: string[], k = 1): { grid: FluidGrid; solver: PressureSolver } {
  const { cells, width, height } = parseGrid(rows);
  const grid = new FluidGrid(width, height, k);
  grid.classify(cells);
  return { grid, solver: new PressureSolver(grid) };
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

describe('pressure projection', () => {
  it('gives a static pool hydrostatic pressure (depth x g within 1%) and almost no velocity', () => {
    const { grid, solver } = makeFluid(tankRows(12, 20, 6));
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
    const { grid, solver } = makeFluid(tankRows(12, 20, 6));
    for (let n = 0; n < 20; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
    expect(maxDivergence(grid)).toBeLessThan(1e-4);
  });

  it('keeps a sealed full chamber at rest (AC8 at the solver level)', () => {
    const rows = ['######', '#wwww#', '#wwww#', '#wwww#', '#wwww#', '######'];
    const { grid, solver } = makeFluid(rows);
    for (let n = 0; n < 20; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
  });

  it('removes the divergence from an arbitrary velocity field', () => {
    const { grid, solver } = makeFluid(tankRows(10, 10, 4));
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
    const { grid, solver } = makeFluid([...layer('.', 6), ...layer('o', 6), ...layer('w', 8), floor, floor]);
    for (let n = 0; n < 10; n++) step(grid, solver);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
    // Hydrostatic at the bottom cell: 0.8 per oil row over 6 rows, then 1 per water row down to 7.5 rows.
    expect(grid.p[grid.cellIndex(5, 2)]).toBeCloseTo(PARAMS.gravity * (0.8 * 6 + 7.5), 3);
  });

  it('is hydrostatic on a coarse grid too (k = 2, pressure in fluid-cell units)', () => {
    const { grid, solver } = makeFluid(tankRows(12, 20, 6).flatMap((row) => [row, row]).map((row) => row.replace(/(.)/g, '$1$1')), 2);
    expect([grid.nx, grid.ny]).toEqual([16, 28]);
    const result = step(grid, solver);
    expect(result.residual).toBeLessThan(1e-5);
    expect(grid.p[grid.cellIndex(8, 2)]).toBeCloseTo(PARAMS.gravity * (22 - 2.5), 2);
    expect(maxLiquidSpeed(grid)).toBeLessThan(1e-3);
  });

  it('leaves faces that touch no liquid alone in the pressure update', () => {
    const { grid, solver } = makeFluid(tankRows(6, 4, 4));
    grid.u[grid.uIndex(5, 7)] = 0.7;
    step(grid, solver);
    expect(grid.u[grid.uIndex(5, 7)]).toBeCloseTo(0.7, 6);
  });
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
