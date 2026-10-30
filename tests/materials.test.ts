import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, cellName, elementByKey, elementConductivity, elementHeatCapacity, elementTemperature, validateElements, type ElementDef } from '../src/elements';
import { effectiveTemp } from '../src/heat';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import {
  CRUCIBLE, DENSITY_COLUMN, INSULATION_WALL, METAL_BARS, NITROGEN_ON_WATER, QUENCH, THERMOMETER, crucible, crucibleCup, densityColumn, densityColumnLayers, insulationWall, metalBars, nitrogenOnWater, quench, thermometer,
  thermometerLayout, thermometerLevel, type MetalBarsMaterial,
} from '../src/scenarios';
import type { Scene } from '../src/scenes';
import { pickerTabs } from '../src/toolbar';
import { cell, createSim, device, mulberry32, readCells, runMany } from './gpu';
import { Canvas, WALL, tank } from '../src/scene-canvas';
import { columnsWithAbove, countType, heatContent } from './metrics';
import { NO_SHOCK_TABLE } from './no-shock-table';
import { MOLTEN_LIQUIDS } from './molten-table';
import { control, scenario, waitsFor } from './scenario';

// The materials of M8.1 and what they do: the rows (this file), then each one's main behavior as a scene test.

const NO_AIR = { air: false };
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
// The stored temperature a melting cell must pass to melt, and the one a liquid cell must fall under to set.
const meltsAbove = (e: ElementDef): number => e.above!.temp + (e.above!.latent ?? 0) / elementHeatCapacity(e);
const setsBelow = (liquid: ElementDef): number => liquid.below!.temp - (liquid.below!.latent ?? 0) / elementHeatCapacity(liquid);

describe('M8.1e rows', () => {
  it('is a valid table, and basalt is named and crushed as the plan says', () => {
    expect(() => validateElements(ELEMENTS)).not.toThrow();
    expect(row$('STONE').label).toBe('Basalt');
    expect(cellName(ELEMENTS, T.LAVA), 'melted basalt').toBe('Lava');
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
  it('sand past 1,713 °C by its latent width becomes molten glass that sets into glass, not sand', async () => {
    const sand = row$('SAND');
    expect(sand.above!.temp).toBe(1713);
    const short = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) - 1 }]);
    expect(typeOf(short.kinds[0]), 'sand just short of the end of its latent range').toBe(T.SAND);
    const past = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) + 1 }]);
    expect(typeOf(past.kinds[0]), 'sand just past it').toBe(T.MOLTEN_GLASS);
    expect(cellName(ELEMENTS, typeOf(past.kinds[0]))).toBe('Molten glass');

    const set = await row([{ kind: past.kinds[0], temp: setsBelow(row$('MOLTEN_GLASS')) - 5 }]);
    expect(typeOf(set.kinds[0]), 'cooled under glass\'s setting point').toBe(T.GLASS);
    expect(set.kinds[0] >>> 16).toBe(0);
  });

  it('broken glass melts into the same molten glass, and glass does too', async () => {
    for (const key of ['BROKEN_GLASS', 'GLASS']) {
      const e = row$(key);
      const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }]);
      expect(typeOf(past.kinds[0]), `${key} past its melting`).toBe(T.MOLTEN_GLASS);
    }
  });

  it('gravel melts into lava that sets into basalt', async () => {
    const gravel = row$('GRAVEL');
    const past = await row([{ kind: cell(T.GRAVEL), temp: meltsAbove(gravel) + 1 }]);
    expect(typeOf(past.kinds[0])).toBe(T.LAVA);
    const set = await row([{ kind: past.kinds[0], temp: setsBelow(row$('LAVA')) - 5 }]);
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
/** The key of the liquid a metal melts into. */
const liquidOf = (key: string): string => `MOLTEN_${key}`;
// Thermal diffusivity up to the common factor HEAT_UNIT: the ratio of two rows' is the ratio of their speeds.
const diffusivity = (e: ElementDef): number => elementConductivity(e) / elementHeatCapacity(e);

describe('M8.1 AC24, AC23 and AC15: the M8.1f rows', () => {
  it('labels METAL "Steel" and lists the six metals in the Metals tab, then names its melt "Molten steel"', () => {
    expect(row$('METAL').label).toBe('Steel');
    const metals = pickerTabs(ELEMENTS).find((t) => t.name === 'Metals')!;
    expect(metals.entries.map((e) => e.label)).toEqual(['Steel', 'Aluminium', 'Copper', 'Gold', 'Titanium', 'Tungsten']);
    expect(cellName(ELEMENTS, T.MOLTEN_METAL)).toBe('Molten steel');
    expect(cellName(ELEMENTS, T.MOLTEN_ALUMINIUM)).toBe('Molten aluminium');
    expect(pickerTabs(ELEMENTS).find((t) => t.name === 'Solids')!.entries.map((e) => e.label)).toEqual(
      expect.arrayContaining(['Ceramic', 'Diamond', 'Aerogel']),
    );
  });

  it('melts each metal at its handbook temperature, in the order aluminium, gold, copper, steel, titanium, tungsten, into the molten metal of its own that sets back into it', () => {
    const melt = (key: string): number => row$(key).above!.temp;
    expect([melt('ALUMINIUM'), melt('GOLD'), melt('COPPER'), melt('METAL'), melt('TITANIUM'), melt('TUNGSTEN')]).toEqual([660, 1064, 1085, 1538, 1668, 3422]);
    for (const key of METALS) {
      expect(row$(key).above!.becomes, key).toBe(liquidOf(key));
      expect(row$(liquidOf(key)).below!.becomes, `${key}'s liquid sets into itself`).toBe(key);
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

describe.skipIf(!device)('M8.1 AC9 and AC10: each M8.1f metal melts into a molten metal of its own', () => {
  it.each(METALS.filter((k) => k !== 'METAL'))('%s melts into its own molten metal, named after it, and sets back', async (key) => {
    const e = row$(key);
    const molten = row$(liquidOf(key));
    const short = await row([{ kind: cell(e.id), temp: meltsAbove(e) - 1 }]);
    expect(typeOf(short.kinds[0]), `${key} just short of the end of its latent range`).toBe(e.id);
    const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }]);
    expect(typeOf(past.kinds[0]), `${key} just past it`).toBe(molten.id);
    expect(cellName(ELEMENTS, typeOf(past.kinds[0]))).toBe(`Molten ${e.label.toLowerCase()}`);
    const set = await row([{ kind: past.kinds[0], temp: setsBelow(molten) - 5 }]);
    expect(typeOf(set.kinds[0]), 'cooled under its setting point').toBe(e.id);
    expect(set.kinds[0] >>> 16).toBe(0);
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
    // [element, lowest and highest start temperature], across the thresholds of each row.
    const range: [number, number, number][] = [
      [T.ALUMINIUM, 300, 1200], [T.MOLTEN_ALUMINIUM, 100, 900], [T.COPPER, 800, 1800], [T.MOLTEN_COPPER, 400, 1500],
      [T.GOLD, 800, 1900], [T.TITANIUM, 1400, 2400], [T.TUNGSTEN, 3000, 4800], [T.MOLTEN_TUNGSTEN, 2000, 4800],
      [T.CERAMIC, 1800, 3600], [T.MOLTEN_CERAMIC, 1500, 3600], [T.INSULATION, 1500, 4200], [T.DIAMOND, 20, 3000], [T.WATER, 0, 90],
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
        const [type, low, high] = range[Math.floor(rand() * range.length)];
        kind[i] = cell(type);
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
  //   a cell of either could only change by melting, and tungsten is a metal, which never cracks from the heat. The preheat is 100 K
  //   under the steel, inside the 174 K alumina withstands (`shockLimit`: 4 MPa·√m, 372 GPa, 8.1e-6 per °C against the glass
  //   anchor), while the cold cup meets the steel 1,580 K hotter and cracks, as a real one does.
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
    }],
    timeout: 60_000,
  });

  // A ceramic ten times less expanding withstands ten times the difference: the cold cup does not crack.
  control({
    name: 'crucible',
    version: 'cold',
    wrong: 'ceramic expanding a tenth as much',
    measure: () => changedCupCells(crucible(T.CERAMIC, 20), ELEMENTS.map((e) => (e.key === 'CERAMIC' ? { ...e, expansion: e.expansion / 10 } : e))),
    target: [1, cupCells],
    timeout: 60_000,
  });

  // A ceramic that melts at 1,400 °C, with a tenth of its latent heat, melts in the steel at 1,600 °C.
  control({
    name: 'crucible',
    wrong: 'ceramic melting at 1,400 °C with a tenth of its latent heat',
    measure: () => changedCupCells(
      crucible(T.CERAMIC),
      // The liquid sets where the ceramic melts, at the same latent heat.
      ELEMENTS.map((e) => (e.key === 'CERAMIC' ? { ...e, above: { ...e.above, temp: 1400, latent: e.above.latent / 10 } } : e.key === 'MOLTEN_CERAMIC' ? { ...e, below: { ...e.below, temp: 1400, latent: e.below.latent / 10 } } : e)),
    ),
    target: [0, 0],
    timeout: 60_000,
  });
});

// M8.1g: light and cold (sawdust, wax, nitrogen, mercury).

describe('M8.1 AC17 and AC31: the M8.1g rows', () => {
  it('lists sawdust, mercury, nitrogen and wax in their tabs, and the rest only through a paint temperature', () => {
    const tab = (name: string): string[] => pickerTabs(ELEMENTS).find((t) => t.name === name)!.entries.map((e) => e.label);
    expect(tab('Powders')).toContain('Sawdust');
    expect(tab('Liquids')).toContain('Mercury');
    expect(tab('Gases')).toContain('Nitrogen');
    expect(tab('Solids')).toContain('Wax');
    for (const key of ['MOLTEN_WAX', 'LIQUID_NITROGEN', 'SOLID_NITROGEN', 'SOLID_MERCURY', 'MERCURY_VAPOR']) expect(row$(key).toolbar, key).toBeUndefined();
    expect(() => validateElements(ELEMENTS)).not.toThrow();
  });

  it('orders the densities as the plan says: mercury is the densest liquid, sawdust floats on oil, water and molten wax', () => {
    const density = (key: string): number => row$(key).density;
    const liquids = ELEMENTS.filter((e: ElementDef) => e.state === 'liquid' && !MOLTEN_LIQUIDS.includes(e.key));
    expect(Math.max(...liquids.map((e: ElementDef) => e.density))).toBe(density('MERCURY'));
    expect(density('SAWDUST')).toBeLessThan(density('MOLTEN_WAX'));
    expect(density('MOLTEN_WAX')).toBeLessThan(density('OIL'));
    expect(density('OIL')).toBeLessThan(density('WATER'));
    expect(density('WATER')).toBeLessThan(density('MERCURY'));
    expect(density('LIQUID_NITROGEN'), 'liquid nitrogen floats on water').toBeLessThan(density('WATER'));
  });

  it('puts the transitions at the handbook temperatures, each pair sharing its heat', () => {
    expect([row$('WAX').above!.temp, row$('NITROGEN').below!.temp, row$('LIQUID_NITROGEN').below!.temp, row$('MERCURY').below!.temp, row$('MERCURY').above!.temp])
      .toEqual([60, -195.8, -210, -38.83, 356.73]);
    expect(row$('MOLTEN_WAX').below).toEqual({ ...row$('WAX').above, becomes: 'WAX' });
    expect(elementTemperature(row$('LIQUID_NITROGEN'))).toBeLessThan(row$('LIQUID_NITROGEN').above!.temp);
  });

  it('gives a gas row the specific heat of its gas times the density of its liquid, as a cell is one unit of matter', () => {
    expect(elementHeatCapacity(row$('NITROGEN'))).toBeCloseTo((1.04 * row$('LIQUID_NITROGEN').density) / 1000, 2);
    expect(elementHeatCapacity(row$('MERCURY_VAPOR'))).toBeCloseTo(((20.79 / 0.20059) * row$('MERCURY').density) / 1e6, 1);
  });
});

describe.skipIf(!device)('M8.1 AC17 and AC10: the M8.1g transitions', () => {
  it('takes wax, nitrogen and mercury through their states, up and down', async () => {
    const up: [string, string][] = [['WAX', 'MOLTEN_WAX'], ['LIQUID_NITROGEN', 'NITROGEN'], ['SOLID_NITROGEN', 'LIQUID_NITROGEN'], ['MERCURY', 'MERCURY_VAPOR'], ['SOLID_MERCURY', 'MERCURY']];
    for (const [from, to] of up) {
      const e = row$(from);
      const short = await row([{ kind: cell(e.id), temp: meltsAbove(e) - 1 }]);
      expect(typeOf(short.kinds[0]), `${from} just short`).toBe(e.id);
      const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }]);
      expect(typeOf(past.kinds[0]), `${from} past its threshold`).toBe(T[to as keyof typeof T]);
    }
    const down: [string, string][] = [['MOLTEN_WAX', 'WAX'], ['NITROGEN', 'LIQUID_NITROGEN'], ['LIQUID_NITROGEN', 'SOLID_NITROGEN'], ['MERCURY', 'SOLID_MERCURY'], ['MERCURY_VAPOR', 'MERCURY']];
    for (const [from, to] of down) {
      const e = row$(from);
      const below = e.below!;
      const stored = below.temp - (below.latent ?? 0) / elementHeatCapacity(e);
      const short = await row([{ kind: cell(e.id), temp: stored + 1 }]);
      expect(typeOf(short.kinds[0]), `${from} just short`).toBe(e.id);
      const past = await row([{ kind: cell(e.id), temp: stored - 1 }]);
      expect(typeOf(past.kinds[0]), `${from} past its threshold`).toBe(T[to as keyof typeof T]);
    }
  });

  it('keeps the total heat of a sealed box of the M8.1g rows over 2,000 supersteps', async () => {
    const width = 48;
    const height = 40;
    const sim = createSim(width, height, 11, { elements: ELEMENTS, air: false });
    const next = mulberry32(11);
    const rand = (): number => next() / 2 ** 32;
    const range: [number, number, number][] = [
      [T.WAX, 20, 200], [T.MOLTEN_WAX, 0, 150], [T.SAWDUST, 0, 100], [T.LIQUID_NITROGEN, -240, -60], [T.NITROGEN, -240, 0], [T.SOLID_NITROGEN, -260, -150],
      [T.MERCURY, -80, 800], [T.SOLID_MERCURY, -100, 100], [T.MERCURY_VAPOR, 0, 1500], [T.WATER, 0, 90],
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
        const [type, low, high] = range[Math.floor(rand() * range.length)];
        kind[i] = cell(type);
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

describe.skipIf(!device)('densityColumn', () => {
  // Experiment: sawdust, oil, water and mercury in a tank, in each of the 24 orders there are (the default, with the lightest at the
  //   bottom, is the one where every layer has to cross the others).
  // Target: they settle from the bottom in the order of their densities: mercury, water, oil, sawdust (M8.1 AC19), and at least 95%
  //   of the sawdust cells end above the water's surface (M8.1 AC18). Handbook densities at 20 °C: mercury 13,546 kg/m³, water about
  //   1,000, oil about 900 (the OIL row; vegetable oils 910 to 920), sawdust 130 to 250 as a loose bed (wood itself 500 to 700),
  //   lighter than water and oil, so it floats on both.
  // Measure: after 2,000 supersteps (the default order settles within 500), the number of columns where a lighter material lies
  //   under a heavier one, summed over the pairs and the 24 orders, and the share of sawdust cells over the highest water cell, the
  //   lowest of the 24 orders.
  const SUPERSTEPS = 2000;
  const ORDER = [T.MERCURY, T.WATER, T.OIL, T.SAWDUST];
  const permutations = <X>(items: readonly X[]): X[][] =>
    (items.length <= 1 ? [[...items]] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

  async function settled(order: readonly number[], elements: readonly ElementDef[]): Promise<{ inversions: number; above: number }> {
    const scene = densityColumn(order);
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR, elements });
    sim.load(scene.fields);
    await runMany(sim, SUPERSTEPS);
    const cells = await readCells(sim);
    let inversions = 0;
    for (let a = 0; a < ORDER.length; a++) for (let b = a + 1; b < ORDER.length; b++) inversions += columnsWithAbove(cells, scene.width, scene.height, ORDER[a], ORDER[b]);
    let waterTop = -1;
    cells.forEach((c, i) => { if (typeOf(c) === T.WATER) waterTop = Math.max(waterTop, Math.floor(i / scene.width)); });
    const sawdust = countType(cells, T.SAWDUST);
    let above = 0;
    cells.forEach((c, i) => { if (typeOf(c) === T.SAWDUST && Math.floor(i / scene.width) > waterTop) above++; });
    return { inversions, above: sawdust === 0 ? 0 : above / sawdust };
  }
  async function everyOrder(): Promise<{ inversions: number; above: number }> {
    const results = [];
    for (const order of permutations(densityColumnLayers())) results.push(await settled(order, ELEMENTS));
    return { inversions: results.reduce((n, r) => n + r.inversions, 0), above: Math.min(...results.map((r) => r.above)) };
  }

  scenario({
    name: 'densityColumn',
    measure: everyOrder,
    checks: [
      { value: 'inversions', outcome: 'mercury, water, oil and sawdust settle in that order from the bottom, whatever order they start in', target: [0, 0] },
      { value: 'above', outcome: 'at least 95% of the sawdust ends above the water, whatever order they start in', target: [0.95, 1] },
    ],
    timeout: 120_000,
  });

  // Sawdust as dense as sand sinks under the water: it ends between the mercury and the water.
  control({
    name: 'densityColumn',
    wrong: 'sawdust as dense as sand',
    measure: async () => (await settled(densityColumnLayers(), ELEMENTS.map((e: ElementDef) => (e.key === 'SAWDUST' ? { ...e, density: row$('SAND').density } : e)))).above,
    target: [0.95, 1],
    timeout: 60_000,
  });

  it('M8.1 AC18: starts the default scene with the lightest layer at the bottom and every layer the same size', () => {
    const scene = densityColumn();
    const layer = (DENSITY_COLUMN.width - 2 * WALL) * DENSITY_COLUMN.layer;
    expect(typeOf(scene.fields.kind[WALL * scene.width + WALL])).toBe(T.SAWDUST);
    for (const type of ORDER) expect(countType(scene.fields.kind, type), String(type)).toBe(layer);
  });
});

describe.skipIf(!device)('quench', () => {
  // Experiment: a glass pane at 300 °C with water at 20 °C dripped on it, and the same pane cooling in still air.
  // Target: the glass cracks where the water touches it (at least the cells under the drip), and the pane cooling in still air
  //   cracks nowhere (M8.1 AC28).
  // Calculation: soda-lime glass bars quenched in water at 20 °C crack from a difference of 150 K (Malou et al. 2011,
  //   Ceramics-Silikaty 55(3), the anchor of `shockLimit`); water at 20 °C meets the pane 280 K hotter than itself, well over
  //   that; a pane cooling in still air has differences of a fraction of a kelvin between its cells (its Biot number is far
  //   below 1, estimate), far under it. A drip 4 cells wide touches at least 4 cells of the pane.
  // Measure: BROKEN_GLASS cells after 600 supersteps for the drip, and after 2,400 (5 s) for the pane in the air.
  const paneCells = (QUENCH.width - 2 * WALL) * QUENCH.thickness;
  async function cracked(version: 'water' | 'air', supersteps: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const scene = quench(version);
    const sim = createSim(scene.width, scene.height, 1, { elements });
    sim.load(scene.fields);
    await runMany(sim, supersteps);
    return countType(await readCells(sim), T.BROKEN_GLASS);
  }
  const glassWith = (expansion: (e: ElementDef) => number): readonly ElementDef[] =>
    ELEMENTS.map((e) => (e.key === 'GLASS' ? { ...e, expansion: expansion(e) } : e));

  scenario({
    name: 'quench',
    measure: async () => ({ cracked: await cracked('water', 600) }),
    checks: [{ value: 'cracked', outcome: `water at 20 °C cracks the glass pane at 300 °C where it touches it: at least ${QUENCH.dripWidth} cells`, target: [QUENCH.dripWidth, paneCells] }],
    timeout: 60_000,
  });
  scenario({
    name: 'quench',
    version: 'air',
    measure: async () => ({ cracked: await cracked('air', 2400) }),
    checks: [{ value: 'cracked', outcome: 'the same pane cooling in still air for 5 s cracks nowhere', target: [0, 0] }],
    timeout: 60_000,
  });

  // Glass that expands a tenth as much withstands ten times the difference: the water does not crack it.
  control({
    name: 'quench',
    wrong: 'glass expanding a tenth as much',
    measure: () => cracked('water', 600, glassWith((e) => e.expansion! / 10)),
    target: [QUENCH.dripWidth, paneCells],
    timeout: 60_000,
  });
  // Glass that expands 300 times as much cracks at half a kelvin: the pane cooling in the air cracks too.
  control({
    name: 'quench',
    version: 'air',
    wrong: 'glass expanding 300 times as much',
    measure: () => cracked('air', 2400, glassWith((e) => e.expansion! * 300)),
    target: [0, 0],
    timeout: 60_000,
  });
});

describe.skipIf(!device)('nitrogenOnWater', () => {
  // Experiment: liquid nitrogen poured onto water in a tank, the top closed.
  // Target: it floats (807 kg/m³ at -196 °C against water's 1,000), boils off until no liquid nitrogen is left and freezes a skin
  //   of ice on the water; its gas ends above the water (M8.1 AC20). Its drops skitter on their own vapor (Leidenfrost, below
  //   -160 °C on any room-temperature surface, `docs/research/physical-properties.md`); the skitter waits for film boiling (M12.4).
  // Calculation (estimate, handbook: latent heat of vaporisation 199 kJ/kg, gas capacity 1.04 kJ/kg·K): a cell is one unit of
  //   matter in every state, so a nitrogen cell takes 199 x 807 = 160.6 MJ/m³ to boil and 1.04 x 196 x 807 = 164.5 MJ/m³ more to
  //   warm its gas to 0 °C: at most 325.1 MJ/m³ from the water. A water cell at 20 °C gives up 4.18 x 20 = 83.6 MJ/m³ to reach
  //   0 °C and 334 kJ/kg x 1,000 kg/m³ = 334 MJ/m³ to freeze: 417.6. So one nitrogen cell freezes at most 325.1 / 417.6 = 0.78
  //   water cells. With 16 x 8 = 128 nitrogen cells that is at most 99 ice cells.
  // Measure: after 18,000 supersteps (75 s; the liquid is gone by 14,400): the liquid nitrogen cells left, the ice cells, and the
  //   share of the gas cells over the water's surface (the top row of the water).
  const SUPERSTEPS = 18_000;
  const N = (NITROGEN_ON_WATER.width - 2 * WALL) * NITROGEN_ON_WATER.nitrogen;
  const SURFACE = WALL + NITROGEN_ON_WATER.water;
  const MAX_ICE = Math.floor(0.78 * N);
  async function pour(elements: readonly ElementDef[] = ELEMENTS): Promise<{ liquid: number; ice: number; gasAbove: number }> {
    const scene = nitrogenOnWater();
    const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR, elements });
    sim.load(scene.fields);
    await runMany(sim, SUPERSTEPS);
    const cells = await readCells(sim);
    let gas = 0;
    let gasAbove = 0;
    cells.forEach((c, i) => {
      if (typeOf(c) !== T.NITROGEN) return;
      gas++;
      if (Math.floor(i / scene.width) >= SURFACE) gasAbove++;
    });
    // The frozen water is the ice and the snow it cracks into where the liquid nitrogen touches it (thermal shock, M8.1k): both are water
    // that froze, and the bound on it counts cells of water.
    return { liquid: countType(cells, T.LIQUID_NITROGEN), ice: countType(cells, T.ICE) + countType(cells, T.SNOW), gasAbove: gas === 0 ? 0 : gasAbove / gas };
  }

  scenario({
    name: 'nitrogenOnWater',
    measure: () => pour(),
    checks: [
      { value: 'liquid', outcome: 'no liquid nitrogen is left after 75 s', target: [0, 0] },
      { value: 'ice', outcome: `the water freezes some ice, at most 0.78 cells per nitrogen cell (${MAX_ICE} of ${N})`, target: [1, MAX_ICE] },
      { value: 'gasAbove', outcome: 'all the nitrogen gas lies over the water', target: [1, 1] },
    ],
    timeout: 120_000,
  });

  // Liquid nitrogen that conducts a tenth as well heats too slowly to boil off or to freeze any ice in the time.
  control({
    name: 'nitrogenOnWater',
    wrong: 'liquid nitrogen with a tenth of its conductivity',
    measure: async () => (await pour(ELEMENTS.map((e: ElementDef) => (e.key === 'LIQUID_NITROGEN' ? { ...e, conductivity: e.conductivity! / 10 } : e)))).liquid,
    target: [0, 0],
    timeout: 120_000,
  });
  // Water that freezes for a hundredth of the heat lets the same nitrogen freeze far more than 0.78 cells per cell (a tenth is not enough: the snow the ice cracks into is a loose bed that insulates and holds the count at 96).
  control({
    name: 'nitrogenOnWater',
    wrong: 'water freezing with a hundredth of its latent heat',
    measure: async () => (await pour(ELEMENTS.map((e: ElementDef) => {
      if (e.key === 'WATER') return { ...e, below: { ...e.below!, latent: e.below!.latent! / 100 } };
      // The ice and the snow it cracks into are one water: both melt for a hundredth of the heat.
      if (e.key === 'ICE' || e.key === 'SNOW') return { ...e, above: { ...e.above!, latent: e.above!.latent! / 100 } };
      return e;
    }))).ice,
    target: [1, MAX_ICE],
    timeout: 120_000,
  });
});

describe.skipIf(!device)('thermometer', () => {
  // Experiment: a mercury thermometer, a bulb under a one-cell glass tube, with marks.
  // Target: the mercury's top sits on the mark of its temperature, within one mark.
  // Calculation: mercury's volumetric expansion is 1.8171e-4 per °C at 20 °C (Wikipedia "Mercury (element)": 181.71e-6; 1.81e-4 in
  //   docs/research/volume-changes.md), so the column rises 1.8171e-4 cells per °C for each cell of bulb. One mark per °C takes
  //   1 / 1.8171e-4 = 5,500 bulb cells (74x74), whose mercury takes about six minutes to heat through (estimate). One mark per 5 °C
  //   takes a bulb of 33x33 = 1,089 cells: 1,089 x 1.8171e-4 = 0.198 cells per °C, so one cell per 5.06 °C, heating through in
  //   about a minute (estimate), and 5 °C still puts 4 to 8 marks between 0, 20, 60 and 100 °C (20/5 = 4, 40/5 = 8).
  // Leaves out: a real thermometer's glass expands too (linear 3.3e-6 per °C for borosilicate, 9e-6 for soda-lime), so its mercury
  //   rises 5 to 15% less than mercury alone; the game's glass does not and the marks use mercury alone.
  // Loaded: the whole thermometer loaded at 0, 20, 60 and 100 °C (`thermometer-hot` is the 100 °C one). Bath: at 20 °C, dipped into
  //   a water bath at 60 °C, read after two minutes against the mercury's mean temperature then (the bath cools a few degrees).
  // Control: a test liquid that expands twice as much reads twice as far above the 0 °C mark (not built: the game's mercury does not
  //   expand at all until I22, so no row can take a wrong coefficient).
  // Measure: the highest mercury cell in the tube, against the level the data give for the mercury's temperature, in marks.
  // Waits (I22): a cell is one unit of matter in every state, so the mercury does not swell and its top stays where it started, at
  //   the mark of 20 °C. The companion measures the same error and expects it between 0 and the tube's height.
  const MARK_CELLS = THERMOMETER.bulb ** 2 * THERMOMETER.expansion * THERMOMETER.mark;
  async function marksOff(scene: Scene, bath: boolean, supersteps: number): Promise<number> {
    const layout = thermometerLayout(bath);
    const sim = createSim(scene.width, scene.height, 1, NO_AIR);
    sim.load(scene.fields);
    await runMany(sim, supersteps);
    const cells = await readCells(sim);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    let level = 0;
    while (typeOf(cells[(layout.top + level) * scene.width + layout.tubeX]) === T.MERCURY) level++;
    let sum = 0;
    let n = 0;
    for (let y = layout.interior.y0; y < layout.interior.y1; y++) {
      for (let x = layout.interior.x0; x < layout.interior.x1; x++) {
        sum += effectiveTemp(row$('MERCURY'), temps[y * scene.width + x]);
        n++;
      }
    }
    return Math.abs(level - thermometerLevel(sum / n)) / MARK_CELLS;
  }
  const loaded = async (): Promise<number> => Math.max(...(await Promise.all([0, 20, 60, 100].map((t) => marksOff(thermometer(t), false, 200)))));

  scenario({
    name: 'thermometer',
    version: 'hot',
    measure: async () => ({ marks: await loaded() }),
    checks: [{
      value: 'marks',
      outcome: 'the mercury stands within one mark of its temperature, loaded at 0, 20, 60 and 100 °C',
      target: [0, 1],
      waitsFor: waitsFor('thermometer-hot'),
      companion: [0, THERMOMETER.tubeHeight],
    }],
    timeout: 60_000,
  });
  scenario({
    name: 'thermometer',
    version: 'bath',
    measure: async () => ({ marks: await marksOff(thermometer(THERMOMETER.startTemp, true), true, 28_800) }),
    checks: [{
      value: 'marks',
      outcome: 'the mercury dipped from 20 °C into a 60 °C bath stands within one mark of its temperature after two minutes',
      target: [0, 1],
      waitsFor: waitsFor('thermometer'),
      companion: [0, THERMOMETER.tubeHeight],
    }],
    timeout: 120_000,
  });

  it('M8.1 AC29: puts the mercury at the mark of 20 °C and a mark of wall cells beside the tube for each temperature above the bulb', () => {
    const scene = thermometer();
    const layout = thermometerLayout(false);
    const column = (y: number): number => typeOf(scene.fields.kind[y * scene.width + layout.tubeX]);
    expect(column(layout.top + THERMOMETER.base - 1)).toBe(T.MERCURY);
    expect(column(layout.top + THERMOMETER.base)).toBe(T.EMPTY);
    const marks = Array.from({ length: scene.height }, (_, y) => y).filter((y) => typeOf(scene.fields.kind[y * scene.width + layout.tubeX - 2]) === T.WALL && y >= layout.top);
    expect(marks.map((y) => y - layout.top + 1)).toEqual([4, 12, 20]);
  });
});

describe.skipIf(!device)('M8.1 AC21: wax', () => {
  // Experiment (not a scenario: its bars are not computed from data): a block of wax 6 cells wide and 2 high on a copper plate
  //   held at 100 °C (480 cells of copper hold the heat the wax takes in), and molten wax poured onto a slab of ice.
  // Target: the wax melts and the molten wax spreads wider than the block it started as; molten wax on ice sets into wax.
  async function waxRun(canvas: Canvas, supersteps: number, elements: readonly ElementDef[] = ELEMENTS): Promise<Uint32Array> {
    const sim = createSim(canvas.width, canvas.height, 1, { ...NO_AIR, elements });
    sim.load(canvas.fields);
    await runMany(sim, supersteps);
    return readCells(sim);
  }

  it('melts wax on a plate at 100 °C into molten wax that spreads wider than the block', async () => {
    const width = 60;
    const plate = 12;
    const block = { x0: 27, x1: 33 };
    const canvas = tank(width, WALL + plate + 12);
    canvas.fill(T.COPPER, WALL, width - WALL, WALL, WALL + plate);
    canvas.fillTemp(100, WALL, width - WALL, WALL, WALL + plate);
    canvas.fill(T.WAX, block.x0, block.x1, WALL + plate, WALL + plate + 2);
    const before = countType(canvas.fields.kind, T.WAX);
    const cells = await waxRun(canvas, 12_000);
    expect(countType(cells, T.MOLTEN_WAX), 'the wax on the plate melts').toBeGreaterThan(0);
    expect(countType(cells, T.WAX) + countType(cells, T.MOLTEN_WAX), 'no wax is lost').toBe(before);
    const xs = Array.from(cells).flatMap((c, i) => (typeOf(c) === T.MOLTEN_WAX ? [i % width] : []));
    const span = Math.max(...xs) - Math.min(...xs) + 1;
    expect(span, 'the molten wax is wider than the block it came from').toBeGreaterThan(2 * (block.x1 - block.x0));
  }, 60_000);

  it('sets molten wax poured onto ice into wax', async () => {
    const width = 36;
    const canvas = tank(width, 20);
    canvas.fill(T.ICE, WALL, width - WALL, WALL, WALL + 4);
    canvas.fill(T.MOLTEN_WAX, WALL, width - WALL, WALL + 4, WALL + 6);
    const poured = countType(canvas.fields.kind, T.MOLTEN_WAX);
    // The slab is a cold plate here: hot wax on ice would crack it into snow, which insulates (thermal shock, M8.1k, `quench`).
    const cells = await waxRun(canvas, 20_000, NO_SHOCK_TABLE);
    expect(countType(cells, T.MOLTEN_WAX), 'no molten wax is left').toBe(0);
    expect(countType(cells, T.WAX), 'it all set into wax').toBe(poured);
  }, 60_000);
});
