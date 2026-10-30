import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, cellName, elementByKey, elementConductivity, elementHeatCapacity, elementTemperature, validateElements, type ElementDef } from '../src/elements';
import { effectiveTemp } from '../src/heat';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import { CRUCIBLE, INSULATION_WALL, METAL_BARS, crucible, crucibleCup, insulationWall, metalBars, type MetalBarsMaterial } from '../src/scenarios';
import type { Scene } from '../src/scenes';
import { pickerTabs } from '../src/toolbar';
import { cell, createSim, device, mulberry32, readCells, runMany } from './gpu';
import { heatContent } from './metrics';
import { control, scenario, waitsFor } from './scenario';

// The materials of M8.1 and what they do: the rows (this file), then each one's main behavior as a scene test.

const NO_AIR = { air: false };
const ctypeOf = (kind: number): number => (kind >>> 16) & 0xff;
const typeOf = (kind: number): number => kind & 0xff;

// A row of single cells at the given stored temperatures, each beside a wall (which holds no heat), run for `supersteps`.
async function row(cells: { kind: number; temp: number }[], supersteps = 1): Promise<{ kinds: Uint32Array; temps: Float32Array }> {
  const width = cells.length * 2;
  const sim = createSim(width, 1, 1, { elements: ELEMENTS, ...NO_AIR });
  const temp = new Uint32Array(width);
  tempView({ temp }).set(cells.flatMap((c) => [c.temp, 0]));
  sim.load({ kind: new Uint32Array(cells.flatMap((c) => [c.kind, cell(T.WALL)])), temp });
  await runMany(sim, supersteps);
  const kinds = await readCells(sim);
  const temps = tempView({ temp: await sim.fields.read('temp') });
  return { kinds: kinds.filter((_, i) => i % 2 === 0), temps: temps.filter((_, i) => i % 2 === 0) };
}

const row$ = (key: string): ElementDef => elementByKey(ELEMENTS, key);
// The stored temperature a melting cell must pass to melt, and the one a molten cell with ctype k must fall under to set.
const meltsAbove = (e: ElementDef): number => e.above!.temp + (e.above!.latent ?? 0) / elementHeatCapacity(e);
const setsBelow = (k: ElementDef): number => k.above!.temp - (k.above!.latent ?? 0) / elementHeatCapacity(row$('LAVA'));

describe('M8.1e rows', () => {
  it('is a valid table, and basalt is named and crushed as the plan says', () => {
    expect(() => validateElements(ELEMENTS)).not.toThrow();
    expect(row$('STONE').label).toBe('Basalt');
    expect(cellName(ELEMENTS, T.LAVA, T.STONE), 'melted basalt').toBe('Lava');
    expect(row$('STONE').pressureAbove?.becomes).toBe('GRAVEL');
    expect(row$('BRICK').pressureAbove?.becomes).toBe('GRAVEL');
    expect(row$('GLASS').pressureAbove?.becomes).toBe('BROKEN_GLASS');
    expect(row$('ICE').pressureAbove?.becomes).toBe('SNOW');
  });

  it('breaks in the order of toughness: glass before basalt, ice before both', () => {
    const toughness = (key: string): number => row$(key).toughness!;
    expect(toughness('ICE')).toBeLessThan(toughness('GLASS'));
    expect(toughness('GLASS')).toBeLessThan(toughness('BRICK'));
    expect(toughness('BRICK')).toBeLessThan(toughness('STONE'));
  });

  it('keeps the heat capacity of the parent in each broken form, so a crush keeps the temperature', () => {
    expect(elementHeatCapacity(row$('GRAVEL'))).toBe(elementHeatCapacity(row$('STONE')));
    expect(elementHeatCapacity(row$('SNOW'))).toBe(elementHeatCapacity(row$('ICE')));
    expect(elementHeatCapacity(row$('BROKEN_GLASS'))).toBe(elementHeatCapacity(row$('GLASS')));
  });
});

describe.skipIf(!device)('M8.1 AC16: sand and broken glass melt into molten glass', () => {
  it('sand past 1,713 °C by its latent width becomes lava that sets into glass, not sand', async () => {
    const sand = row$('SAND');
    expect(sand.above!.temp).toBe(1713);
    const short = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) - 1 }]);
    expect(typeOf(short.kinds[0]), 'sand just short of the end of its latent range').toBe(T.SAND);
    const past = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) + 1 }]);
    expect(typeOf(past.kinds[0]), 'sand just past it').toBe(T.LAVA);
    expect(ctypeOf(past.kinds[0]), 'it remembers glass').toBe(T.GLASS);
    expect(cellName(ELEMENTS, typeOf(past.kinds[0]), ctypeOf(past.kinds[0]))).toBe('Molten glass');

    const set = await row([{ kind: past.kinds[0], temp: setsBelow(row$('GLASS')) - 5 }]);
    expect(typeOf(set.kinds[0]), 'cooled under glass\'s setting point').toBe(T.GLASS);
    expect(ctypeOf(set.kinds[0])).toBe(0);
  });

  it('broken glass melts into the same molten glass, and glass does too', async () => {
    for (const key of ['BROKEN_GLASS', 'GLASS']) {
      const e = row$(key);
      const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }]);
      expect(typeOf(past.kinds[0]), `${key} past its melting`).toBe(T.LAVA);
      expect(ctypeOf(past.kinds[0]), `${key} sets into glass`).toBe(T.GLASS);
    }
  });

  it('gravel melts into lava that sets into basalt', async () => {
    const gravel = row$('GRAVEL');
    const past = await row([{ kind: cell(T.GRAVEL), temp: meltsAbove(gravel) + 1 }]);
    expect(typeOf(past.kinds[0])).toBe(T.LAVA);
    expect(ctypeOf(past.kinds[0])).toBe(T.STONE);
    const set = await row([{ kind: past.kinds[0], temp: row$('STONE').above!.temp - row$('STONE').above!.latent! / elementHeatCapacity(row$('LAVA')) - 5 }]);
    expect(typeOf(set.kinds[0]), 'cooled lava of gravel').toBe(T.STONE);
  });

  it('brick is not melted by lava: it has no melting point, and stays brick at the hottest lava temperature the table paints', async () => {
    expect(row$('BRICK').above, 'a brick row with an `above` could melt').toBeUndefined();
    const hot = await row([{ kind: cell(T.BRICK), temp: 1500 }], 100);
    expect(typeOf(hot.kinds[0])).toBe(T.BRICK);
  });
});


// M8.1f: the metals and refractories (aluminium, copper, gold, titanium, tungsten, ceramic, diamond, insulation).

const METALS = ['METAL', 'ALUMINIUM', 'COPPER', 'GOLD', 'TITANIUM', 'TUNGSTEN'] as const;
// The stored temperature a molten cell with ctype k must fall under to set: k's latent heat over the molten element's capacity.
const setsBelowIn = (k: ElementDef, molten: ElementDef): number => k.above!.temp - (k.above!.latent ?? 0) / elementHeatCapacity(molten);
// Thermal diffusivity up to the common factor HEAT_UNIT: the ratio of two rows' is the ratio of their speeds.
const diffusivity = (e: ElementDef): number => elementConductivity(e) / elementHeatCapacity(e);

describe('M8.1 AC24, AC23 and AC15: the M8.1f rows', () => {
  it('labels METAL "Steel" and lists the six metals in the Metals tab, then names its melt "Molten steel"', () => {
    expect(row$('METAL').label).toBe('Steel');
    const metals = pickerTabs(ELEMENTS).find((t) => t.name === 'Metals')!;
    expect(metals.entries.map((e) => e.label)).toEqual(['Steel', 'Aluminium', 'Copper', 'Gold', 'Titanium', 'Tungsten']);
    expect(cellName(ELEMENTS, T.MOLTEN_METAL, 0)).toBe('Molten steel');
    expect(cellName(ELEMENTS, T.MOLTEN_METAL, T.ALUMINIUM)).toBe('Molten aluminium');
    expect(pickerTabs(ELEMENTS).find((t) => t.name === 'Solids')!.entries.map((e) => e.label)).toEqual(
      expect.arrayContaining(['Ceramic', 'Diamond', 'Aerogel']),
    );
  });

  it('melts each metal at its handbook temperature, in the order aluminium, gold, copper, steel, titanium, tungsten, into the molten metal that sets back into it', () => {
    const melt = (key: string): number => row$(key).above!.temp;
    expect([melt('ALUMINIUM'), melt('GOLD'), melt('COPPER'), melt('METAL'), melt('TITANIUM'), melt('TUNGSTEN')]).toEqual([660, 1064, 1085, 1538, 1668, 3422]);
    for (const key of METALS) {
      expect(row$(key).above!.becomes, key).toBe('MOLTEN_METAL');
      expect(row$(key).above!.setsInto ?? key, `${key} sets into itself`).toBe(key);
    }
  });

  it('carries heat in the order of the data: diamond, gold, copper, aluminium, tungsten, steel, titanium', () => {
    const order = ['DIAMOND', 'GOLD', 'COPPER', 'ALUMINIUM', 'TUNGSTEN', 'METAL', 'TITANIUM'].map((k) => diffusivity(row$(k)));
    expect(order).toEqual([...order].sort((a, b) => b - a));
    // Copper and gold spread heat about 8 times faster than steel, aluminium about 7 (the plan's figures).
    const ratio = (k: string): number => diffusivity(row$(k)) / diffusivity(row$('METAL'));
    expect([ratio('COPPER'), ratio('GOLD'), ratio('ALUMINIUM')].map((r) => Math.round(r))).toEqual([8, 9, 7]);
    expect(ratio('TITANIUM')).toBeLessThan(1);
  });

  it('gives ceramic and diamond no crush, diamond no melting point, and insulation far less conductivity than basalt', () => {
    for (const key of ['CERAMIC', 'DIAMOND']) expect(row$(key).pressureAbove, `${key} is never crushed`).toBeUndefined();
    expect(row$('DIAMOND').above, 'diamond never melts').toBeUndefined();
    expect(row$('CERAMIC').above!.temp, 'ceramic melts far over steel').toBeGreaterThan(row$('MOLTEN_METAL').below!.temp + 400);
    expect(elementConductivity(row$('STONE')) / elementConductivity(row$('INSULATION'))).toBeGreaterThan(100);
    expect(row$('INSULATION').above!.temp, 'aerogel melts over the temperature lava is painted at').toBeGreaterThan(row$('LAVA').temperature!);
    expect(() => validateElements(ELEMENTS)).not.toThrow();
  });
});

describe.skipIf(!device)('M8.1 AC9 and AC10: each M8.1f metal melts into molten metal that remembers it', () => {
  it.each(METALS.filter((k) => k !== 'METAL'))('%s melts into molten metal with its own ctype, is named after it, and sets back', async (key) => {
    const e = row$(key);
    const molten = row$('MOLTEN_METAL');
    const short = await row([{ kind: cell(e.id), temp: meltsAbove(e) - 1 }]);
    expect(typeOf(short.kinds[0]), `${key} just short of the end of its latent range`).toBe(e.id);
    const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }]);
    expect(typeOf(past.kinds[0]), `${key} just past it`).toBe(T.MOLTEN_METAL);
    expect(ctypeOf(past.kinds[0]), 'it remembers itself').toBe(e.id);
    expect(cellName(ELEMENTS, typeOf(past.kinds[0]), ctypeOf(past.kinds[0]))).toBe(`Molten ${e.label.toLowerCase()}`);
    const set = await row([{ kind: past.kinds[0], temp: setsBelowIn(e, molten) - 5 }]);
    expect(typeOf(set.kinds[0]), 'cooled under its setting point').toBe(e.id);
    expect(ctypeOf(set.kinds[0])).toBe(0);
  });

  it('keeps diamond at 9,000 °C, ceramic at 2,000 and tungsten at 3,000 as they are over 100 supersteps', async () => {
    const hot = await row([
      { kind: cell(T.DIAMOND), temp: 9000 }, { kind: cell(T.CERAMIC), temp: 2000 }, { kind: cell(T.TUNGSTEN), temp: 3000 },
    ], 100);
    expect(Array.from(hot.kinds)).toEqual([cell(T.DIAMOND), cell(T.CERAMIC), cell(T.TUNGSTEN)]);
  });

  it('keeps the total heat of a sealed box of the new rows, solid and molten, over 2,000 supersteps', async () => {
    const width = 48;
    const height = 40;
    const sim = createSim(width, height, 10, { elements: ELEMENTS, air: false });
    const next = mulberry32(10);
    const rand = (): number => next() / 2 ** 32;
    // [element, ctype, lowest and highest start temperature], across the thresholds of each row.
    const range: [number, number, number, number][] = [
      [T.ALUMINIUM, 0, 300, 1200], [T.MOLTEN_METAL, T.ALUMINIUM, 100, 900], [T.COPPER, 0, 800, 1800], [T.MOLTEN_METAL, T.COPPER, 400, 1500],
      [T.GOLD, 0, 800, 1900], [T.TITANIUM, 0, 1400, 2400], [T.TUNGSTEN, 0, 3000, 4800], [T.MOLTEN_METAL, T.TUNGSTEN, 2000, 4800],
      [T.CERAMIC, 0, 1800, 3600], [T.LAVA, T.CERAMIC, 1500, 3600], [T.INSULATION, 0, 1500, 4200], [T.DIAMOND, 0, 20, 3000], [T.WATER, 0, 0, 90],
    ];
    const kind = new Uint32Array(width * height);
    const temp = new Uint32Array(width * height);
    const temps = tempView({ temp });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (y < 2 || x < 2 || x >= width - 2) {
          kind[i] = cell(T.WALL);
          continue;
        }
        const [type, ctype, low, high] = range[Math.floor(rand() * range.length)];
        kind[i] = cell(type, 0, ctype);
        temps[i] = low + rand() * (high - low);
      }
    }
    sim.load({ kind, temp });
    const measure = async (): Promise<number> => heatContent(ELEMENTS, { kind: await readCells(sim), temp: await sim.fields.read('temp') }, await sim.flyers.read());
    const before = await measure();
    for (let i = 1; i <= 4; i++) {
      await runMany(sim, 500);
      expect(Math.abs((await measure()) - before) / Math.abs(before), `heat after ${i * 500} supersteps, ${before} at the start`).toBeLessThan(1e-4);
    }
  }, 120_000);
});

const NO_AIR_OPTIONS = { air: false };

describe.skipIf(!device)('metalBars', () => {
  // Experiment: heat crossing sealed bars of steel, copper, gold, aluminium, titanium and diamond of one size (40 cells), the
  //   time constant of each measured as `sealedBars` does (the difference between the halves falls as exp(-t / tau), sampled
  //   half and one and a half expected time constants in).
  // Target: heat crosses a copper, gold or aluminium bar faster than the steel bar by the ratio of their diffusivities
  //   alpha = k / (rho c), within 15%, and a diamond bar fastest of all (M8.1 AC24); titanium, a poorer conductor than steel,
  //   is slower by its ratio. The ratios come from the rows' own data (copper 8.1, gold 8.9, aluminium 6.9, titanium 0.65),
  //   figures the todo of M8.9 computed from the handbook values the rows cite.
  // Waits (D40): the game exchanges heat between the cells of a pair in two sweeps, which makes its effective diffusivity
  //   alpha (1 + r) for r = PAIR_TIME alpha / CELL_SIZE² the share closed per pair and superstep: 3% over for steel (r = 0.03),
  //   22 to 29% for aluminium, copper and gold (r = 0.22 to 0.29), past the 15% of the target. A CPU model of the two sweeps
  //   reproduces the measured time constants to three digits.
  // Diamond: the game caps a pair's exchange at their mean (`heatShare`), which diamond's 2,200 W/m·K reaches, so the bar
  //   relaxes at the grid's fastest pace (about 30 times steel), not at the data's 85 times; the check is that it leads.
  const taus = new Map<string, Promise<number>>();
  async function measuredTau(material: MetalBarsMaterial, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const row = elementByKey(ELEMENTS, material);
    const expected = (METAL_BARS.cells * CELL_SIZE) ** 2 / (Math.PI ** 2 * (elementConductivity(row) / (elementHeatCapacity(row) * HEAT_UNIT)));
    const scene = metalBars(material);
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR_OPTIONS, elements });
    sim.load(scene.fields);
    const difference = async (): Promise<number> => {
      const t = tempView({ temp: await sim.fields.read('temp') });
      let left = 0;
      let right = 0;
      for (let x = 0; x < METAL_BARS.cells / 2; x++) {
        left += t[x];
        right += t[METAL_BARS.cells - 1 - x];
      }
      return (left - right) / (METAL_BARS.cells / 2);
    };
    const supersteps = (seconds: number): number => Math.round(seconds / PAIR_TIME);
    await runMany(sim, supersteps(0.5 * expected));
    const first = await difference();
    await runMany(sim, supersteps(expected));
    const second = await difference();
    // The samples are one expected time constant apart, so the decay between them is exp(-expected / tau).
    return expected / Math.log(first / second);
  }
  const tau = (material: MetalBarsMaterial): Promise<number> => {
    if (!taus.has(material)) taus.set(material, measuredTau(material));
    return taus.get(material)!;
  };
  // How much faster than steel the bar relaxes, over how much faster its row's data say.
  async function speedRatio(material: MetalBarsMaterial, elements?: readonly ElementDef[]): Promise<number> {
    const measured = (await tau('METAL')) / (elements ? await measuredTau(material, elements) : await tau(material));
    return measured / (diffusivity(row$(material)) / diffusivity(row$('METAL')));
  }
  const WITHIN_15 = [0.85, 1.15] as const;

  for (const material of ['ALUMINIUM', 'COPPER', 'GOLD'] as const) {
    const version = material.toLowerCase();
    scenario({
      name: 'metalBars',
      version,
      measure: async () => ({ ratio: await speedRatio(material) }),
      checks: [{
        value: 'ratio',
        outcome: 'heat crosses the bar faster than steel by the ratio of the diffusivities, within 15%',
        target: WITHIN_15,
        waitsFor: waitsFor(`metalBars-${version}`),
        companion: [0.85, 1.5],
      }],
      timeout: 120_000,
    });
  }

  scenario({
    name: 'metalBars',
    version: 'titanium',
    measure: async () => ({ ratio: await speedRatio('TITANIUM') }),
    checks: [{ value: 'ratio', outcome: 'heat crosses the bar slower than steel by the ratio of the diffusivities, within 15%', target: WITHIN_15 }],
    timeout: 120_000,
  });

  scenario({
    name: 'metalBars',
    version: 'diamond',
    measure: async () => {
      const others = await Promise.all((['METAL', 'ALUMINIUM', 'COPPER', 'GOLD', 'TITANIUM'] as const).map((m) => tau(m)));
      return { lead: Math.min(...others) / (await tau('DIAMOND')) };
    },
    checks: [{ value: 'lead', outcome: 'heat crosses the bar faster than in any metal bar', target: [1.5, Infinity] }],
    timeout: 120_000,
  });

  // Copper at half its conductivity relaxes at about half the speed its data give.
  control({
    name: 'metalBars',
    version: 'copper',
    wrong: 'copper at half its conductivity',
    measure: () => speedRatio('COPPER', ELEMENTS.map((e) => (e.key === 'COPPER' ? { ...e, conductivity: elementConductivity(e) / 2 } : e))),
    target: WITHIN_15,
    timeout: 120_000,
  });
});

describe.skipIf(!device)('insulationWall', () => {
  // Experiment: lava against a wall one cell thick, water on its far side, and the same against a basalt wall.
  // Target: the water behind the insulation warms at least 20 times less than behind the basalt over the same time (M8.1 AC23).
  // Calculation (estimate): the heat through a wall is its conductivity over its thickness, in series with half a cell of lava
  //   (1 W/m·K) and half a cell of water (0.6): resistances in cell widths over W/m·K. With the rows' basalt (2.0) and aerogel
  //   (0.015; handbook 0.013 to 0.020) the steady ratio is (1/0.015 + 0.5/1 + 0.5/0.6) / (1/2.0 + 0.5/1 + 0.5/0.6)
  //   = 68.0 / 1.83 = 37. Mineral wool (0.04) would give 14 and miss 20, which is why the row is aerogel. Over the first
  //   seconds the ratio is higher (an aerogel cell warms through slowly).
  // Measure: the mean displayed temperature rise of the water cells after 480 supersteps (2 s), before the water nearest the wall
  //   boils in the basalt case; the basalt wall's over the aerogel wall's.
  const SUPERSTEPS = 480;
  async function waterRise(wall: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const scene = insulationWall(wall);
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR_OPTIONS, elements });
    sim.load(scene.fields);
    await runMany(sim, SUPERSTEPS);
    const kinds = await readCells(sim);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    const rows = new Map(elements.map((e) => [e.id, e]));
    let sum = 0;
    let n = 0;
    for (let y = 0; y < scene.height; y++) {
      for (let x = INSULATION_WALL.lavaWidth + 1; x < scene.width; x++) {
        const i = y * scene.width + x;
        sum += effectiveTemp(rows.get(typeOf(kinds[i]))!, temps[i]);
        n++;
      }
    }
    return sum / n - elementTemperature(row$('WATER'));
  }
  const ratio = async (elements: readonly ElementDef[] = ELEMENTS): Promise<number> => (await waterRise(T.STONE, elements)) / (await waterRise(T.INSULATION, elements));
  const TARGET = [20, Infinity] as const;

  scenario({
    name: 'insulationWall',
    measure: async () => ({ ratio: await ratio() }),
    checks: [{ value: 'ratio', outcome: 'the water behind an aerogel wall warms at least 20 times less than behind a basalt wall', target: TARGET }],
    timeout: 60_000,
  });

  // An insulation wall that conducts like basalt lets the water warm as much: the ratio is a few at most.
  control({
    name: 'insulationWall',
    wrong: 'insulation with the conductivity of basalt',
    measure: () => ratio(ELEMENTS.map((e) => (e.key === 'INSULATION' ? { ...e, conductivity: elementConductivity(row$('STONE')) } : e))),
    target: TARGET,
    timeout: 60_000,
  });
});

describe.skipIf(!device)('crucible', () => {
  // Experiment: molten steel at 1,600 °C in a cup of ceramic preheated to 1,500 °C, in a cold tungsten cup, and in a cold ceramic cup.
  // Target: no cell of the preheated ceramic cup or the tungsten cup changes over 2,000 supersteps; the cold ceramic cup cracks
  //   (M8.1 AC22).
  // Calculation: tungsten melts at 3,422 °C (handbook) and alumina at 2,072, far above the steel's 1,600, and neither is crushed;
  //   a cell of either could only change by melting. The preheat is 100 K under the steel; whether that is within the ceramic's
  //   shock limit is checked against the limit itself at M8.1k, which also makes the cold cup crack.
  // Measure: the number of cup cells whose element changed over 2,000 supersteps.
  const SUPERSTEPS = 2000;
  const cupCells = crucibleCup().reduce((n, r) => n + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  async function changedCupCells(scene: Scene, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR_OPTIONS, elements });
    sim.load(scene.fields);
    await runMany(sim, SUPERSTEPS);
    const after = await readCells(sim);
    let changed = 0;
    for (const { x0, x1, y0, y1 } of crucibleCup()) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) if (typeOf(after[y * scene.width + x]) !== typeOf(scene.fields.kind[y * scene.width + x])) changed++;
      }
    }
    return changed;
  }

  scenario({
    name: 'crucible',
    measure: async () => ({ changed: await changedCupCells(crucible(T.CERAMIC)) }),
    checks: [{ value: 'changed', outcome: `no cell of the ${CRUCIBLE.preheat} °C ceramic cup changes over 2,000 supersteps`, target: [0, 0] }],
    timeout: 60_000,
  });
  scenario({
    name: 'crucible',
    version: 'tungsten',
    measure: async () => ({ changed: await changedCupCells(crucible(T.TUNGSTEN, 20)) }),
    checks: [{ value: 'changed', outcome: 'no cell of the cold tungsten cup changes over 2,000 supersteps', target: [0, 0] }],
    timeout: 60_000,
  });
  scenario({
    name: 'crucible',
    version: 'cold',
    measure: async () => ({ changed: await changedCupCells(crucible(T.CERAMIC, 20)) }),
    checks: [{
      value: 'changed',
      outcome: 'the cold ceramic cup cracks: some of its cells change over 2,000 supersteps',
      target: [1, cupCells],
      waitsFor: waitsFor('crucible-cold'),
      companion: [0, cupCells],
    }],
    timeout: 60_000,
  });

  // A ceramic that melts at 1,400 °C, with a tenth of its latent heat, melts in the steel at 1,600 °C.
  control({
    name: 'crucible',
    wrong: 'ceramic melting at 1,400 °C with a tenth of its latent heat',
    measure: () => changedCupCells(
      crucible(T.CERAMIC),
      ELEMENTS.map((e) => (e.key === 'CERAMIC' ? { ...e, above: { ...e.above, temp: 1400, latent: e.above.latent / 10 } } : e)),
    ),
    target: [0, 0],
    timeout: 60_000,
  });
});
