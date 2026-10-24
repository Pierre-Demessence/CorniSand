import { describe, expect, it } from 'vitest';
import { FLUID, FLUID_FLAG } from '../src/fluid-params';
import type { Simulation } from '../src/simulation';
import { parseGrid } from './ascii';
import { createSim, device, loadScene, readBuffer, readFloats, readResidual, runFluid } from './gpu';

// Open-topped tank with 2-cell walls: `inner` columns wide, `depth` rows of water, `air` rows of headroom.
function tankRows(inner: number, depth: number, air: number): string[] {
  return [
    ...Array.from({ length: air }, () => `##${'.'.repeat(inner)}##`),
    ...Array.from({ length: depth }, () => `##${'w'.repeat(inner)}##`),
    '#'.repeat(inner + 4),
    '#'.repeat(inner + 4),
  ];
}

function load(rows: string[]): { sim: Simulation; width: number; height: number } {
  const { cells, width, height } = parseGrid(rows);
  const sim = createSim(width, height);
  loadScene(sim, cells);
  return { sim, width, height };
}

// Steps in chunks of one encoder each; the particles never move, so every step solves the same field again,
// warm-started from the pressure of the previous one.
async function stepMany(sim: Simulation, steps: number): Promise<void> {
  for (let done = 0; done < steps; done += 20) await runFluid(sim, Math.min(20, steps - done), done === 0);
}

// Largest face speed around a liquid cell.
async function maxLiquidSpeed(sim: Simulation, width: number, height: number): Promise<number> {
  const { grid } = sim.fluid;
  const flags = await readBuffer(device!, grid.flags, width * height * 4);
  const u = await readFloats(grid.u, (width + 1) * height);
  const v = await readFloats(grid.v, width * (height + 1));
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (flags[y * width + x] !== FLUID_FLAG.LIQUID) continue;
      max = Math.max(
        max,
        Math.abs(u[y * (width + 1) + x]),
        Math.abs(u[y * (width + 1) + x + 1]),
        Math.abs(v[y * width + x]),
        Math.abs(v[(y + 1) * width + x]),
      );
    }
  }
  return max;
}

describe.skipIf(!device)('GPU pressure solve', () => {
  it('gives a still pool hydrostatic pressure (within 1%) and a converged residual after 200 steps', async () => {
    // 32 x 40: floor 2 rows, 20 rows of water, 18 rows of headroom; 4 particles per cell, so no density source.
    const { sim, width, height } = load(tankRows(28, 20, 18));
    await stepMany(sim, 200);

    const p = await readFloats(sim.fluid.grid.p, width * height);
    // The step adds gravity, then damping scales it, so the force that acts is gravity * (1 - damping).
    const gravity = FLUID.gravity * (1 - FLUID.damping);
    const floorRows = 2;
    const depthRows = 20;
    for (let y = floorRows; y < floorRows + depthRows; y++) {
      // The air above the pool holds p = 0 at the shared face, so depth runs from the surface to the cell center.
      const depth = floorRows + depthRows - (y + 0.5);
      const expected = gravity * depth;
      expect(Math.abs(p[y * width + 16] - expected) / expected, `row ${y}`).toBeLessThan(0.01);
    }
    expect(await readResidual(sim)).toBeLessThanOrEqual(1e-4);
  });

  it('keeps a sealed full chamber at rest (AC8 at the solver level)', async () => {
    const { sim, width, height } = load(['######', '#wwww#', '#wwww#', '#wwww#', '#wwww#', '######']);
    await stepMany(sim, 30);
    expect(await maxLiquidSpeed(sim, width, height)).toBeLessThanOrEqual(1e-3);
  });
});
