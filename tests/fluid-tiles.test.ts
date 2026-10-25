import { describe, expect, it } from 'vitest';
import type { SimulationInput } from '../src/simulation';
import { PARTICLE_TYPES as T } from '../src/particles';
import { SCENES } from '../src/scenes';
import { cell, createSim, device, idleInput, loadScene, particleRows, readBuffer, readCells, readFloats, readParticles, readSelectState, run, runFluid, runMany } from './gpu';

const WALL = 2;

// A 320x200 tank with a pool and an oil blob in the lower left corner and a block of sand hanging above them: most of
// the grid is empty and tiles drop out and join the active set as the liquid sloshes and the sand lands.
function sparseWorld(): { width: number; height: number; cells: Uint32Array } {
  const width = 320;
  const height = 200;
  const cells = new Uint32Array(width * height);
  const fill = (type: number, x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) cells.fill(cell(type), y * width + x0, y * width + x1);
  };
  fill(T.WALL, 0, WALL, 0, height);
  fill(T.WALL, width - WALL, width, 0, height);
  fill(T.WALL, 0, width, 0, WALL);
  fill(T.WATER, WALL, 60, WALL, 30);
  fill(T.OIL, 20, 50, 30, 38);
  fill(T.SAND, 30, 44, 80, 94);
  fill(T.WALL, 150, 156, WALL, 40);
  return { width, height, cells };
}

// A brush stroke from (x0, y) to (x1, y).
function stroke(type: number, x0: number, x1: number, y: number, radius: number, erasing = false): SimulationInput {
  return { ...idleInput, mousePos: { x: x1, y }, prevMousePos: { x: x0, y }, mouseActive: true, brushSize: radius, particleType: type, erasing };
}

const tileIds = async (list: GPUBuffer, count: number): Promise<number[]> => [...(await readBuffer(device!, list, 4 * (1 + count))).subarray(1)];

describe.skipIf(!device)('active tiles', () => {
  it('runs a sparse world exactly as the same world with every tile active', async () => {
    const { width, height, cells } = sparseWorld();
    const tiled = createSim(width, height);
    const reference = createSim(width, height, 1, { activeTiles: false });
    loadScene(tiled, cells);
    loadScene(reference, cells);

    for (let round = 0; round < 8; round++) {
      await runMany(tiled, 40);
      await runMany(reference, 40);
      const label = `after ${(round + 1) * 40} supersteps`;
      expect(await readCells(tiled), `${label}: cells`).toEqual(await readCells(reference));
      expect(particleRows(await readParticles(tiled)), `${label}: particles`).toEqual(particleRows(await readParticles(reference)));
      const faces = [['u', (width + 1) * height], ['v', width * (height + 1)], ['p', width * height]] as const;
      for (const [name, size] of faces) {
        const a = await readFloats(tiled.fluid.grid[name], size);
        const b = await readFloats(reference.fluid.grid[name], size);
        expect(a, `${label}: ${name}`).toEqual(b);
      }
      expect(await readSelectState(tiled), `${label}: selection state`).toEqual(await readSelectState(reference));
    }
    // The world really was sparse: the tiled run did not just run everything.
    const { count } = tiled.fluid.tiles;
    const active = (await readBuffer(device!, tiled.fluid.tiles.active, 4))[0];
    expect(active).toBeGreaterThan(0);
    expect(active).toBeLessThan(count / 2);
  });

  it('runs a world whose liquid is erased and painted again elsewhere exactly as with every tile active', async () => {
    const { width, height, cells } = sparseWorld();
    const tiled = createSim(width, height);
    const reference = createSim(width, height, 1, { activeTiles: false });
    loadScene(tiled, cells);
    loadScene(reference, cells);
    const both = async (supersteps: number, input?: SimulationInput): Promise<void> => {
      await run(tiled, supersteps, input);
      await run(reference, supersteps, input);
    };
    const expectSame = async (label: string): Promise<void> => {
      expect(await readCells(tiled), `${label}: cells`).toEqual(await readCells(reference));
      expect(particleRows(await readParticles(tiled)), `${label}: particles`).toEqual(particleRows(await readParticles(reference)));
      for (const [name, size] of [['u', (width + 1) * height], ['v', width * (height + 1)], ['p', width * height]] as const) {
        expect(await readFloats(tiled.fluid.grid[name], size), `${label}: ${name}`).toEqual(await readFloats(reference.fluid.grid[name], size));
      }
    };

    await both(32);
    await both(8);
    await both(1, stroke(T.WATER, 0, 80, 15, 40, true));
    await both(8);
    await expectSame('after the erase');
    // Nothing is alive and the frame after the last particle died has wiped the last clear set.
    await both(8);
    expect((await readBuffer(device!, tiled.fluid.tiles.active, 4))[0], 'no active tile without liquid').toBe(0);
    expect((await readBuffer(device!, tiled.fluid.tiles.clear, 4))[0], 'no clear tile without liquid').toBe(0);
    await both(1, stroke(T.WATER, 250, 250, 30, 8));
    for (let round = 0; round < 4; round++) {
      await both(20);
      await expectSame(`${(round + 1) * 20} supersteps after the new water`);
    }
    expect((await readBuffer(device!, tiled.fluid.tiles.active, 4))[0]).toBeGreaterThan(0);
  });

  it('runs the stock scenes exactly as with every tile active', async () => {
    for (const name of ['damBreak', 'oilOnWater', 'sandIntoPool']) {
      const scene = SCENES[name]();
      const tiled = createSim(scene.width, scene.height);
      const reference = createSim(scene.width, scene.height, 1, { activeTiles: false });
      loadScene(tiled, scene.cells);
      loadScene(reference, scene.cells);
      await runMany(tiled, 120);
      await runMany(reference, 120);
      expect(await readCells(tiled), name).toEqual(await readCells(reference));
      expect(particleRows(await readParticles(tiled)), name).toEqual(particleRows(await readParticles(reference)));
    }
  });

  it('lists the 3 x 3 tiles around a droplet as the active and the clear set', async () => {
    const width = 128;
    const height = 64;
    const cells = new Uint32Array(width * height);
    cells.fill(cell(T.WALL), 0, width * WALL);
    cells[WALL * width + 20] = cell(T.WATER);
    const sim = createSim(width, height);
    loadScene(sim, cells);
    await runFluid(sim, 1);

    const { columns, active, clear } = sim.fluid.tiles;
    // The droplet is in tile column 2, tile row 0; the 3 x 3 block around it loses the row below the grid.
    const expected = [0, 1].flatMap((row) => [1, 2, 3].map((column) => row * columns + column));
    expect(await tileIds(active, expected.length)).toEqual(expected);
    expect((await readBuffer(device!, active, 4))[0]).toBe(expected.length);
    expect((await readBuffer(device!, clear, 4))[0]).toBe(expected.length);
    expect((await readBuffer(device!, sim.fluid.tiles.args, 24)).slice(0, 6)).toEqual(new Uint32Array([expected.length, 1, 1, expected.length, 1, 1]));
  });
});
