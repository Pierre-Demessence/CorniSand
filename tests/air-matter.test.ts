import { describe, expect, it } from 'vitest';
import { AIR } from '../src/air';
import { ELEMENT as T, ELEMENTS, elementByKey, elementDrag, elementGravity } from '../src/elements';
import { fromHalf, packHalf2, toHalf, unpackHalf2 } from '../src/half';
import { caWGSL } from '../src/shaders/ca.wgsl';
import { flightWGSL } from '../src/shaders/flyers.wgsl';
import { RULES } from '../src/shaders/rules';
import type { Simulation } from '../src/simulation';
import { gaussian, peakAt } from './air-pulse';
import { cell, cellType, createSim, device, readCells, run, runMany } from './gpu';

// The air acts on matter (M6.3a): powders and liquids lose `drag` of their speed relative to the air and are pushed by
// its pressure gradient, gases and fire drift with it, and powders and liquids slow it down.

const DISPATCHES = 2;

// A grid of `kind` words, set by position (y = 0 is the bottom row).
class Kinds {
  readonly kind: Uint32Array<ArrayBuffer>;
  constructor(readonly width: number, readonly height: number) {
    this.kind = new Uint32Array(width * height);
  }

  set(x: number, y: number, type: number, variant = 0): void {
    this.kind[y * this.width + x] = cell(type, variant);
  }

  fill(x0: number, y0: number, x1: number, y1: number, type: number): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, type);
  }
}

interface Grain {
  x: number;
  y: number;
}

// Every grain with a variant tag (1..255), by tag: in the grid or in the air as a flyer.
async function tagged(sim: Simulation): Promise<Map<number, Grain>> {
  const grains = new Map<number, Grain>();
  const kind = await readCells(sim);
  for (let i = 0; i < kind.length; i++) {
    const tag = (kind[i] >> 8) & 0xff;
    if (tag !== 0) grains.set(tag, { x: (i % sim.width) + 0.5, y: Math.floor(i / sim.width) + 0.5 });
  }
  for (const f of await sim.flyers.read()) {
    const tag = (f.cell.kind >> 8) & 0xff;
    if (tag !== 0) grains.set(tag, { x: f.x, y: f.y });
  }
  return grains;
}

describe.skipIf(!device)('M6 air moves matter', () => {
  describe('AC2: the generated CA', () => {
    it('M6 AC2: the CA source has no air code without air, and reads the air with it', () => {
      const shape = { cellSize: 4, columns: 16, rows: 16 };
      const source = (air?: typeof shape): string => caWGSL(64, 64, ELEMENTS, RULES, 1024, air);
      expect(source(), 'without air').not.toMatch(/airState|AIR_PUSH|driftCell|airAround/);
      expect(source(shape), 'with air').toMatch(/airState/);
      expect(source(shape), 'with air').toMatch(/driftCell/);
    });

    it('M6 AC2: the flight source has no air code without air, and reads the air with it', () => {
      const shape = { cellSize: 4, columns: 16, rows: 16 };
      expect(flightWGSL(ELEMENTS, 64, 64, 1024), 'without air').not.toMatch(/airState|AIR_PUSH|airAround/);
      expect(flightWGSL(ELEMENTS, 64, 64, 1024, shape), 'with air').toMatch(/airAround/);
    });
  });

  describe('AC10: free fall in still air', () => {
    it.each([['sand', T.SAND, 'SAND'], ['water', T.WATER, 'WATER']])('M6 AC10: a %s grain gains gravity, then loses drag of its speed, per dispatch', async (_name, type, key) => {
      const width = 9;
      const height = 600;
      const start = 590;
      const sim = createSim(width, height);
      const cells = new Uint32Array(width * height);
      cells[start * width + 4] = cell(type);
      sim.load({ kind: cells });
      const row = elementByKey(ELEMENTS, key);
      const gravity = elementGravity(row);
      const drag = elementDrag(row);
      // The grain starts as the bottom cell of its block, which gravity skips, so it gains gravity from the second
      // dispatch on; it moves by its speed, up to one cell per dispatch. The speed is stored as a binary16 value and
      // the GPU rounds it to one by its own rule (Dawn on the RTX 4080 truncates, the CPU conversion rounds to
      // nearest), so the recurrence is run with both and the fall must be within 0.05 of the span between them.
      const nearest = (x: number): number => fromHalf(toHalf(x));
      const truncated = (x: number): number => {
        const half = nearest(x);
        return half > x ? fromHalf(toHalf(x) - 1) : half;
      };
      const fallen = (dispatches: number, store: (x: number) => number): number => {
        let speed = 0;
        let distance = 0;
        for (let d = 1; d < dispatches; d++) {
          speed = store((speed + gravity) * (1 - drag));
          distance += Math.min(speed, 1);
        }
        return distance;
      };
      for (let step = 1; step <= 23; step++) {
        await run(sim, 1);
        const at = (await readCells(sim)).indexOf(cell(type));
        expect(at, `the grain is in the grid after ${step} supersteps`).toBeGreaterThanOrEqual(0);
        const owed = unpackHalf2((await sim.fields.read('remainder'))[at])[1];
        const height = start - Math.floor(at / width) - owed;
        const models = [nearest, truncated].map((store) => fallen(DISPATCHES * step, store));
        expect(height, `cells fallen after ${step} supersteps`).toBeGreaterThanOrEqual(Math.min(...models) - 0.05);
        expect(height, `cells fallen after ${step} supersteps`).toBeLessThanOrEqual(Math.max(...models) + 0.05);
      }
    });
  });

  describe('AC11: gases drift with the air', () => {
    const WIDTH = 256;
    const HEIGHT = 160;
    const STEPS = 24;

    it.each([0.2, -0.2])('M6 AC11: smoke in air at %f cells per dispatch is carried at between 0.5 and 1.2 times its speed', async (wind) => {
      const sim = createSim(WIDTH, HEIGHT, 4);
      const kinds = new Kinds(WIDTH, HEIGHT);
      // A sparse cloud, so most cells have room to drift.
      let count = 0;
      for (let y = 20; y < 50; y++) {
        for (let x = 100; x < 160; x++) {
          if ((x * 7 + y * 13 + ((x * y) % 5)) % 4 === 0) {
            kinds.set(x, y, T.SMOKE);
            count++;
          }
        }
      }
      sim.load({ kind: kinds.kind });
      const n = sim.air.columns * sim.air.rows;
      const centroid = async (): Promise<number> => {
        const kind = await readCells(sim);
        let sum = 0;
        let seen = 0;
        for (let i = 0; i < kind.length; i++) {
          if (cellType(kind[i]) === T.SMOKE) {
            sum += (i % WIDTH) + 0.5;
            seen++;
          }
        }
        expect(seen, 'smoke cells').toBe(count);
        return sum / seen;
      };
      const before = await centroid();
      for (let t = 0; t < STEPS; t++) {
        // Held steady: the wind is set again before every superstep.
        sim.air.load({ velocityX: new Float32Array(n).fill(wind) });
        await run(sim, 1);
      }
      const speed = (await centroid() - before) / (STEPS * DISPATCHES);
      expect(speed / wind, 'centroid speed over the air speed').toBeGreaterThan(0.5);
      expect(speed / wind, 'centroid speed over the air speed').toBeLessThan(1.2);
    });

    it('M6 AC11: flames lean downwind like a gas', async () => {
      const wind = 0.2;
      const sim = createSim(WIDTH, HEIGHT, 4);
      const kinds = new Kinds(WIDTH, HEIGHT);
      let count = 0;
      for (let y = 20; y < 50; y++) {
        for (let x = 100; x < 160; x++) {
          if ((x * 7 + y * 13 + ((x * y) % 5)) % 4 === 0) {
            kinds.set(x, y, T.FIRE);
            count++;
          }
        }
      }
      const life = kinds.kind.map((k) => (k === cell(T.FIRE) ? elementByKey(ELEMENTS, 'FIRE').life!.start : 0));
      sim.load({ kind: kinds.kind, life });
      const n = sim.air.columns * sim.air.rows;
      const centroid = async (): Promise<number> => {
        const kind = await readCells(sim);
        let sum = 0;
        let seen = 0;
        for (let i = 0; i < kind.length; i++) {
          if (cellType(kind[i]) === T.FIRE) {
            sum += (i % WIDTH) + 0.5;
            seen++;
          }
        }
        // Burns for 50 dispatches: all of it is still burning after these.
        expect(seen, 'fire cells').toBe(count);
        return sum / seen;
      };
      const before = await centroid();
      for (let t = 0; t < 10; t++) {
        sim.air.load({ velocityX: new Float32Array(n).fill(wind) });
        await run(sim, 1);
      }
      const speed = (await centroid() - before) / (10 * DISPATCHES);
      expect(speed / wind, 'centroid speed over the air speed').toBeGreaterThan(0.5);
      expect(speed / wind, 'centroid speed over the air speed').toBeLessThan(1.2);
    });

    it('M6 AC11: in air at rest the smoke drifts nowhere', async () => {
      const sim = createSim(WIDTH, HEIGHT, 4);
      const kinds = new Kinds(WIDTH, HEIGHT);
      for (let x = 100; x < 160; x += 3) kinds.set(x, 20, T.SMOKE);
      sim.load({ kind: kinds.kind });
      let sum = 0;
      let seen = 0;
      await runMany(sim, STEPS);
      const kind = await readCells(sim);
      for (let i = 0; i < kind.length; i++) {
        if (cellType(kind[i]) === T.SMOKE) {
          sum += (i % WIDTH) + 0.5;
          seen++;
        }
      }
      // The random sideways dispersion has no direction: the centroid stays within a cell or two of where it began.
      expect(Math.abs(sum / seen - (100 + 157) / 2 - 0.5), 'centroid shift').toBeLessThan(2);
    });
  });

  describe('AC12: matter slows the air', () => {
    const WIDTH = 256;
    const HEIGHT = 96;
    const FLOOR = 2;
    const DEPTH = 20;
    const LEFT = 64;
    const RIGHT = 192;
    const STEPS = 30;
    const WIND = 0.4;

    it.each([['sand', T.SAND], ['water', T.WATER]])('M6 AC12: wind blowing over a %s basin slows to at most 20%% of the air above inside it', async (_name, type) => {
      const sim = createSim(WIDTH, HEIGHT, 2);
      const kinds = new Kinds(WIDTH, HEIGHT);
      kinds.fill(0, 0, WIDTH, FLOOR, T.WALL);
      kinds.fill(LEFT - 2, FLOOR, LEFT, FLOOR + DEPTH, T.WALL);
      kinds.fill(RIGHT, FLOOR, RIGHT + 2, FLOOR + DEPTH, T.WALL);
      kinds.fill(LEFT, FLOOR, RIGHT, FLOOR + DEPTH, type);
      sim.load({ kind: kinds.kind });
      const { columns, rows, cellSize } = sim.air;
      sim.air.load({ velocityX: new Float32Array(columns * rows).fill(WIND) });

      await runMany(sim, STEPS);
      const { velocityX } = await sim.air.read();
      // The middle of the basin (air cells wholly inside the matter) and the air 20 to 40 cells above it.
      const mean = (x0: number, x1: number, y0: number, y1: number): number => {
        let sum = 0;
        let seen = 0;
        for (let j = Math.ceil(y0 / cellSize); j < Math.floor(y1 / cellSize); j++) {
          for (let i = Math.ceil(x0 / cellSize); i < Math.floor(x1 / cellSize); i++) {
            sum += velocityX[j * columns + i];
            seen++;
          }
        }
        return sum / seen;
      };
      const inside = mean(LEFT + 16, RIGHT - 16, FLOOR + 4, FLOOR + DEPTH - 4);
      const above = mean(LEFT + 16, RIGHT - 16, FLOOR + DEPTH + 20, FLOOR + DEPTH + 40);
      expect(above, 'the air above kept most of its speed').toBeGreaterThan(0.5 * WIND);
      expect(inside / above, 'air inside over air above').toBeLessThanOrEqual(0.2);
    });
  });

  describe('AC7 and AC8: a pulse throws sand', () => {
    const WIDTH = 256;
    const HEIGHT = 96;
    const FLOOR = 2;
    const DEPTH = 40;
    const SIGMA = 6;
    const PEAK = 2;
    // The air cell row of the pulse's center: 10 cells under the surface of the layer.
    const CENTER_ROW = 8;
    // The superstep at which the sand is measured: the front has crossed about 16 cells and the pit the pulse digs has
    // not yet filled with the sand around it (86% of the grains that moved went away at 8, 59% at 12).
    const STEPS = 8;
    // Mean distance from the center the tagged grains gain by then, measured, less the 30% the criterion allows.
    const MEASURED_GROWTH = 2.6;
    const RADII = [16, 24, 32, 40, 48];

    // A sand layer in a tank with a floor and side walls, open at the top, with a wall across it at `wallX`; tagged grains
    // (a variant 1 to 255) on a lattice where the layer is sand, from x0 to x1.
    function layer(x0: number, x1: number, xStep: number, wallX?: number): Kinds {
      const kinds = new Kinds(WIDTH, HEIGHT);
      kinds.fill(0, 0, WIDTH, FLOOR, T.WALL);
      kinds.fill(0, FLOOR, 2, HEIGHT, T.WALL);
      kinds.fill(WIDTH - 2, FLOOR, WIDTH, HEIGHT, T.WALL);
      kinds.fill(2, FLOOR, WIDTH - 2, FLOOR + DEPTH, T.SAND);
      if (wallX !== undefined) kinds.fill(wallX, FLOOR, wallX + 1, HEIGHT, T.WALL);
      let tag = 1;
      for (let x = x0; x < x1; x += xStep) {
        for (let y = FLOOR + 1; y < FLOOR + DEPTH; y += 3) {
          if (kinds.kind[y * WIDTH + x] === cell(T.SAND)) kinds.set(x, y, T.SAND, tag++);
        }
      }
      expect(tag, 'tags fit a variant').toBeLessThanOrEqual(256);
      return kinds;
    }

    // The center of air cell (i0, CENTER_ROW), in grid cells.
    const center = (sim: Simulation, i0: number): Grain => ({ x: i0 * sim.air.cellSize + sim.air.cellSize / 2, y: CENTER_ROW * sim.air.cellSize + sim.air.cellSize / 2 });

    it('M6 AC7: the pressure peak arrives at increasing radii in proportion to the radius, at about AIR.waveSpeed', async () => {
      const sim = createSim(WIDTH, HEIGHT, 3);
      sim.load({ kind: layer(100, 156, 4).kind });
      const { columns, cellSize } = sim.air;
      const i0 = columns / 2;
      sim.air.load({ pressure: gaussian(sim, i0, CENTER_ROW, SIGMA, undefined, PEAK) });
      const lines: number[][] = RADII.map(() => []);
      for (let t = 0; t < 30; t++) {
        await run(sim, 1);
        const { pressure } = await sim.air.read();
        RADII.forEach((r, k) => lines[k].push(pressure[CENTER_ROW * columns + i0 + r / cellSize]));
      }
      // The superstep of each peak, and the line time = a + b * radius through them.
      const times = lines.map((line) => peakAt(line, 1) + 1);
      const meanR = RADII.reduce((a, b) => a + b, 0) / RADII.length;
      const meanT = times.reduce((a, b) => a + b, 0) / times.length;
      const slope = RADII.reduce((sum, r, k) => sum + (r - meanR) * (times[k] - meanT), 0) / RADII.reduce((sum, r) => sum + (r - meanR) ** 2, 0);
      RADII.forEach((r, k) => {
        expect(Math.abs(times[k] - (meanT + slope * (r - meanR))), `peak time at radius ${r} against the line, in supersteps`).toBeLessThan(1);
      });
      // Cells per dispatch: measured 0.94 of waveSpeed.
      const speed = 1 / (slope * DISPATCHES);
      expect(speed / AIR.waveSpeed, 'front speed over AIR.waveSpeed').toBeGreaterThan(0.8);
      expect(speed / AIR.waveSpeed, 'front speed over AIR.waveSpeed').toBeLessThan(1.2);
    }, 60_000);

    // The tagged grains' mean gain in distance from `at`, and how many of those that moved more than 2 cells moved away.
    async function throwOf(sim: Simulation, start: Map<number, Grain>, at: Grain): Promise<{ growth: number; moved: number; away: number }> {
      const now = await tagged(sim);
      let growth = 0;
      let moved = 0;
      let away = 0;
      for (const [tag, g0] of start) {
        const g1 = now.get(tag)!;
        const gain = Math.hypot(g1.x - at.x, g1.y - at.y) - Math.hypot(g0.x - at.x, g0.y - at.y);
        growth += gain;
        if (Math.hypot(g1.x - g0.x, g1.y - g0.y) > 2) {
          moved++;
          if (gain > 0) away++;
        }
      }
      return { growth: growth / start.size, moved, away };
    }

    it('M6 AC7: a pulse inside a layer of sand throws the sand outward, and without it no grain moves', async () => {
      const sim = createSim(WIDTH, HEIGHT, 3);
      sim.load({ kind: layer(100, 156, 4).kind });
      const at = center(sim, sim.air.columns / 2);
      const start = await tagged(sim);
      expect(start.size, 'tagged grains').toBeGreaterThan(150);

      await runMany(sim, STEPS);
      const still = await throwOf(sim, start, at);
      expect(still.growth, 'without the pulse, mean distance gained').toBe(0);
      expect(still.moved, 'without the pulse, grains that moved').toBe(0);

      sim.load({ kind: layer(100, 156, 4).kind });
      sim.air.load({ pressure: gaussian(sim, sim.air.columns / 2, CENTER_ROW, SIGMA, undefined, PEAK) });
      await runMany(sim, STEPS);
      const { growth, moved, away } = await throwOf(sim, start, at);
      expect(growth, 'mean distance from the center gained').toBeGreaterThanOrEqual(MEASURED_GROWTH * 0.7);
      expect(moved, 'grains that moved more than 2 cells').toBeGreaterThan(20);
      expect(away / moved, 'share of them that moved away from the center').toBeGreaterThanOrEqual(0.8);
    }, 60_000);

    it('M6 AC8: a wall between the pulse and a pile keeps every grain of the pile within a cell of where it was', async () => {
      const WALL_X = 128;
      const kinds = layer(8, 248, 16, WALL_X);
      const sim = createSim(WIDTH, HEIGHT, 3);
      sim.load({ kind: kinds.kind });
      const i0 = 16;
      sim.air.load({ pressure: gaussian(sim, i0, CENTER_ROW, SIGMA, undefined, PEAK) });
      const start = await tagged(sim);

      await runMany(sim, 30);
      const now = await tagged(sim);
      let farthest = 0;
      let movedBefore = 0;
      for (const [tag, g0] of start) {
        const g1 = now.get(tag)!;
        const d = Math.hypot(g1.x - g0.x, g1.y - g0.y);
        if (g0.x > WALL_X) farthest = Math.max(farthest, d);
        else if (d > 2) movedBefore++;
      }
      expect(movedBefore, 'control: grains on the pulse side that moved more than 2 cells').toBeGreaterThan(10);
      expect(farthest, 'the farthest any grain behind the wall moved').toBeLessThanOrEqual(1);
    }, 60_000);
  });

  describe('AC9: flyers read the air', () => {
    const WIDTH = 640;
    const HEIGHT = 128;
    const START = { x: 10, y: 90 };
    // The air speed of the crosswind, cells per dispatch, held steady.
    const WIND = 0.5;
    // How far a wind of WIND moves a grain thrown at 6 cells per dispatch, in cells, measured: 40 dispatches in (the
    // grain is still flying, so only the flight pass acts on it) and where it lands, 30 cells either way. The
    // criterion allows 30% less.
    const MEASURED_MIDFLIGHT_SHIFT = 5.3;
    const MEASURED_LANDING_SHIFT = 30;

    // A grain thrown sideways from high above a floor. Returns the sim, set up.
    function thrown(options: { air: boolean }): Simulation {
      const sim = createSim(WIDTH, HEIGHT, 5, options);
      const kinds = new Kinds(WIDTH, HEIGHT);
      kinds.fill(0, 0, WIDTH, 2, T.WALL);
      kinds.set(START.x, START.y, T.SAND, 1);
      const velocity = new Uint32Array(WIDTH * HEIGHT);
      velocity[START.y * WIDTH + START.x] = packHalf2(6, 0);
      sim.load({ kind: kinds.kind, velocity });
      return sim;
    }

    // Where the grain is after `supersteps` of a wind at `wind` cells per dispatch (0 for still air), set again before
    // every superstep.
    async function after(sim: Simulation, supersteps: number, wind: number): Promise<Grain> {
      const n = sim.air.columns * sim.air.rows;
      for (let t = 0; t < supersteps; t++) {
        if (wind !== 0) sim.air.load({ velocityX: new Float32Array(n).fill(wind) });
        await run(sim, 1);
      }
      return (await tagged(sim)).get(1)!;
    }

    it('M6 AC9: a grain in flight is carried downwind of where it is in still air, and upwind in a headwind', async () => {
      const midflight = async (wind: number): Promise<number> => {
        const sim = thrown({ air: true });
        const g = await after(sim, 20, wind);
        expect((await sim.flyers.readStats()).live, 'the grain is still in the air').toBe(1);
        return g.x;
      };
      const still = await midflight(0);
      expect(await midflight(WIND) - still, 'shift downwind, in cells').toBeGreaterThanOrEqual(MEASURED_MIDFLIGHT_SHIFT * 0.7);
      expect(still - await midflight(-WIND), 'shift upwind, in cells').toBeGreaterThanOrEqual(MEASURED_MIDFLIGHT_SHIFT * 0.7);
    }, 60_000);

    it('M6 AC9: a grain thrown through a crosswind lands downwind of where it lands in still air, and upwind in a headwind', async () => {
      const still = await after(thrown({ air: true }), 120, 0);
      const downwind = await after(thrown({ air: true }), 120, WIND);
      const upwind = await after(thrown({ air: true }), 120, -WIND);
      const flew = thrown({ air: true });
      await after(flew, 120, WIND);
      expect((await flew.flyers.readStats()).launched, 'the grain flew').toBeGreaterThan(0);
      expect(downwind.x - still.x, 'landing shift downwind, in cells').toBeGreaterThanOrEqual(MEASURED_LANDING_SHIFT * 0.7);
      expect(still.x - upwind.x, 'landing shift upwind, in cells').toBeGreaterThanOrEqual(MEASURED_LANDING_SHIFT * 0.7);
    }, 60_000);

    it('M6 AC9: in still air a flyer flies as it does without air, word for word', async () => {
      const withAir = thrown({ air: true });
      const without = thrown({ air: false });
      for (let t = 0; t < 12; t++) {
        await run(withAir, 1);
        await run(without, 1);
        const a = await withAir.flyers.snapshot();
        const b = await without.flyers.snapshot();
        expect(a, `flyer words after ${t + 1} supersteps`).toEqual(b);
      }
      expect((await withAir.flyers.readStats()).live, 'the grain is still in the air').toBe(1);
    });
  });
});
