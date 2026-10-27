import { describe, expect, it } from 'vitest';
import { AIR } from '../src/air';
import { emptyCellData, tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity } from '../src/elements';
import { ROOM_TEMP } from '../src/heat';
import { PLUME, plume } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { airWords, cell, createSim, device, mulberry32, readCells, runMany, countTypes } from './gpu';
import { heatContent } from './metrics';

// Measured with the constants in `AIR` (docs/plans/m6-air.md, "M6.4 results").
const MEASURED = {
  // Degrees the air just above a 1,000 °C metal block is warmer than the air at the box's side, after 1,200 supersteps.
  aboveWarmer: 466,
  // Heat the air took from the cells of the sealed box in 2,000 supersteps (the box holds about 4.2 million).
  airShare: 80_000,
  // Mean upward speed of the air over the plume scene's plate after `PLUME_STEPS`, in cells per dispatch.
  plumeSpeed: 0.077,
};
// A block of metal at 1,000 °C cools below 200 °C after about 19,500 supersteps (81 s at 1x).
const COOLING_STEPS = 24_000;
// Supersteps the plume has had to develop.
const PLUME_STEPS = 960;
// All 64 steam cells have condensed after about 840 supersteps.
const STEAM_STEPS = 1200;

// A world of cells at room temperature, edited by rectangles; row y = 0 is the bottom.
class World {
  readonly data;
  private readonly temps;

  constructor(readonly width: number, readonly height: number) {
    this.data = emptyCellData(width * height);
    this.temps = tempView(this.data);
    this.temps.fill(ROOM_TEMP);
  }

  // Fills columns [x0, x1) and rows [y0, y1) with cells of `type` at `temp`.
  fill(type: number, x0: number, x1: number, y0: number, y1: number, temp = ROOM_TEMP): this {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.data.kind[y * this.width + x] = cell(type);
        this.temps[y * this.width + x] = temp;
      }
    }
    return this;
  }

  // Walls along the left, right and bottom edges, 2 cells thick: a box open at the top.
  box(): this {
    return this.fill(T.WALL, 0, 2, 0, this.height).fill(T.WALL, this.width - 2, this.width, 0, this.height).fill(T.WALL, 0, this.width, 0, 2);
  }

  // Walls all around.
  sealed(): this {
    return this.box().fill(T.WALL, 0, this.width, this.height - 2, this.height);
  }
}

async function temps(sim: Simulation): Promise<Float32Array> {
  return tempView({ temp: await sim.fields.read('temp') });
}

// The mean over the cells of `type`.
async function meanTemp(sim: Simulation, type: number): Promise<number> {
  const [kind, temp] = [await readCells(sim), await temps(sim)];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < kind.length; i++) {
    if ((kind[i] & 0xff) !== type) continue;
    sum += temp[i];
    count++;
  }
  return sum / count;
}

// Mean of the air cells [i0, i1) x [j0, j1) of an array of `columns` per row.
function airMean(values: Float32Array, columns: number, i0: number, i1: number, j0: number, j1: number): number {
  let sum = 0;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) sum += values[j * columns + i];
  return sum / ((i1 - i0) * (j1 - j0));
}

describe.skipIf(!device)('M6 ambient heat', () => {
  describe('AC14: a cell that holds heat trades heat with the air', () => {
    const metal = elementByKey(ELEMENTS, 'METAL');
    // The temperature a metal cell at `from` has after one exchange with an air cell at room temperature.
    function exchange(from: number, cellSize: number): number {
      const [km, c] = [elementConductivity(metal), elementHeatCapacity(metal)];
      const capacity = AIR.heatCapacity * cellSize * cellSize;
      const flow = ((2 * km * AIR.conductivity) / (km + AIR.conductivity)) * (from - ROOM_TEMP) / (c + capacity);
      return from - flow * capacity;
    }

    it('M6 AC14: a metal cell and its air cell meet at the harmonic mean of their conductivities, never past the mean of the two', async () => {
      const world = new World(4, 4).fill(T.METAL, 1, 2, 1, 2, 500);
      const sim = createSim(4, 4);
      sim.load(world.data);

      await runMany(sim, 1);

      const expected = exchange(500, 4);
      const metalNow = (await temps(sim))[1 * 4 + 1];
      expect(metalNow, 'the metal cell').toBeCloseTo(expected, 3);
      // The mean the two would settle at, weighted by their capacities: one exchange stops short of it.
      const mean = (500 * elementHeatCapacity(metal) + ROOM_TEMP * AIR.heatCapacity * 16) / (elementHeatCapacity(metal) + AIR.heatCapacity * 16);
      expect(metalNow, 'one exchange stops short of the mean').toBeGreaterThan(mean);
      // The air passes that follow spread what the air took across its faces, so only its warming is checked here.
      expect((await sim.air.read()).temperature[0], 'the air cell is warmer').toBeGreaterThan(ROOM_TEMP + 100);
    });

    it('M6 AC14: a solid trades heat with the air cell of its first open neighbor, a solid with none trades none', async () => {
      // Two air cells side by side (columns 0 to 3 and 4 to 7). The metal cell at (3, 1) has walls above, left and below
      // and open space to its right, which belongs to the second air cell.
      const world = new World(8, 4).fill(T.METAL, 3, 4, 1, 2, 500).fill(T.WALL, 3, 4, 2, 3).fill(T.WALL, 2, 3, 1, 2).fill(T.WALL, 3, 4, 0, 1);
      const sim = createSim(8, 4);
      sim.load(world.data);
      await runMany(sim, 1);

      const expected = exchange(500, 4);
      expect((await temps(sim))[1 * 8 + 3], 'the metal cell').toBeCloseTo(expected, 3);
      const air = await sim.air.read();
      expect(air.temperature[0], 'the air cell the cell is in, closed off by the walls').toBe(ROOM_TEMP);
      expect(air.temperature[1], 'the air cell of its open neighbor').toBeGreaterThan(ROOM_TEMP + 100);

      // Shut in by walls on all four sides: no air cell.
      const shut = new World(4, 4).fill(T.METAL, 1, 2, 1, 2, 500).fill(T.WALL, 1, 2, 2, 3).fill(T.WALL, 0, 1, 1, 2).fill(T.WALL, 2, 3, 1, 2).fill(T.WALL, 1, 2, 0, 1);
      const sealed = createSim(4, 4);
      sealed.load(shut.data);
      await runMany(sealed, 3);
      expect((await temps(sealed))[1 * 4 + 1], 'the shut-in metal cell').toBe(500);
      const rest = await sealed.air.read();
      expect(rest.temperature.every((t) => t === ROOM_TEMP), 'the air stays at room temperature').toBe(true);
    });

    // A 16x16 block of metal at 1,000 °C in a box open at the top, aligned with the air cells or not (the block's
    // surface cuts the air cells differently).
    it.each([0, 2])('M6 AC14: a 16x16 metal block at 1,000 °C cools to under 200 °C in air, and the air above it is warmer than beside it (offset %i)', async (offset) => {
      const world = new World(96, 128).box().fill(T.METAL, 40 + offset, 56 + offset, 2 + offset, 18 + offset, 1000);
      const sim = createSim(96, 128, 1);
      sim.load(world.data);

      await runMany(sim, 1200);
      const early = await sim.air.read();
      const { columns } = sim.air;
      // Over the block's middle, just above it, and the same height at the box's side.
      const top = Math.floor((18 + offset) / 4) + 1;
      const above = airMean(early.temperature, columns, 11, 13, top, top + 2);
      const beside = airMean(early.temperature, columns, 4, 6, top, top + 2);
      expect(above - beside, 'degrees the air above is warmer than the air beside').toBeGreaterThan(MEASURED.aboveWarmer * 0.7);
      expect(await meanTemp(sim, T.METAL), 'the block has cooled, but not at once').toBeGreaterThan(800);

      await runMany(sim, COOLING_STEPS - 1200);
      expect(await meanTemp(sim, T.METAL), `block mean after ${COOLING_STEPS} supersteps`).toBeLessThan(200);
    }, 120_000);
  });

  describe('AC15: the total heat', () => {
    it('M6 AC15: a sealed wall box across all thresholds keeps the total heat of its cells, flyers and air, latent heat included, over 2,000 supersteps', async () => {
      const width = 52;
      const height = 44;
      const sim = createSim(width, height, 15);
      const next = mulberry32(15);
      const rand = (): number => next() / 2 ** 32;
      // Start temperatures straddle each element's thresholds (and the latent ends beyond them), so phases change both ways.
      const range: [number, number, number][] = [
        [T.ICE, -100, 300], [T.WATER, -100, 300], [T.STEAM, -150, 300], [T.STONE, 800, 1500],
        [T.LAVA, 900, 1500], [T.METAL, 1300, 1900], [T.MOLTEN_METAL, 1200, 1900], [T.EMPTY, 0, 0],
      ];
      const world = new World(width, height).sealed();
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const [type, low, high] = range[Math.floor(rand() * range.length)];
          world.fill(type, x, x + 1, y, y + 1, type === T.EMPTY ? ROOM_TEMP : low + rand() * (high - low));
        }
      }
      sim.load(world.data);
      const measure = async (): Promise<{ heat: number; cells: number; types: Map<number, number> }> => {
        const grid = { kind: await readCells(sim), temp: await sim.fields.read('temp') };
        const flyers = await sim.flyers.read();
        return {
          heat: heatContent(ELEMENTS, grid, flyers, { data: await sim.air.read(), cellSize: sim.air.cellSize }),
          cells: heatContent(ELEMENTS, grid, flyers),
          types: countTypes(grid.kind),
        };
      };
      const before = await measure();

      for (let i = 1; i <= 4; i++) {
        await runMany(sim, 500);
        const now = await measure();
        expect(Math.abs(now.heat - before.heat) / Math.abs(before.heat), `heat after ${i * 500} supersteps, ${before.heat} at the start`).toBeLessThan(1e-4);
      }
      const after = await measure();
      // The air took part: the cells alone no longer hold the total.
      expect(Math.abs(after.cells - before.cells), 'heat that went into the air').toBeGreaterThan(MEASURED.airShare * 0.5);
      for (const [type, name] of [[T.STONE, 'stone'], [T.METAL, 'metal'], [T.STEAM, 'steam']] as const) {
        expect(after.types.get(type)!, name).toBeGreaterThan(before.types.get(type)!);
      }
      for (const [type, name] of [[T.LAVA, 'lava'], [T.MOLTEN_METAL, 'molten metal'], [T.ICE, 'ice']] as const) {
        expect(after.types.get(type) ?? 0, name).toBeLessThan(before.types.get(type)!);
      }
    }, 120_000);
  });

  describe('AC16: the plume', () => {
    // The plume scene with its plate at `plateTemp`, run for `steps` supersteps; the air over the plate.
    async function overPlate(plateTemp: number, steps: number): Promise<{ speed: number; warmth: number; sim: Simulation }> {
      const scene = plume();
      const { plate, width } = PLUME;
      const temp = tempView(scene.fields);
      for (let y = plate.y0; y < plate.y1; y++) for (let x = plate.x0; x < plate.x1; x++) temp[y * width + x] = plateTemp;
      const sim = createSim(scene.width, scene.height, 3);
      sim.load(scene.fields);
      await runMany(sim, steps);
      const air = await sim.air.read();
      const { columns, cellSize } = sim.air;
      // The air cells over the plate's middle half, from 12 to 60 cells above it.
      const [i0, i1] = [Math.floor((plate.x0 + 16) / cellSize), Math.floor((plate.x1 - 16) / cellSize)];
      const [j0, j1] = [Math.floor((plate.y1 + 12) / cellSize), Math.floor((plate.y1 + 60) / cellSize)];
      return {
        speed: airMean(air.velocityY, columns, i0, i1, j0, j1),
        warmth: airMean(air.temperature, columns, i0, i1, j0, j1) - ROOM_TEMP,
        sim,
      };
    }

    it('M6 AC16: a metal plate at 1,000 °C on the floor of a tall box open at the top drives a rising plume', async () => {
      const { speed, warmth } = await overPlate(PLUME.plate.temp, PLUME_STEPS);
      expect(speed, 'mean upward air speed over the plate, cells per dispatch').toBeGreaterThan(MEASURED.plumeSpeed * 0.7);
      expect(warmth, 'degrees the air over the plate is above room temperature').toBeGreaterThanOrEqual(50);
    }, 60_000);

    it('M6 AC16: with the plate at room temperature the air stays at rest, every word unchanged', async () => {
      const { sim } = await overPlate(ROOM_TEMP, PLUME_STEPS);
      const rest = createSim(PLUME.width, PLUME.height);
      expect(airWords(await sim.air.read())).toEqual(airWords(await rest.air.read()));
    }, 60_000);
  });

  describe('AC17: steam in open air', () => {
    // 64 cells of steam at 110 °C in a box open at the top.
    async function release(options: { air: boolean }, steps: number): Promise<Map<number, number>> {
      const world = new World(128, 192).box().fill(T.STEAM, 60, 68, 20, 28, 110);
      const sim = createSim(128, 192, 1, options);
      sim.load(world.data);
      await runMany(sim, steps);
      return countTypes(await readCells(sim));
    }

    it('M6 AC17: steam released into open air at room temperature condenses into water within the measured number of supersteps', async () => {
      const counts = await release({ air: true }, STEAM_STEPS);
      expect(counts.get(T.STEAM) ?? 0, 'steam left').toBe(0);
      expect(counts.get(T.WATER), 'water').toBe(64);
    }, 60_000);

    it('M6 AC17: without the air the same steam stays steam', async () => {
      const counts = await release({ air: false }, STEAM_STEPS);
      expect(counts.get(T.STEAM), 'steam').toBe(64);
    }, 60_000);
  });
});

