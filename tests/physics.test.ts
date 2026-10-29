import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, type ElementDef } from '../src/elements';
import { ABSOLUTE_ZERO, CONDUCTION, HEAT_TOOL_RATE, effectiveTemp, heatShare } from '../src/heat';
import { CELL_SIZE, DEFAULT_GRAVITY, DISPATCH_TIME, DISPATCHES_PER_SECOND, G, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import type { Simulation } from '../src/simulation';
import { formatProbe } from '../src/readout';
import { SEALED_BARS, sealedBars, type SealedBarsMaterial } from '../src/scenarios';
import { TOOLS } from '../src/toolbar';
import { cell, createSim, device, idleInput, readCells, run, runMany } from './gpu';
import { control, scenario } from './scenario';

const NO_AIR = { air: false };

describe('M8.8 AC1: the physical scale', () => {
  it('M8.8 AC1: derives the cell size and the dispatch time from the gravity and 480 dispatches per second', () => {
    expect(DISPATCHES_PER_SECOND).toBe(480);
    expect(DISPATCH_TIME * 1000, 'ms per dispatch').toBeCloseTo(2.08, 1);
    expect(Math.abs(DISPATCH_TIME * 1000 / 2.08 - 1), 'dispatch time within 1% of 2.08 ms').toBeLessThan(0.01);
    expect(Math.abs(CELL_SIZE * 1000 / 1.36 - 1), 'cell size within 1% of 1.36 mm').toBeLessThan(0.01);
    // The pair for which the default gravity of cells per dispatch² is the real one.
    expect((DEFAULT_GRAVITY * CELL_SIZE) / DISPATCH_TIME ** 2, 'm/s²').toBeCloseTo(G, 9);
    expect(PAIR_TIME, 'a pair exchanges once per superstep').toBe(2 * DISPATCH_TIME);
  });
});

describe('M8.8 AC2: the share of a pair', () => {
  const metal = elementByKey(ELEMENTS, 'METAL');
  const stone = elementByKey(ELEMENTS, 'STONE');
  const water = elementByKey(ELEMENTS, 'WATER');
  const share = (a: ElementDef, b: ElementDef): number => heatShare(elementConductivity(a), elementHeatCapacity(a), elementConductivity(b), elementHeatCapacity(b));

  it('M8.8 AC2: is the heat equation for a pair of cells, with the harmonic mean of the conductivities', () => {
    // PAIR_TIME / CELL_SIZE² × k × (1/Ca + 1/Cb), the capacities in J/m³·K.
    const expected = (ka: number, ca: number, kb: number, cb: number): number =>
      (PAIR_TIME / CELL_SIZE ** 2) * ((2 * ka * kb) / (ka + kb)) * (1 / (ca * HEAT_UNIT) + 1 / (cb * HEAT_UNIT));
    expect(share(metal, metal)).toBeCloseTo(expected(50, 3.5, 50, 3.5), 12);
    expect(share(metal, stone)).toBeCloseTo(expected(50, 3.5, 2.5, 2.2), 12);
    expect(share(stone, metal), 'symmetric').toBe(share(metal, stone));
    // The numbers the plan quotes: about 0.064 for steel, 0.0051 for stone, 0.00065 for water.
    expect(share(metal, metal)).toBeCloseTo(0.0644, 3);
    expect(share(stone, stone)).toBeCloseTo(0.00512, 4);
    expect(share(water, water)).toBeCloseTo(0.000647, 5);
    expect(CONDUCTION * 1e6, 'per W/m·K and per 1/(J/m³·K)').toBeCloseTo(PAIR_TIME / CELL_SIZE ** 2, 6);
  });

  it('M8.8 AC2: is 0 when either cell conducts nothing, and never above 1', () => {
    expect(heatShare(0, 3.5, 50, 3.5)).toBe(0);
    expect(heatShare(50, 3.5, 0, 3.5)).toBe(0);
    expect(heatShare(0, 1, 0, 1)).toBe(0);
    expect(heatShare(2000, 3.5, 2000, 3.5), 'a 2,000 W/m·K pair').toBe(1);
    expect(heatShare(2000, 3.5, 2000, 0.001)).toBe(1);
  });
});

describe('M8.8 AC4: the rows come from physical data', () => {
  // Ranges the cited data falls in: W/m·K and MJ/m³·K.
  const data: Record<string, { k: [number, number]; c: [number, number] }> = {
    SAND: { k: [0.2, 0.4], c: [1.1, 1.6] },
    WATER: { k: [0.55, 0.65], c: [4.1, 4.25] },
    OIL: { k: [0.1, 0.18], c: [1.4, 1.9] },
    METAL: { k: [40, 80], c: [3.3, 4] },
    STONE: { k: [2, 3.5], c: [2, 2.6] },
    ICE: { k: [2, 2.4], c: [1.7, 2] },
    STEAM: { k: [35, 50], c: [1.9, 2.1] },
    LAVA: { k: [0.5, 2], c: [3, 4.5] },
    MOLTEN_METAL: { k: [25, 45], c: [5, 6.5] },
    GUNPOWDER: { k: [0.1, 0.3], c: [1, 2] },
  };

  it.each(Object.entries(data))('M8.8 AC4: %s takes its conductivity and heat capacity from data', (key, range) => {
    const row = elementByKey(ELEMENTS, key);
    expect(elementConductivity(row), 'W/m·K').toBeGreaterThanOrEqual(range.k[0]);
    expect(elementConductivity(row), 'W/m·K').toBeLessThanOrEqual(range.k[1]);
    expect(elementHeatCapacity(row), 'MJ/m³·K').toBeGreaterThanOrEqual(range.c[0]);
    expect(elementHeatCapacity(row), 'MJ/m³·K').toBeLessThanOrEqual(range.c[1]);
  });

  it('M8.8 AC4: steel conducts heat about eight times slower than copper would (50 against 400 W/m·K)', () => {
    expect(400 / elementConductivity(elementByKey(ELEMENTS, 'METAL'))).toBeCloseTo(8, 0);
  });
});

describe('M8.8 AC5: latent heats', () => {
  const latent = (key: string, side: 'above' | 'below'): number => elementByKey(ELEMENTS, key)[side]!.latent!;

  it('M8.8 AC5: are per-kilogram data times the density of the denser phase, in MJ/m³', () => {
    // 334 kJ/kg × 1,000 kg/m³ to freeze or melt water, 2,257 kJ/kg to boil it.
    expect(latent('ICE', 'above')).toBe(334);
    expect(latent('WATER', 'below')).toBe(334);
    expect(latent('WATER', 'above')).toBe(2257);
    expect(latent('STEAM', 'below')).toBe(2257);
    // Iron: 247 kJ/kg × 7,870 kg/m³.
    expect(latent('METAL', 'above')).toBeCloseTo(247 * 7.87, -1);
    expect(latent('MOLTEN_METAL', 'below')).toBe(latent('METAL', 'above'));
    // Basalt: about 450 kJ/kg × 2,700 kg/m³.
    expect(latent('LAVA', 'below')).toBeCloseTo(450 * 2.7, -2);
    expect(latent('STONE', 'above')).toBe(latent('LAVA', 'below'));
  });

  it('M8.8 AC5: leave steam condensing about 1,130 °C under its threshold, and the temperature it shows inside the range', () => {
    const steam = elementByKey(ELEMENTS, 'STEAM');
    const stored = steam.below!.temp - latent('STEAM', 'below') / elementHeatCapacity(steam);
    expect(stored).toBeLessThan(-1000);
    expect(effectiveTemp(steam, stored)).toBe(100);
  });
});

// Two rows that conduct 2,000 W/m·K, so that a pair is capped: the share is 1.
const FAST_A: ElementDef = { key: 'FAST_A', id: 210, label: 'Fast A', color: [1, 0, 0], state: 'solid', density: 3000, conductivity: 2000, heatCapacity: 3.5 };
const FAST_B: ElementDef = { ...FAST_A, key: 'FAST_B', id: 211, label: 'Fast B', heatCapacity: 1 };
const WITH_FAST = [...ELEMENTS, FAST_A, FAST_B];

function uniformTemps(count: number, temp: number): Uint32Array<ArrayBuffer> {
  const data = { temp: new Uint32Array(count) };
  tempView(data).fill(temp);
  return data.temp;
}

async function readTemps(sim: Simulation): Promise<Float32Array> {
  return tempView({ temp: await sim.fields.read('temp') });
}

describe.skipIf(!device)('M8.8 AC2: a single pair on the GPU', () => {
  // Two cells in a row: at offset 0 they are one pair, at offset 1 each is alone with the world's edge, so one
  // superstep is exactly one exchange.
  async function exchange(a: { type: number; temp: number }, b: { type: number; temp: number }): Promise<[number, number]> {
    const sim = createSim(2, 1, 1, { ...NO_AIR, elements: WITH_FAST });
    const temp = uniformTemps(2, 0);
    const temps = tempView({ temp });
    temps[0] = a.temp;
    temps[1] = b.temp;
    sim.load({ kind: new Uint32Array([cell(a.type), cell(b.type)]), temp });
    await runMany(sim, 1);
    const after = await readTemps(sim);
    return [after[0], after[1]];
  }

  it.each(['METAL', 'STONE', 'WATER'])('M8.8 AC2: two %s cells move toward each other by the share of their difference', async (key) => {
    const row = elementByKey(ELEMENTS, key);
    const s = heatShare(elementConductivity(row), elementHeatCapacity(row), elementConductivity(row), elementHeatCapacity(row));
    const [hot, cold] = await exchange({ type: row.id, temp: 80 }, { type: row.id, temp: 20 });
    // Equal capacities: each moves the share of the way to the mean, 40 °C away from each.
    expect(hot, 'hot cell').toBeCloseTo(80 - s * 30, 3);
    expect(cold, 'cold cell').toBeCloseTo(20 + s * 30, 3);
  });

  it('M8.8 AC2: a 2,000 W/m·K pair is capped at the capacity-weighted mean and never passes it', async () => {
    const [a, b] = await exchange({ type: FAST_A.id, temp: 500 }, { type: FAST_B.id, temp: 20 });
    const mean = (3.5 * 500 + 1 * 20) / 4.5;
    expect(a, 'FAST_A').toBeCloseTo(mean, 3);
    expect(b, 'FAST_B').toBeCloseTo(mean, 3);
    // Equal capacities: the cells swap sides of the mean only if the share passed 1.
    const [x, y] = await exchange({ type: FAST_A.id, temp: 500 }, { type: FAST_A.id, temp: 20 });
    expect(x, 'hot').toBeCloseTo(260, 3);
    expect(y, 'cold').toBeCloseTo(260, 3);
    expect(x).toBeGreaterThanOrEqual(y);
  });
});

describe.skipIf(!device)('sealedBars: a sealed bar relaxes at the speed of its material', () => {
  // A one-cell-high bar of `cells` cells, the left half at `hot` and the right half at `cold`, with nothing around it that
  // holds heat. The difference between its halves decays as exp(-t / tau) with tau = L² / (pi² alpha), alpha = k / C
  // (a bar's lowest conduction mode; Carslaw and Jaeger, Conduction of Heat in Solids). The measure is the time constant the
  // simulation gives over the one the row's own data give, so 1 is real; the table the bar is simulated in may differ from
  // `ELEMENTS` (the control), the expected time constant always comes from the real row.
  async function timeConstantRatio(material: SealedBarsMaterial, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const row = elementByKey(ELEMENTS, material);
    const { cells } = SEALED_BARS[material];
    const alpha = (elementConductivity(row) / (elementHeatCapacity(row) * HEAT_UNIT));
    const expected = (cells * CELL_SIZE) ** 2 / (Math.PI ** 2 * alpha);
    const scene = sealedBars(material);
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR, elements });
    sim.load(scene.fields);

    const difference = async (): Promise<number> => {
      const t = await readTemps(sim);
      let left = 0;
      let right = 0;
      for (let x = 0; x < cells / 2; x++) {
        left += t[x];
        right += t[cells - 1 - x];
      }
      return (left - right) / (cells / 2);
    };
    // Two samples of the decay after the first transient, half and one and a half time constants in.
    const supersteps = (seconds: number): number => Math.round(seconds / PAIR_TIME);
    await runMany(sim, supersteps(0.5 * expected));
    const first = await difference();
    await runMany(sim, supersteps(expected));
    const second = await difference();
    // The samples are one real time constant apart, so the decay between them is exp(-expected / measured).
    return 1 / Math.log(first / second);
  }

  // Within 15% of the time constant the row's data give.
  const TARGET = [0.85, 1.15] as const;
  for (const material of Object.keys(SEALED_BARS) as SealedBarsMaterial[]) {
    scenario({
      name: 'sealedBars',
      version: `${material}, ${SEALED_BARS[material].cells} cells`,
      measure: async () => ({ ratio: await timeConstantRatio(material) }),
      checks: [{ value: 'ratio', outcome: 'decays with the time constant L² / (π² α) within 15%', target: TARGET }],
      timeout: 120_000,
    });
  }

  // Steel at half its conductivity relaxes in about twice the time of real steel: it is measured against real steel's.
  control({
    name: 'sealedBars',
    version: 'METAL, 40 cells',
    wrong: 'steel at half its conductivity',
    measure: () => timeConstantRatio('METAL', ELEMENTS.map((e) => (e.key === 'METAL' ? { ...e, conductivity: elementConductivity(e) / 2 } : e))),
    target: TARGET,
    timeout: 120_000,
  });
});

describe.skipIf(!device)('M8.8 AC5: the stored temperature of a cell condensing steam', () => {
  // A steam cell that has given up 1,100 of the 2,257 it needs to condense stores 100 - 550 = -450 °C: under absolute zero
  // as a number, still 100 °C as a temperature.
  const STEAM = elementByKey(ELEMENTS, 'STEAM');
  const STORED = 100 - 1100 / elementHeatCapacity(STEAM);

  function steamSim(): Simulation {
    const sim = createSim(3, 3, 1, NO_AIR);
    // Walled in, so that the gas stays where it is.
    const kind = new Uint32Array(9).fill(cell(T.WALL));
    kind[4] = cell(T.STEAM);
    const temp = uniformTemps(9, 0);
    tempView({ temp })[4] = STORED;
    sim.load({ kind, temp });
    return sim;
  }

  it('M8.8 AC5: keeps the stored temperature past absolute zero without clamping it, and the cell steam', async () => {
    expect(STORED).toBeLessThan(ABSOLUTE_ZERO);
    const sim = steamSim();
    await runMany(sim, 4);
    expect(tempView({ temp: await sim.fields.read('temp') })[4], 'stored temperature').toBe(Math.fround(STORED));
    expect((await readCells(sim))[4] & 0xff, 'still steam').toBe(T.STEAM);
  });

  it('M8.8 AC5: the Cool tool takes it further down the latent range, and the Heat tool back up, without cutting the progress', async () => {
    const sim = steamSim();
    const stroke = { ...idleInput, mouseActive: true, brushSize: 5, mousePos: { x: 1, y: 1 }, prevMousePos: { x: 1, y: 1 } };
    const cool = TOOLS.find((t) => t.heating < 0)!;
    const heat = TOOLS.find((t) => t.heating > 0)!;
    await run(sim, 0, { ...stroke, heating: cool.heating });
    const cooled = tempView({ temp: await sim.fields.read('temp') })[4];
    expect(cooled, 'stored temperature after Cool').toBe(Math.fround(STORED + cool.heating));
    expect(cooled).toBeLessThan(ABSOLUTE_ZERO);
    await run(sim, 0, { ...stroke, heating: heat.heating });
    expect(tempView({ temp: await sim.fields.read('temp') })[4], 'after Heat').toBeCloseTo(STORED, 3);
    expect(HEAT_TOOL_RATE).toBeGreaterThan(0);
  });

  it('M8.8 AC5: shows a temperature inside the range in the pointer readout', async () => {
    const sim = steamSim();
    const encoder = device!.createCommandEncoder();
    expect(sim.probe(encoder, 1.5, 1.5)).toBe(true);
    device!.queue.submit([encoder.finish()]);
    const probe = (await sim.readProbe())!;
    expect(probe.temp, 'stored').toBe(Math.fround(STORED));
    expect(formatProbe(STEAM, probe)).toBe('Steam · 100 °C');
  });
});
