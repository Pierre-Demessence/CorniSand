import { describe, expect, it } from 'vitest';
import { PROP_FIELDS, packElements } from '../src/element-table';
import { ELEMENT as T, ELEMENTS, elementByKey, elementSpread, validateElements, type ElementDef } from '../src/elements';
import { CELL_SIZE, DISPATCH_TIME, G, REF_DEPTH, spreadSpeed } from '../src/physics';
import { SCENES } from '../src/scenes';
import { cell, cellType, createSim, device, loadScene, readCells, runMany } from './gpu';

const WATER: ElementDef = elementByKey(ELEMENTS, 'WATER');
const OIL: ElementDef = elementByKey(ELEMENTS, 'OIL');
const LAVA: ElementDef = elementByKey(ELEMENTS, 'LAVA');
const MOLTEN_METAL: ElementDef = elementByKey(ELEMENTS, 'MOLTEN_METAL');

const ROWS: readonly ElementDef[] = ELEMENTS;
const SPREAD_OF = (e: ElementDef): number => elementSpread(e);

describe('M8.8 AC14: viscosity', () => {
  it('M8.8 AC14: gives every liquid row a viscosity from data', () => {
    for (const row of ROWS.filter((e) => e.state === 'liquid')) {
      expect(row.viscosity, `${row.key} viscosity`).toBeGreaterThan(0);
    }
    for (const row of ROWS.filter((e) => e.state !== 'liquid')) {
      expect(row.viscosity, `${row.key} is not a liquid`).toBeUndefined();
    }
    // Pa·s at about 20 °C (lava: at its eruption temperature): water 1.0 mPa·s, motor oil 0.1 to 0.3, basalt 10 to 100.
    expect(WATER.viscosity).toBeCloseTo(0.001, 9);
    expect(OIL.viscosity).toBeGreaterThanOrEqual(0.1);
    expect(OIL.viscosity).toBeLessThanOrEqual(0.3);
    expect(LAVA.viscosity).toBeGreaterThanOrEqual(10);
    expect(LAVA.viscosity).toBeLessThanOrEqual(100);
  });

  it('M8.8 AC14: spreads as a viscous layer REF_DEPTH cells deep, capped at one cell per dispatch', () => {
    // rho g h^2 / (3 mu) in m/s, as cells per dispatch, worked out by hand for lava: 2,700 kg/m³, 30 Pa·s.
    const h = REF_DEPTH * CELL_SIZE;
    const metersPerSecond = (2700 * G * h * h) / (3 * 30);
    expect(spreadSpeed(2700, 30)).toBeCloseTo((metersPerSecond * DISPATCH_TIME) / CELL_SIZE, 12);
    expect(spreadSpeed(2700, 60), 'twice the viscosity, half the speed').toBeCloseTo(spreadSpeed(2700, 30) / 2, 12);
    expect(spreadSpeed(1800, 30), 'half the density, half the speed').toBeCloseTo(spreadSpeed(2700, 30) * (2 / 3), 12);
    expect(SPREAD_OF(WATER), 'water is at the cap').toBe(1);
    expect(SPREAD_OF(MOLTEN_METAL), 'liquid iron is at the cap').toBe(1);
    expect(SPREAD_OF(OIL)).toBeLessThan(1);
    expect(SPREAD_OF(OIL)).toBeGreaterThan(0.3);
    expect(SPREAD_OF(LAVA)).toBeLessThan(0.05);
    expect(SPREAD_OF(LAVA)).toBeGreaterThan(0.005);
    expect(SPREAD_OF({ ...WATER, viscosity: undefined }), 'no viscosity, no resistance').toBe(1);
  });

  it('M8.8 AC14: packs the spreading chance of each row for the GPU', () => {
    const floats = new Float32Array(packElements(ELEMENTS));
    const at = (id: number): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === 'spread');
    expect(floats[at(T.WATER)]).toBe(1);
    expect(floats[at(T.OIL)]).toBe(Math.fround(SPREAD_OF(OIL)));
    expect(floats[at(T.LAVA)]).toBe(Math.fround(SPREAD_OF(LAVA)));
    expect(floats[at(T.SAND)], 'rows that are not liquids spread at 1 (unused)').toBe(1);
  });

  it.each<[string, Partial<ElementDef>, RegExp]>([
    ['a viscosity on a powder', { state: 'powder', viscosity: 1 }, /MUD: viscosity is only for a liquid/],
    ['a viscosity on a gas', { state: 'gas', viscosity: 1 }, /MUD: viscosity is only for a liquid/],
    ['a viscosity of 0', { state: 'liquid', viscosity: 0 }, /MUD: viscosity must be a finite number above 0/],
    ['a negative viscosity', { state: 'liquid', viscosity: -1 }, /MUD: viscosity must be a finite number above 0/],
    ['a viscosity that is not a number', { state: 'liquid', viscosity: NaN }, /MUD: viscosity must be a finite number above 0/],
    ['an infinite viscosity', { state: 'liquid', viscosity: Infinity }, /MUD: viscosity must be a finite number above 0/],
  ])('M8.8 AC14: rejects %s', (_name, change, message) => {
    const mud: ElementDef = { key: 'MUD', id: 200, label: 'Mud', color: [0.4, 0.3, 0.2], state: 'liquid', density: 1300, ...change };
    expect(() => validateElements([...ELEMENTS, mud])).toThrow(message);
  });
});

// A 30x40 column of a liquid against the left wall of a 200x60 tank, run without air so only the spreading is measured:
// the rightmost cell of the liquid after the given supersteps, minus where the column ended.
describe.skipIf(!device)('M8.8 AC14: dam-break fronts', () => {
  async function frontSpeed(liquid: number, from: number, to: number): Promise<number> {
    const scene = SCENES.damBreak();
    const sim = createSim(scene.width, scene.height, 1, { air: false });
    loadScene(sim, scene.fields.kind.map((c) => (cellType(c) === T.WATER ? cell(liquid) : c)));
    const front = async (): Promise<number> => {
      const kinds = await readCells(sim);
      let x = 0;
      for (let k = 0; k < kinds.length; k++) if (cellType(kinds[k]) === liquid) x = Math.max(x, k % scene.width);
      return x;
    };
    await runMany(sim, from);
    const start = await front();
    await runMany(sim, to - from);
    const end = await front();
    // Cells per dispatch: two dispatches in a superstep.
    return (end - start) / (2 * (to - from));
  }

  // Measured with the washing wall away from the front: water 0.97 cells per dispatch (the cap, 1), oil 0.44 (the layer
  // speed is 0.67), lava 0.0076 over supersteps 640 to 2,560 (0.013). The thin edge of a flow runs below the speed of a
  // layer REF_DEPTH deep: a cell turns around now and then, and the column behind it thins as the front runs.
  it('M8.8 AC14: water runs at the cap, oil slower, lava within a factor of 3 of its layer speed and slower than oil', async () => {
    const water = await frontSpeed(T.WATER, 10, 40);
    const oil = await frontSpeed(T.OIL, 20, 100);
    const lava = await frontSpeed(T.LAVA, 640, 2560);
    expect(water, 'water front, cells per dispatch').toBeGreaterThan(0.8);
    expect(water).toBeLessThanOrEqual(1);
    expect(oil, 'oil front is slower than water').toBeLessThan(water * 0.8);
    expect(oil, 'oil front is faster than lava').toBeGreaterThan(lava * 10);
    const predicted = spreadSpeed(LAVA.density, LAVA.viscosity!);
    expect(lava, 'lava front, cells per dispatch').toBeGreaterThan(predicted / 3);
    expect(lava, 'lava front, cells per dispatch').toBeLessThan(predicted * 3);
  }, 120_000);
});
