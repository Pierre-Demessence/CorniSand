import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { PROP_FIELDS, packElements } from '../src/element-table';
import {
  DENSITY_KNOTS, ELEMENT as T, ELEMENTS, densityAt, densityProfile, elementByKey, validateElements, type ElementDef,
} from '../src/elements';
import { ABSOLUTE_ZERO, ROOM_TEMP } from '../src/heat';
import { CELL_SIZE, CONVECTION_GAIN, DISPATCH_TIME, G, convectionChance } from '../src/physics';
import type { Simulation } from '../src/simulation';
import { cell, cellType, createSim, device, readCells, runMany } from './gpu';

const NO_AIR = { air: false };

const WATER = elementByKey(ELEMENTS, 'WATER');
const OIL = elementByKey(ELEMENTS, 'OIL');
const STEAM = elementByKey(ELEMENTS, 'STEAM');
const SAND = elementByKey(ELEMENTS, 'SAND');
const EMPTY = elementByKey(ELEMENTS, 'EMPTY');

describe('M8.8 AC9: density by temperature', () => {
  it('M8.8 AC9: gives water its handbook density at its knots, densest at 4 °C', () => {
    expect(densityAt(WATER, 0)).toBeCloseTo(999.8, 6);
    expect(densityAt(WATER, 4)).toBeCloseTo(1000, 6);
    expect(densityAt(WATER, 40)).toBeCloseTo(992.2, 6);
    expect(densityAt(WATER, 100)).toBeCloseTo(958.4, 6);
    const densest = Array.from({ length: 101 }, (_, t) => t).reduce((best, t) => (densityAt(WATER, t) > densityAt(WATER, best) ? t : best), 0);
    expect(densest, 'the temperature water is densest at').toBe(4);
    // Colder than 4 °C water is lighter, and warmer water too: the anomaly.
    expect(densityAt(WATER, 1)).toBeLessThan(densityAt(WATER, 4));
    expect(densityAt(WATER, 10)).toBeLessThan(densityAt(WATER, 4));
  });

  it('M8.8 AC9: interpolates linearly between the knots and stays flat outside them', () => {
    expect(densityAt(WATER, 22)).toBeCloseTo(1000 + (992.2 - 1000) * (18 / 36), 9);
    expect(densityAt(WATER, 70)).toBeCloseTo(992.2 + (958.4 - 992.2) * (30 / 60), 9);
    expect(densityAt(WATER, -200)).toBe(densityAt(WATER, 0));
    expect(densityAt(WATER, 5000)).toBe(densityAt(WATER, 100));
    expect(densityAt(OIL, 20)).toBe(900);
    expect(densityAt(OIL, 135)).toBeCloseTo(837.5, 9);
    expect(densityAt(OIL, 1000)).toBe(775);
  });

  it('M8.8 AC9: scales a gas with the ideal-gas law from its one density, and the air too', () => {
    const k = (celsius: number): number => celsius - ABSOLUTE_ZERO;
    expect(densityAt(STEAM, 100)).toBeCloseTo(0.59, 9);
    expect(densityAt(STEAM, 200)).toBeCloseTo((0.59 * k(100)) / k(200), 9);
    expect(densityAt(EMPTY, ROOM_TEMP)).toBeCloseTo(1.2, 9);
    expect(densityAt(EMPTY, 120)).toBeCloseTo((1.2 * k(20)) / k(120), 9);
    expect(densityAt(EMPTY, -50), 'cold air is denser').toBeGreaterThan(densityAt(EMPTY, 20));
    expect(densityAt(EMPTY, ABSOLUTE_ZERO), 'finite at absolute zero').toBeLessThan(Infinity);
  });

  it('M8.8 AC9: keeps one density for powders and solids at every temperature', () => {
    for (const row of ELEMENTS.filter((e) => e.state === 'powder' || e.state === 'solid')) {
      expect(densityAt(row, -100), row.key).toBe(row.density);
      expect(densityAt(row, 2000), row.key).toBe(row.density);
    }
    expect(densityAt(SAND, 20)).toBe(1600);
  });

  it('M8.8 AC9: gives every liquid a density curve and every gas an ideal-gas reference', () => {
    for (const row of ELEMENTS.filter((e) => e.state === 'liquid')) {
      expect(row.densityKnots, `${row.key} knots`).toBeDefined();
      const knots = row.densityKnots;
      expect(knots.length, `${row.key} knots`).toBeLessThanOrEqual(DENSITY_KNOTS);
      const densest = Math.max(...knots.map(([, d]) => d));
      expect(row.density, `${row.key}'s density lies in its knots`).toBeLessThanOrEqual(densest);
      expect(knots[knots.length - 1][1], `${row.key} is not denser hot than at its densest`).toBeLessThanOrEqual(densest);
    }
    for (const row of ELEMENTS.filter((e) => e.state === 'gas')) {
      expect(densityAt(row, 500), `${row.key} is lighter when hot`).toBeLessThan(densityAt(row, 0));
    }
  });

  it('M8.8 AC9: packs the curve for the GPU, unused knots repeating the last one a degree further on', () => {
    expect(densityProfile(OIL)).toEqual({ temps: [20, 250, 251, 252], densities: [900, 775, 775, 775] });
    expect(densityProfile(WATER).temps).toEqual([0, 4, 40, 100]);
    expect(densityProfile(STEAM)).toEqual({ temps: [100, 101, 102, 103], densities: [0.59, 0.59, 0.59, 0.59] });
    const words = new Uint32Array(packElements(ELEMENTS));
    const floats = new Float32Array(words.buffer);
    const at = (id: number, field: string): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field);
    expect(words[at(T.WATER, 'densityMode')]).toBe(1);
    expect(words[at(T.STEAM, 'densityMode')]).toBe(2);
    expect(words[at(T.EMPTY, 'densityMode')]).toBe(2);
    expect(words[at(T.SAND, 'densityMode')]).toBe(0);
    expect(floats[at(T.WATER, 'densityKnot1')]).toBe(1000);
    expect(floats[at(T.WATER, 'densityTemp2')]).toBe(40);
    expect(PROP_FIELDS.length % 4, 'a uniform array stride').toBe(0);
  });

  // A row of its own key and ID, so that the error names it and its transitions point at nothing.
  const own = (base: ElementDef, change: Partial<ElementDef>): ElementDef => ({ ...base, key: 'X', id: 230, toolbar: undefined, below: undefined, above: undefined, ...change });
  it.each([
    ['knots on a powder', own(SAND, { densityKnots: [[0, 1600]] }), /X: densityKnots is only for a liquid/],
    ['no knots', own(WATER, { densityKnots: [] }), /X: densityKnots needs 1 to 4 points/],
    ['five knots', own(WATER, { densityKnots: [[0, 999], [1, 1000], [2, 999], [3, 998], [4, 997]] }), /X: densityKnots needs 1 to 4 points/],
    ['knots that do not increase', own(WATER, { densityKnots: [[4, 1000], [4, 999]] }), /X: densityKnots must increase in temperature/],
    ['a density of 0 in a knot', own(WATER, { densityKnots: [[0, 0], [4, 1000]] }), /X: densityKnots\[0\] density must be a finite number above 0/],
    ['a nominal density outside the knots', own(WATER, { density: 1200 }), /X: density 1200 must lie within its densityKnots/],
    ['a reference temperature on a liquid', own(WATER, { densityTemp: 20 }), /X: densityTemp is only for a gas or empty space/],
    ['a gas with no density', own(STEAM, { density: 0 }), /X: the density of a gas must be above 0/],
    ['a gas referenced at absolute zero', own(STEAM, { densityTemp: ABSOLUTE_ZERO }), /X: densityTemp must be a number/],
  ])('M8.8 AC9: rejects %s', (_name, row, message) => {
    expect(() => validateElements([...ELEMENTS, row])).toThrow(message);
  });
});

describe('M8.8 AC10: the swap chance of convection', () => {
  it('M8.8 AC10: is 0 without a difference or with the denser cell below, and grows with the square root of the difference', () => {
    expect(convectionChance(1000, 1000)).toBe(0);
    expect(convectionChance(990, 1000)).toBe(0);
    expect(convectionChance(1001, 1000)).toBeCloseTo(CONVECTION_GAIN * Math.sqrt(0.001), 12);
    expect(convectionChance(1004, 1000) / convectionChance(1001, 1000)).toBeCloseTo(2, 9);
    expect(convectionChance(2000, 1000), 'a large difference swaps at once').toBe(1);
  });
});

// A plate that keeps its temperature: it conducts like steel and holds 240 times the heat of water per cell, so the water
// beside it does not move it by more than a fraction of a degree in the time a test runs.
const HOLD_ID = 220;
const HOLD: ElementDef = { key: 'HOLD', id: HOLD_ID, label: 'Held', color: [0.5, 0.5, 0.5], state: 'solid', density: 3000, conductivity: 50, heatCapacity: 1000, toolbar: 70 };
// Water with one density at every temperature: the same tank without convection.
const FLAT_ID = 221;
const FLAT_WATER: ElementDef = { ...WATER, key: 'FLAT_WATER', id: FLAT_ID, label: 'Flat water', toolbar: 71, densityKnots: undefined };
const TABLE = [...ELEMENTS, HOLD, FLAT_WATER];

const WIDTH = 18;

interface Tank {
  depth: number;
  /** The liquid's element and its starting temperature. */
  liquid: number;
  temp: number;
  /** A held plate under the liquid (else a wall) or over it (else a wall), at this temperature. */
  floor?: number;
  ceiling?: number;
}

interface Layout {
  kind: Uint32Array<ArrayBuffer>;
  temp: Uint32Array<ArrayBuffer>;
  height: number;
  /** The liquid fills rows y0 to y1 - 1; y = 0 is the bottom row. */
  y0: number;
  y1: number;
}

// Walls on the sides, a two-row plate or wall under and over the liquid, the liquid in between.
function tank(t: Tank): Layout {
  const plate = 2;
  const y0 = plate;
  const y1 = y0 + t.depth;
  const height = y1 + plate;
  const kind = new Uint32Array(WIDTH * height);
  const data = { temp: new Uint32Array(WIDTH * height) };
  const temps = tempView(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      const side = x === 0 || x === WIDTH - 1;
      if (y < y0) {
        kind[i] = cell(side || t.floor === undefined ? T.WALL : HOLD_ID);
        temps[i] = t.floor ?? 0;
      } else if (y >= y1) {
        kind[i] = cell(side || t.ceiling === undefined ? T.WALL : HOLD_ID);
        temps[i] = t.ceiling ?? 0;
      } else {
        kind[i] = cell(side ? T.WALL : t.liquid);
        temps[i] = t.temp;
      }
    }
  }
  return { kind, temp: data.temp, height, y0, y1 };
}

function tankSim(layout: Layout, seed = 3): Simulation {
  const sim = createSim(WIDTH, layout.height, seed, { ...NO_AIR, elements: TABLE });
  sim.load({ kind: layout.kind, temp: layout.temp });
  return sim;
}

// The mean stored temperature of the liquid cells of each row y0..y1-1 (the walls at the sides left out).
async function rowMeans(sim: Simulation, layout: Layout): Promise<number[]> {
  const temps = tempView({ temp: await sim.fields.read('temp') });
  const means: number[] = [];
  for (let y = layout.y0; y < layout.y1; y++) {
    let sum = 0;
    for (let x = 1; x < WIDTH - 1; x++) sum += temps[y * WIDTH + x];
    means.push(sum / (WIDTH - 2));
  }
  return means;
}

describe.skipIf(!device)('M8.8 AC10: a tank of water heated from below', () => {
  const PLATE = 90;
  const START = 20;
  // Half the plate's rise.
  const HALF = START + (PLATE - START) / 2;
  const SAMPLE = 250;

  // Supersteps until the mean of the top row of liquid reaches `HALF`, sampled every SAMPLE; null past `limit`.
  async function topReaches(liquid: number, depth: number, limit: number): Promise<number | null> {
    const layout = tank({ depth, liquid, temp: START, floor: PLATE });
    const sim = tankSim(layout);
    for (let done = SAMPLE; done <= limit; done += SAMPLE) {
      await runMany(sim, SAMPLE);
      const means = await rowMeans(sim, layout);
      if (means[depth - 1] >= HALF) return done;
    }
    return null;
  }

  it('M8.8 AC10: brings its top layer to half the plate rise at least 10 times sooner than the same tank with flat density', async () => {
    const depth = 12;
    const convecting = await topReaches(T.WATER, depth, 60_000);
    expect(convecting, 'supersteps until the top row of the convecting tank is half way to the plate').not.toBeNull();
    // The flat tank, given ten times as long, has not got there.
    const flat = await topReaches(FLAT_ID, depth, convecting! * 10);
    expect(flat, `the flat tank took longer than ${convecting! * 10} supersteps`).toBeNull();
  }, 300_000);

  it('M8.8 AC10: lifts its hot cells at a speed within a factor of 3 of the free-convection estimate', async () => {
    const depth = 32;
    const layout = tank({ depth, liquid: T.WATER, temp: START });
    // A block of cells at the plate's temperature in the middle of the floor of the tank.
    const temps = tempView({ temp: layout.temp });
    for (let y = 0; y < 4; y++) for (let x = 7; x < 11; x++) temps[(layout.y0 + y) * WIDTH + x] = PLATE;
    const sim = tankSim(layout);

    // The mean height, in rows above the floor of the liquid, of the cells hotter than the middle of the two temperatures.
    const centroid = async (): Promise<number> => {
      const read = tempView({ temp: await sim.fields.read('temp') });
      let sum = 0;
      let n = 0;
      for (let y = layout.y0; y < layout.y1; y++) {
        for (let x = 1; x < WIDTH - 1; x++) {
          if (read[y * WIDTH + x] > HALF) {
            sum += y - layout.y0;
            n++;
          }
        }
      }
      return n === 0 ? Number.NaN : sum / n;
    };
    const lower = depth / 4;
    const upper = (3 * depth) / 4;
    let atLower: number | undefined;
    let atUpper: number | undefined;
    for (let step = 1; step <= 150 && atUpper === undefined; step++) {
      await runMany(sim, 4);
      const height = await centroid();
      if (atLower === undefined && height >= lower) atLower = step * 4;
      if (atLower !== undefined && height >= upper) atUpper = step * 4;
    }
    expect(atUpper, 'the hot block never reached three quarters of the way up').toBeDefined();
    // Cells per dispatch: a superstep is two dispatches.
    const measured = (upper - lower) / ((atUpper! - atLower!) * 2);

    // sqrt(g beta dT L): beta from the water's own curve between the two temperatures, L the height of the tank.
    const beta = (densityAt(WATER, START) - densityAt(WATER, PLATE)) / (densityAt(WATER, START) * (PLATE - START));
    const estimate = (Math.sqrt(G * beta * (PLATE - START) * depth * CELL_SIZE) * DISPATCH_TIME) / CELL_SIZE;
    const note = `rose ${measured.toFixed(3)} cells per dispatch against an estimate of ${estimate.toFixed(3)}`;
    expect(measured / estimate, note).toBeGreaterThan(1 / 3);
    expect(measured / estimate, note).toBeLessThan(3);
  }, 120_000);
});

describe.skipIf(!device)('M8.8 AC11: a pond under a freezing ceiling', () => {
  const DEPTH = 16;
  const SAMPLE = 250;

  interface Pond {
    /** The coldest cell of the bottom row at each sample. */
    bottom: number[];
    /** The first sample with ice: its cells, and how many of them lie in the top quarter of the liquid. */
    firstIce: { count: number; inTopQuarter: number } | null;
    /** Supersteps until the top row was all ice. */
    frozenAt: number | null;
  }

  async function pond(liquid: number, limit: number): Promise<Pond> {
    const layout = tank({ depth: DEPTH, liquid, temp: 10, ceiling: -20 });
    const sim = tankSim(layout);
    const result: Pond = { bottom: [], firstIce: null, frozenAt: null };
    for (let done = SAMPLE; done <= limit && result.frozenAt === null; done += SAMPLE) {
      await runMany(sim, SAMPLE);
      const kinds = await readCells(sim);
      const temps = tempView({ temp: await sim.fields.read('temp') });
      let ice = 0;
      let inTopQuarter = 0;
      let topRow = 0;
      for (let y = layout.y0; y < layout.y1; y++) {
        for (let x = 1; x < WIDTH - 1; x++) {
          if (cellType(kinds[y * WIDTH + x]) !== T.ICE) continue;
          ice++;
          if (y >= layout.y1 - DEPTH / 4) inTopQuarter++;
          if (y === layout.y1 - 1) topRow++;
        }
      }
      let coldest = Infinity;
      for (let x = 1; x < WIDTH - 1; x++) coldest = Math.min(coldest, temps[layout.y0 * WIDTH + x]);
      result.bottom.push(coldest);
      if (ice > 0 && result.firstIce === null) result.firstIce = { count: ice, inTopQuarter };
      if (topRow === WIDTH - 2) result.frozenAt = done;
    }
    return result;
  }

  it('M8.8 AC11: freezes first in the top quarter and keeps the bottom water at 3.5 °C or more until the top row has frozen over', async () => {
    const r = await pond(T.WATER, 60_000);
    expect(r.frozenAt, 'supersteps until the top row has frozen over').not.toBeNull();
    expect(r.firstIce, 'the first ice').not.toBeNull();
    expect(r.firstIce!.inTopQuarter, 'cells of the first ice that lie in the top quarter').toBe(r.firstIce!.count);
    expect(Math.min(...r.bottom), 'coldest bottom cell at any sample before the top row froze').toBeGreaterThanOrEqual(3.5);
    // The pond has been stirred down to its densest temperature, 4 °C, by then.
    expect(r.bottom[r.bottom.length - 1], 'bottom water when the top row froze').toBeLessThan(4.5);
  }, 120_000);

  it('M8.8 AC11: the same pond with flat density keeps its bottom water where it started', async () => {
    const r = await pond(FLAT_ID, 60_000);
    expect(r.frozenAt).not.toBeNull();
    expect(r.bottom[r.bottom.length - 1], 'bottom water of the pond without convection').toBeGreaterThan(9.5);
  }, 120_000);
});

describe.skipIf(!device)('M8.8 AC12: a body of one liquid at one temperature stays still', () => {
  // The liquid with empty space over it, so that it could move if anything moved it.
  function pool(liquid: number, temp: number): Layout {
    const layout = tank({ depth: 10, liquid, temp });
    const height = layout.height + 6;
    const kind = new Uint32Array(WIDTH * height);
    kind.set(layout.kind.subarray(0, WIDTH * layout.y1));
    for (let y = layout.y1; y < height; y++) for (const x of [0, WIDTH - 1]) kind[y * WIDTH + x] = cell(T.WALL);
    const data = { temp: new Uint32Array(WIDTH * height) };
    tempView(data).fill(temp);
    return { kind, temp: data.temp, height, y0: layout.y0, y1: layout.y1 };
  }

  function poolSim(layout: Layout): Simulation {
    const sim = createSim(WIDTH, layout.height, 5, { ...NO_AIR, elements: TABLE });
    sim.load({ kind: layout.kind, temp: layout.temp });
    return sim;
  }

  it.each([
    ['water', T.WATER, 20],
    ['water at its densest', T.WATER, 4],
    ['hot water', T.WATER, 95],
    ['water just above freezing', T.WATER, 0.5],
    ['oil', T.OIL, 100],
  ])('M8.8 AC12: moves no cell of %s by density', async (_name, liquid, temp) => {
    const sim = poolSim(pool(liquid, temp));
    const before = await readCells(sim);
    await runMany(sim, 2000);
    expect(await readCells(sim)).toEqual(before);
  });

  it('M8.8 AC12: leaves hot water over cold where it is', async () => {
    // Stably stratified: a hot upper half over a cold lower half. Nothing may swap, so the profile stays ordered.
    const layout = pool(T.WATER, 20);
    const temps = tempView({ temp: layout.temp });
    for (let y = layout.y0 + 5; y < layout.y1; y++) for (let x = 0; x < WIDTH; x++) temps[y * WIDTH + x] = 60;
    const sim = poolSim(layout);
    await runMany(sim, 3000);
    const means = await rowMeans(sim, layout);
    for (let y = 1; y < means.length; y++) expect(means[y], `row ${y} is not colder than row ${y - 1}`).toBeGreaterThanOrEqual(means[y - 1] - 1e-4);
  });

  it('M8.8 AC12: turns hot water under cold water over, the hot water ending on top', async () => {
    const layout = pool(T.WATER, 20);
    const temps = tempView({ temp: layout.temp });
    for (let y = layout.y0; y < layout.y0 + 5; y++) for (let x = 0; x < WIDTH; x++) temps[y * WIDTH + x] = 80;
    const sim = poolSim(layout);
    await runMany(sim, 800);
    const means = await rowMeans(sim, layout);
    const lowerHalf = means.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const upperHalf = means.slice(5).reduce((a, b) => a + b, 0) / 5;
    expect(upperHalf, 'the hot water now lies over the cold').toBeGreaterThan(lowerHalf);
    expect(means[0], 'the floor row is no longer at its starting temperature').toBeLessThan(80);
  });
});
