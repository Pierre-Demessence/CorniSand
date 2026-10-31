import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { PROP_FIELDS, ROW_BYTES, packElements } from '../src/element-table';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, validateElements, type ElementDef } from '../src/elements';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import { Canvas, tank } from '../src/scene-canvas';
import { cell, createSim, device, idleInput, readCells, run, runMany } from './gpu';
import { MELTS, MOLTEN_LIQUIDS, MOLTEN_TABLE, OTHER_MELTS } from './molten-table';

// The melts (M12.14a): each material that melts has a liquid row of its own, which sets back into the material's solid, and
// a cell keeps nothing of what it melted from: its `kind` bits 16-31 stay 0. The table is the default one.

const NO_AIR = { air: false };
const typeOf = (kind: number): number => kind & 0xff;

// A row of cells at the given stored temperatures, run for `supersteps`; the walls in it conduct nothing and never move.
async function row(cells: { kind: number; temp: number }[], supersteps = 1, table: readonly ElementDef[] = MOLTEN_TABLE): Promise<{ kinds: Uint32Array; temps: Float32Array }> {
  const width = cells.length;
  const sim = createSim(width, 1, 1, { elements: table, ...NO_AIR });
  const temp = new Uint32Array(width);
  tempView({ temp }).set(cells.map((c) => c.temp));
  sim.load({ kind: new Uint32Array(cells.map((c) => c.kind)), temp });
  await runMany(sim, supersteps);
  return { kinds: await readCells(sim), temps: tempView({ temp: await sim.fields.read('temp') }) };
}

const wall = { kind: cell(T.WALL), temp: 0 };
const by = (key: string): ElementDef => elementByKey(MOLTEN_TABLE, key);
const id = (key: string): number => by(key).id;

// The stored temperature a melting cell must pass to melt (its `above` plus its latent width), and the one a liquid cell must
// fall under to set (its `below` minus its latent width).
const meltsAbove = (e: ElementDef): number => e.above!.temp + (e.above!.latent ?? 0) / elementHeatCapacity(e);
const setsBelow = (e: ElementDef): number => e.below!.temp - (e.below!.latent ?? 0) / elementHeatCapacity(e);

describe('M12.14a the melts (table)', () => {
  it('the default table is valid, and a melt that starts under the setting point of its liquid is rejected', () => {
    expect(() => validateElements(MOLTEN_TABLE)).not.toThrow();
    // Sand melts at 1,713 °C, over molten glass's 1,400 °C setting point; at 1,300 °C it would melt into a liquid already set.
    const withSand = (temp: number): ElementDef[] => MOLTEN_TABLE.map((e) => (e.key === 'SAND' ? { ...e, above: { ...e.above!, temp } } : e));
    expect(() => validateElements(withSand(1900))).not.toThrow();
    expect(() => validateElements(withSand(1300))).toThrow(/SAND: above\.temp 1300 is outside the range 1400\.\.Infinity of MOLTEN_GLASS/);
  });

  it('gives every material that melts a liquid of its own, one per material, and lists every melt of the table', () => {
    const meltable = ELEMENTS.filter((e: ElementDef) => e.above && elementByKey(ELEMENTS, e.above.becomes).state === 'liquid').map((e: ElementDef) => e.key);
    expect([...meltable].sort()).toEqual([...MELTS.map((m) => m.solid), ...OTHER_MELTS].sort());
    for (const m of MELTS) {
      expect(by(m.solid).above!.becomes, `${m.solid} melts into`).toBe(m.liquid);
      expect(by(m.liquid).below!.becomes, `${m.liquid} sets into`).toBe(m.sets);
      expect(by(m.liquid).state, m.liquid).toBe('liquid');
    }
    expect(MOLTEN_LIQUIDS).toHaveLength(10);
  });

  it('keeps sand, broken glass and glass on one liquid, gravel on basalt\'s, and aerogel on a liquid that sets back into aerogel', () => {
    expect(new Set(['SAND', 'BROKEN_GLASS', 'GLASS'].map((k) => by(k).above!.becomes))).toEqual(new Set(['MOLTEN_GLASS']));
    expect(by('GRAVEL').above!.becomes).toBe('LAVA');
    expect(by('STONE').above!.becomes).toBe('LAVA');
    expect(by('MOLTEN_AEROGEL').below!.becomes).toBe('INSULATION');
    expect(by('MOLTEN_AEROGEL').below!.latent, 'the latent heat it took in').toBe(by('INSULATION').above!.latent);
  });

  it('puts the new liquids at the next IDs, not paintable, and keeps the old rows\' IDs', () => {
    expect(['MOLTEN_ALUMINIUM', 'MOLTEN_COPPER', 'MOLTEN_GOLD', 'MOLTEN_TITANIUM', 'MOLTEN_TUNGSTEN', 'MOLTEN_GLASS', 'MOLTEN_CERAMIC', 'MOLTEN_AEROGEL'].map(id))
      .toEqual([36, 37, 38, 39, 40, 41, 42, 43]);
    expect(id('LAVA')).toBe(11);
    expect(id('MOLTEN_METAL')).toBe(12);
    for (const key of MOLTEN_LIQUIDS) expect(by(key).toolbar, key).toBeUndefined();
  });

  it('M12.14b AC4: puts brick rubble and ceramic shards at IDs 44 and 45, with the shards on the melt of ceramic and the rubble on none', () => {
    expect(['BRICK_RUBBLE', 'CERAMIC_SHARDS'].map(id)).toEqual([44, 45]);
    expect(by('CERAMIC_SHARDS').above, 'the shards melt where ceramic does').toEqual(by('CERAMIC').above);
    expect(by('BRICK_RUBBLE').above, 'brick rubble never melts').toBeUndefined();
    expect(by('BRICK_RUBBLE').below).toBeUndefined();
    expect(by('BRICK').above).toBeUndefined();
    expect(by('BRICK').pressureAbove?.becomes).toBe('BRICK_RUBBLE');
    expect(by('CERAMIC').cracksInto).toBe('CERAMIC_SHARDS');
  });

  it('packs no memory: bits 24-31 of transitions and the padding word are 0 for every row, and the row is still 144 bytes', () => {
    const words = new Uint32Array(packElements(MOLTEN_TABLE));
    const at = (e: ElementDef, field: string): number => words[e.id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field)];
    for (const e of ELEMENTS) {
      expect(at(e, 'transitions') >>> 24, `${e.key} transitions bits 24-31`).toBe(0);
      expect(at(e, 'pad2'), `${e.key} pad2`).toBe(0);
    }
    expect(PROP_FIELDS.some((f) => f.name === 'molten')).toBe(false);
    expect(ROW_BYTES).toBe(144);
    // The transitions are where they were: stone melts into lava, which sets into stone.
    expect(at(by('STONE'), 'transitions') >>> 8 & 0xff).toBe(T.LAVA);
    expect(at(by('LAVA'), 'transitions') & 0xff).toBe(T.STONE);
    expect(at(by('MOLTEN_GLASS'), 'transitions') & 0xff).toBe(T.GLASS);
  });
});

describe.skipIf(!device)('M12.14a AC1: each melt is its own material\'s liquid', () => {
  it.each(MELTS.map((m) => [`${m.solid} melts into ${m.liquid}`, m] as const))('%s, and the liquid sets into the material\'s solid', async (_name, m) => {
    const solid = by(m.solid);
    const liquid = by(m.liquid);
    const short = await row([{ kind: cell(solid.id), temp: meltsAbove(solid) - 1 }, wall]);
    expect(typeOf(short.kinds[0]), `${m.solid} just under the end of its latent range`).toBe(solid.id);
    const past = await row([{ kind: cell(solid.id), temp: meltsAbove(solid) + 1 }, wall]);
    expect(past.kinds[0], `${m.solid} just past it: the liquid, nothing in the bits above`).toBe(cell(liquid.id));

    const stays = await row([{ kind: cell(liquid.id), temp: setsBelow(liquid) + 1 }, wall]);
    expect(typeOf(stays.kinds[0]), `${m.liquid} just over its setting point`).toBe(liquid.id);
    const set = await row([{ kind: cell(liquid.id), temp: setsBelow(liquid) - 1 }, wall]);
    expect(set.kinds[0], `${m.liquid} just under it: ${m.sets}`).toBe(cell(id(m.sets)));
    // It starts at the threshold less the overshoot scaled by the two capacities, so it holds the heat it had.
    expect(set.temps[0], `${m.liquid} stored temperature`).toBeCloseTo(liquid.below!.temp - (elementHeatCapacity(liquid) / elementHeatCapacity(by(m.sets))), 2);
  });

  it('M12.14b AC4: brick rubble stays brick rubble at 3,000 °C over 100 supersteps, and the shards of a cracked ceramic melt into molten ceramic that sets into ceramic', async () => {
    const hot = await row([{ kind: cell(T.BRICK_RUBBLE), temp: 3000 }, wall], 100);
    expect(hot.kinds[0], 'brick rubble').toBe(cell(T.BRICK_RUBBLE));
    const shards = by('CERAMIC_SHARDS');
    const molten = await row([{ kind: cell(shards.id), temp: meltsAbove(shards) + 10 }, wall]);
    expect(molten.kinds[0]).toBe(cell(T.MOLTEN_CERAMIC));
    const set = await row([{ kind: molten.kinds[0], temp: setsBelow(by('MOLTEN_CERAMIC')) - 5 }, wall]);
    expect(set.kinds[0], 'the liquid sets into ceramic, not shards').toBe(cell(T.CERAMIC));
  });

  it('sand melts into molten glass that sets into glass, not sand: the full round trip through the table', async () => {
    const sand = by('SAND');
    const molten = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) + 10 }, wall]);
    expect(molten.kinds[0]).toBe(cell(T.MOLTEN_GLASS));
    const set = await row([{ kind: molten.kinds[0], temp: setsBelow(by('MOLTEN_GLASS')) - 5 }, wall]);
    expect(set.kinds[0]).toBe(cell(T.GLASS));
  });

  it('aerogel melts into molten aerogel that sets back into aerogel', async () => {
    const aerogel = by('INSULATION');
    const molten = await row([{ kind: cell(aerogel.id), temp: meltsAbove(aerogel) + 10 }, wall]);
    expect(molten.kinds[0]).toBe(cell(T.MOLTEN_AEROGEL));
    const set = await row([{ kind: molten.kinds[0], temp: setsBelow(by('MOLTEN_AEROGEL')) - 5 }, wall]);
    expect(set.kinds[0]).toBe(cell(aerogel.id));
  });

  it('a liquid keeps its temperature at its own setting point while it gives out its latent heat', async () => {
    // Stored at 1,350 °C, molten glass is under its 1,400 °C setting point but not yet set (it sets under about 1,310): its
    // temperature is 1,400 and the lava's, which sets at 1,200, is 1,350.
    expect(by('MOLTEN_GLASS').below!.temp).toBe(1400);
    const sim = createSim(2, 1, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    const temp = new Uint32Array(2);
    tempView({ temp }).set([1350, 1350]);
    // Two liquid cells side by side exchange heat at their (clamped) temperatures: 1,400 against 1,350 moves heat from the
    // molten glass into the lava, which 1,350 against 1,350 would not.
    sim.load({ kind: new Uint32Array([cell(T.MOLTEN_GLASS), cell(T.LAVA)]), temp });
    await run(sim, 1);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    expect(temps[0], 'the molten glass gave heat').toBeLessThan(1350);
    expect(temps[1], 'the lava took it').toBeGreaterThan(1350);
  });
});

describe.skipIf(!device)('M12.14a AC2: no cell holds anything above its type and variant', () => {
  it('melting and setting every meltable row leaves bits 16-31 of every cell at 0, variants kept', async () => {
    const solids = [...new Set(MELTS.map((m) => m.solid))];
    const melted = await row(solids.flatMap((key) => [{ kind: cell(id(key), 7), temp: meltsAbove(by(key)) + 5 }, wall]), 3);
    solids.forEach((key, i) => {
      const liquid = MELTS.find((m) => m.solid === key)!.liquid;
      expect(melted.kinds[2 * i], `${key} melted`).toBe(cell(id(liquid), 7));
    });
    const liquids = MOLTEN_LIQUIDS;
    const set = await row(liquids.flatMap((key) => [{ kind: cell(id(key), 9), temp: setsBelow(by(key)) - 5 }, wall]), 3);
    liquids.forEach((key, i) => {
      const sets = MELTS.find((m) => m.liquid === key)!.sets;
      expect(set.kinds[2 * i], `${key} set`).toBe(cell(id(sets), 9));
    });
    for (const kinds of [melted.kinds, set.kinds]) kinds.forEach((k, i) => expect(k >>> 16, `cell ${i}`).toBe(0));
  });

  it('a hot mixed box of every row, run for 1,000 supersteps, ends with bits 16-31 at 0 in the grid and the flyers', async () => {
    const width = 48;
    const height = 40;
    const sim = createSim(width, height, 5, { elements: MOLTEN_TABLE, ...NO_AIR });
    const canvas = new Canvas(width, height);
    canvas.fill(T.WALL, 0, width, 0, 2);
    ELEMENTS.filter((e: ElementDef) => e.state !== 'empty' && e.key !== 'WALL' && e.key !== 'FIRE').forEach((e: ElementDef, i: number) => {
      const x0 = 2 + (i % 11) * 4;
      const y0 = 4 + Math.floor(i / 11) * 4;
      canvas.fill(e.id, x0, x0 + 3, y0, y0 + 3);
      canvas.fillTemp(e.above ? e.above.temp + 2 * (e.above.latent ?? 0) / elementHeatCapacity(e) + 20 : e.below ? e.below.temp - 100 : 20, x0, x0 + 3, y0, y0 + 3);
    });
    sim.load(canvas.fields);
    for (let i = 0; i < 4; i++) {
      await runMany(sim, 250);
      (await readCells(sim)).forEach((k, c) => { if (k >>> 16 !== 0) throw new Error(`cell ${c} holds ${k.toString(16)} after ${(i + 1) * 250} supersteps`); });
      for (const f of await sim.flyers.read()) expect(f.cell.kind >>> 16, 'a flyer').toBe(0);
    }
  }, 60_000);
});

// A tank of two molten layers, as a canvas: `lower` on the bottom, `upper` over it, both at 1,700 °C.
function twoLayers(upper: number, lower: number): Canvas {
  const width = 12;
  const canvas = tank(width, 20);
  canvas.fill(lower, 2, width - 2, 2, 6);
  canvas.fill(upper, 2, width - 2, 6, 10);
  canvas.fillTemp(1700, 2, width - 2, 2, 10);
  return canvas;
}

// The mean height of the cells of this type.
function meanHeight(kinds: Uint32Array, width: number, type: number): number {
  let sum = 0;
  let n = 0;
  kinds.forEach((k, i) => {
    if (typeOf(k) === type) {
      sum += Math.floor(i / width);
      n++;
    }
  });
  return sum / n;
}

describe.skipIf(!device)('M12.14a AC11: a liquid moves by the density of its own row', () => {
  const width = 12;

  it('molten gold sinks under molten steel', async () => {
    const canvas = twoLayers(T.MOLTEN_GOLD, T.MOLTEN_METAL);
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    const before = await readCells(sim);
    expect(meanHeight(before, width, T.MOLTEN_GOLD), 'gold starts on top').toBeGreaterThan(meanHeight(before, width, T.MOLTEN_METAL));
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(after.filter((k) => typeOf(k) === T.MOLTEN_GOLD).length, 'no gold cell lost or changed').toBe(before.filter((k) => typeOf(k) === T.MOLTEN_GOLD).length);
    // Measured: gold mean height 3.5 (the bottom four rows), steel 7.5.
    expect(meanHeight(after, width, T.MOLTEN_GOLD), 'gold ends under the steel').toBeLessThan(meanHeight(after, width, T.MOLTEN_METAL) - 2);
  }, 60_000);

  it('control: molten steel over molten gold stays on top', async () => {
    const canvas = twoLayers(T.MOLTEN_METAL, T.MOLTEN_GOLD);
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    const before = meanHeight(await readCells(sim), width, T.MOLTEN_METAL);
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(meanHeight(after, width, T.MOLTEN_METAL), 'the steel layer stays on top').toBeGreaterThanOrEqual(before - 0.5);
    expect(meanHeight(after, width, T.MOLTEN_METAL)).toBeGreaterThan(meanHeight(after, width, T.MOLTEN_GOLD) + 2);
  }, 60_000);

  it('molten steel over molten aluminium sinks through it (7,000 against 2,375)', async () => {
    const canvas = twoLayers(T.MOLTEN_METAL, T.MOLTEN_ALUMINIUM);
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(meanHeight(after, width, T.MOLTEN_METAL), 'steel ends under the aluminium').toBeLessThan(meanHeight(after, width, T.MOLTEN_ALUMINIUM) - 2);
  }, 60_000);
});

describe.skipIf(!device)('M12.14a AC8: a liquid keeps its row', () => {
  const width = 16;
  const height = 200;

  function drop(): { canvas: Canvas; count: number } {
    const canvas = new Canvas(width, height);
    canvas.fill(T.MOLTEN_GOLD, 4, 8, 150, 154);
    canvas.fill(T.WALL, 0, width, 0, 2);
    canvas.fillTemp(1700, 4, 8, 150, 154);
    return { canvas, count: 16 };
  }

  it('through falling, flight, landing, spreading and conduction', async () => {
    const { canvas, count } = drop();
    const sim = createSim(width, height, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    let flew = false;
    for (let step = 0; step < 12; step++) {
      await runMany(sim, 25);
      const kinds = await readCells(sim);
      const flyers = await sim.flyers.read();
      if (flyers.length > 0) flew = true;
      for (const f of flyers) expect(f.cell.kind & 0xff, 'a flyer carries the whole kind word').toBe(T.MOLTEN_GOLD);
      for (const f of flyers) expect(f.cell.kind >>> 16, 'a flyer carries nothing above the variant').toBe(0);
      const molten = kinds.filter((k) => typeOf(k) === T.MOLTEN_GOLD);
      expect(molten.every((k) => k >>> 16 === 0), `after ${(step + 1) * 25} supersteps every molten cell holds nothing above the variant`).toBe(true);
      expect(molten.length + flyers.length, 'no cell lost').toBe(count);
    }
    expect(flew, 'the cells reached the speed that launches them').toBe(true);
    // They are down and spread out on the floor.
    const kinds = await readCells(sim);
    const rows = new Set<number>();
    kinds.forEach((k, i) => { if (typeOf(k) === T.MOLTEN_GOLD) rows.add(Math.floor(i / width)); });
    expect(Math.max(...rows), 'all of them came down').toBeLessThan(10);
  }, 60_000);

  it('through the Heat tool, which writes the temperature with withTemp', async () => {
    const { canvas } = drop();
    const sim = createSim(width, height, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    await run(sim, 0, { ...idleInput, mouseActive: true, brushSize: 2000, mousePos: { x: 6, y: 152 }, prevMousePos: { x: 6, y: 152 }, heating: 17 });
    const kinds = await readCells(sim);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    let molten = 0;
    kinds.forEach((k, i) => {
      if (typeOf(k) !== T.MOLTEN_GOLD) return;
      molten++;
      expect(temps[i], `cell ${i} was heated`).toBe(1717);
    });
    expect(molten).toBe(16);
  });

  it('a new element keeps the variant: molten gold that sets is gold with its variant', async () => {
    const set = await row([{ kind: cell(T.MOLTEN_GOLD, 5), temp: setsBelow(by('MOLTEN_GOLD')) - 10 }, wall]);
    expect(set.kinds[0]).toBe(cell(T.GOLD, 5));
  });
});

// M12.14d AC9: each liquid carries its own data. The specific heat (kJ/kg·K) the row's capacity per cell was worked out from,
// at the row's own density (a cell is one unit of matter): a drift of a row's density or capacity from it shows here.
const SPECIFIC_HEAT: Record<string, number> = {
  MOLTEN_ALUMINIUM: 1.18,
  MOLTEN_COPPER: 0.494,
  MOLTEN_GOLD: 0.149,
  MOLTEN_TITANIUM: 0.703,
  MOLTEN_TUNGSTEN: 0.279,
  MOLTEN_GLASS: 1.45,
  MOLTEN_CERAMIC: 1.89,
  MOLTEN_AEROGEL: 1.38,
};

describe('M12.14d AC9: the data of each melt', () => {
  it('gives each new liquid the density of the melt, not that of its solid, and a capacity from its own specific heat', () => {
    for (const [key, cp] of Object.entries(SPECIFIC_HEAT)) {
      const liquid = by(key);
      const solid = by(MELTS.find((m) => m.liquid === key && m.solid !== 'SAND' && m.solid !== 'BROKEN_GLASS' && m.solid !== 'CERAMIC_SHARDS' && m.solid !== 'GRAVEL')!.solid);
      expect(liquid.heatCapacity! / (liquid.density / 1000), `${key} capacity over density, kJ/kg·K`).toBeCloseTo(cp, 1);
      if (key !== 'MOLTEN_AEROGEL') expect(liquid.density, `${key} against its solid`).toBeLessThan(solid.density);
      expect(liquid.densityKnots![0][0], `${key} first knot is its melting point`).toBe(liquid.below!.temp);
      expect(liquid.densityKnots![0][1], `${key} density at the melting point`).toBe(liquid.density);
    }
    // The figures of the sources read: Wikipedia's densities of the liquid at the melting point, Tolias's tungsten, the levitation
    // fit of molten alumina at 2,345 K (2.917 - 1.228e-4 (T - 2,327) g/cm³).
    expect(by('MOLTEN_ALUMINIUM').density).toBe(2375);
    expect(by('MOLTEN_COPPER').density).toBe(8020);
    expect(by('MOLTEN_GOLD').density).toBe(17310);
    expect(by('MOLTEN_TITANIUM').density).toBe(4110);
    expect(by('MOLTEN_TUNGSTEN').density).toBe(16267);
    expect(by('MOLTEN_CERAMIC').density).toBeCloseTo(2917 - 0.1228 * (2345 - 2327), -1);
    expect(by('MOLTEN_COPPER').viscosity, 'Assael et al. 2010, 4 mPa·s').toBe(0.004);
    expect(by('MOLTEN_CERAMIC').viscosity, '0.577 exp(9743 / 2345 K) mPa·s').toBeCloseTo(0.577e-3 * Math.exp(9743 / 2345), 3);
  });

  it('orders the viscosities as the materials are: alumina runs freely, metals thin, glass and lava thick, silica a paste', () => {
    const v = (key: string): number => by(key).viscosity!;
    expect(v('MOLTEN_CERAMIC')).toBeLessThan(0.1);
    expect(v('MOLTEN_ALUMINIUM')).toBeLessThan(v('MOLTEN_COPPER'));
    expect(v('MOLTEN_TUNGSTEN')).toBeLessThan(0.02);
    expect(v('MOLTEN_GLASS')).toBeGreaterThan(v('MOLTEN_METAL') * 1000);
    expect(v('MOLTEN_GLASS')).toBeLessThan(v('LAVA'));
    expect(v('MOLTEN_AEROGEL')).toBeGreaterThan(v('LAVA') * 1e4);
  });
});

// A sealed one-row bar of a liquid, 40 cells, the left half 200 K over its setting point and the right half 100 K: the difference
// between the halves falls as exp(-t / tau), tau = L² / (pi² alpha) with the row's own conductivity and capacity, sampled half and
// one and a half expected time constants in, as `metalBars` does for the solids.
describe.skipIf(!device)('M12.14d AC9: heat crosses a bar of each molten metal at the pace of its own data', () => {
  const cells = 40;
  async function tauOverData(key: string, table: readonly ElementDef[] = MOLTEN_TABLE): Promise<number> {
    const row = by(key);
    const diffusivity = elementConductivity(row) / (elementHeatCapacity(row) * HEAT_UNIT);
    const expected = (cells * CELL_SIZE) ** 2 / (Math.PI ** 2 * diffusivity);
    const canvas = new Canvas(cells, 1);
    canvas.fill(row.id, 0, cells, 0, 1);
    canvas.fillTemp(row.below!.temp + 100, 0, cells, 0, 1);
    canvas.fillTemp(row.below!.temp + 200, 0, cells / 2, 0, 1);
    const sim = createSim(cells, 1, 1, { elements: table, ...NO_AIR });
    sim.load(canvas.fields);
    const difference = async (): Promise<number> => {
      const t = tempView({ temp: await sim.fields.read('temp') });
      let left = 0;
      let right = 0;
      for (let x = 0; x < cells / 2; x++) {
        left += t[x];
        right += t[cells - 1 - x];
      }
      return (left - right) / (cells / 2);
    };
    const supersteps = (seconds: number): number => Math.round(seconds / PAIR_TIME);
    await runMany(sim, supersteps(0.5 * expected));
    const first = await difference();
    await runMany(sim, supersteps(expected));
    const second = await difference();
    // The samples are one expected time constant apart, so the decay between them is exp(-expected / tau).
    return 1 / Math.log(first / second);
  }

  // A bar whose pair share (PAIR_TIME alpha / CELL_SIZE²) is over 0.15 relaxes too fast by the two sweeps of a block (backlog D40);
  // none of the liquids reaches it: aluminium, the best conductor, is at about 0.09.
  it.each(['MOLTEN_METAL', 'MOLTEN_ALUMINIUM', 'MOLTEN_COPPER', 'MOLTEN_GOLD', 'MOLTEN_TITANIUM', 'MOLTEN_TUNGSTEN'])('%s: the time constant is that of its data within 15%%', async (key) => {
    const row = by(key);
    const share = (PAIR_TIME * elementConductivity(row)) / (elementHeatCapacity(row) * HEAT_UNIT * CELL_SIZE ** 2);
    expect(share, `${key} pair share`).toBeLessThan(0.15);
    const ratio = await tauOverData(key);
    expect(ratio, `${key} measured time constant over its data's`).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  }, 60_000);

  // Control: molten copper at half its conductivity relaxes at about half the speed its data give, outside the 15%.
  it('control: molten copper at half its conductivity misses the time constant of its data', async () => {
    const halved = MOLTEN_TABLE.map((e) => (e.key === 'MOLTEN_COPPER' ? { ...e, conductivity: elementConductivity(e) / 2 } : e));
    const ratio = await tauOverData('MOLTEN_COPPER', halved);
    expect(ratio).toBeGreaterThan(1.5);
  }, 60_000);
});
