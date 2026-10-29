import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { PROP_FIELDS, packElements } from '../src/element-table';
import { ELEMENT as T, ELEMENTS, elementByKey, elementHeatCapacity, validateElements, type ElementDef } from '../src/elements';
import { Canvas, tank } from '../src/scene-canvas';
import { cell, createSim, device, idleInput, readCells, run, runMany } from './gpu';
import { GLASS, GLASS_ABOVE, GOLD, MOLTEN_TABLE } from './molten-table';

// Molten memory (M8.1d): a molten cell carries the element it sets into (its ctype, `kind` bits 16-23). The table is the
// default one plus a few solids that melt into its molten elements (tests/molten-table.ts).

const NO_AIR = { air: false };
const ctypeOf = (kind: number): number => (kind >>> 16) & 0xff;
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
const lava = elementByKey(MOLTEN_TABLE, 'LAVA');
const metal = elementByKey(MOLTEN_TABLE, 'METAL');
const gold = elementByKey(MOLTEN_TABLE, 'GOLD');
const sand = elementByKey(MOLTEN_TABLE, 'SAND');
const glass = elementByKey(MOLTEN_TABLE, 'GLASS');
const moltenMetal = elementByKey(MOLTEN_TABLE, 'MOLTEN_METAL');

// The stored temperature a melting cell must pass to melt (its `above` plus its latent width), and the one a molten cell
// with ctype k must fall under to set (k's `above` minus k's latent heat over the molten element's capacity).
const meltsAbove = (e: ElementDef): number => e.above!.temp + (e.above!.latent ?? 0) / elementHeatCapacity(e);
const setsBelow = (k: ElementDef, molten: ElementDef): number => k.above!.temp - (k.above!.latent ?? 0) / elementHeatCapacity(molten);

describe('M8.1 molten rows (table)', () => {
  it('the test table is valid, and so is the default one', () => {
    expect(() => validateElements(MOLTEN_TABLE)).not.toThrow();
    expect(() => validateElements(ELEMENTS)).not.toThrow();
  });

  it('a molten element needs a below', () => {
    const table = MOLTEN_TABLE.map((e) => (e.key === 'LAVA' ? { ...e, below: undefined } : e));
    expect(() => validateElements(table)).toThrow(/LAVA.*molten element needs a below/);
  });

  it('setsInto belongs to an above into a molten element, to an element with an above into the same one, at or under this temperature', () => {
    const withSand = (above: ElementDef['above']): ElementDef[] => MOLTEN_TABLE.map((e) => (e.key === 'SAND' ? { ...e, above } : e));
    expect(() => validateElements(withSand({ temp: 1713, becomes: 'LAVA', latent: 800, setsInto: 'NOPE' }))).toThrow(/setsInto "NOPE" is not in the table/);
    expect(() => validateElements(withSand({ temp: 1713, becomes: 'LAVA', latent: 800, setsInto: 'WATER' }))).toThrow(/WATER \(setsInto\) needs an above into LAVA/);
    expect(() => validateElements(withSand({ temp: 1713, becomes: 'LAVA', latent: 800, setsInto: 'GOLD' }))).toThrow(/GOLD \(setsInto\) needs an above into LAVA/);
    expect(() => validateElements(withSand({ temp: 1600, becomes: 'LAVA', latent: 800, setsInto: 'GLASS' }))).toThrow(/under the 1713 of GLASS/);
    expect(() => validateElements(withSand({ temp: 1900, becomes: 'LAVA', latent: 800, setsInto: 'GLASS' }))).not.toThrow();
    // Not on a below, and not on an above into an element that is not molten.
    const water = MOLTEN_TABLE.map((e) => (e.key === 'WATER' ? { ...e, above: { ...e.above!, setsInto: 'WATER' } } : e));
    expect(() => validateElements(water)).toThrow(/WATER: above\.setsInto is only for an above into a molten element/);
    const below = MOLTEN_TABLE.map((e) => (e.key === 'LAVA' ? { ...e, below: { ...e.below!, setsInto: 'STONE' } } : e));
    expect(() => validateElements(below)).toThrow(/LAVA: below\.setsInto is only for an above into a molten element/);
  });

  it('a row that melts into a molten element is not held to that element\'s own range', () => {
    // Gold melts at 1,064 °C, under MOLTEN_METAL's own setting point of 1,538 °C.
    expect(gold.above!.temp).toBeLessThan(moltenMetal.below!.temp);
    expect(() => validateElements(MOLTEN_TABLE)).not.toThrow();
  });

  it('packs the ctype a melting row gives (bits 24-31 of transitions) and the molten flag', () => {
    const words = new Uint32Array(packElements(MOLTEN_TABLE));
    const at = (e: ElementDef, field: string): number => words[e.id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field)];
    const ctype = (e: ElementDef): number => at(e, 'transitions') >>> 24;
    expect(ctype(elementByKey(MOLTEN_TABLE, 'STONE')), 'stone sets into stone').toBe(T.STONE);
    expect(ctype(metal), 'steel sets into steel').toBe(T.METAL);
    expect(ctype(sand), 'sand sets into glass').toBe(GLASS);
    expect(ctype(glass)).toBe(GLASS);
    expect(ctype(gold)).toBe(GOLD);
    expect(ctype(elementByKey(MOLTEN_TABLE, 'WATER')), 'water boils into steam, which is not molten').toBe(0);
    expect(ctype(lava), 'lava has no above').toBe(0);
    expect(at(lava, 'molten')).toBe(1);
    expect(at(moltenMetal, 'molten')).toBe(1);
    expect(at(elementByKey(MOLTEN_TABLE, 'WATER'), 'molten')).toBe(0);
    // The other transitions are still where they were.
    expect(at(elementByKey(MOLTEN_TABLE, 'STONE'), 'transitions') >>> 8 & 0xff).toBe(T.LAVA);
    expect(at(lava, 'transitions') & 0xff).toBe(T.STONE);
  });
});

describe.skipIf(!device)('M8.1 AC9: a molten cell sets into the element it remembers', () => {
  it('a cell passing an above into a molten element gets its setsInto as ctype, by default its own element', async () => {
    const cases: [string, ElementDef, number][] = [
      ['stone', elementByKey(MOLTEN_TABLE, 'STONE'), T.STONE],
      ['steel', metal, T.METAL],
      ['sand', sand, GLASS],
      ['glass', glass, GLASS],
      ['gold', gold, GOLD],
    ];
    for (const [name, e, ctype] of cases) {
      const below = await row([{ kind: cell(e.id), temp: meltsAbove(e) - 1 }, wall]);
      expect(typeOf(below.kinds[0]), `${name} just under the top of its latent range`).toBe(e.id);
      expect(ctypeOf(below.kinds[0]), `${name} that has not melted`).toBe(0);
      const past = await row([{ kind: cell(e.id), temp: meltsAbove(e) + 1 }, wall]);
      expect(typeOf(past.kinds[0]), `${name} just past it`).toBe(e.above!.becomes === 'LAVA' ? T.LAVA : T.MOLTEN_METAL);
      expect(ctypeOf(past.kinds[0]), `${name} melted`).toBe(ctype);
    }
  });

  it('a molten cell with ctype k sets into k below k\'s above temperature by k\'s latent heat over the molten capacity, and the ctype clears', async () => {
    const cases: [string, ElementDef, ElementDef, ElementDef][] = [
      ['glass in lava', glass, lava, glass],
      ['gold in molten steel', gold, moltenMetal, gold],
      ['steel in molten steel', metal, moltenMetal, metal],
      ['stone in lava', elementByKey(MOLTEN_TABLE, 'STONE'), lava, elementByKey(MOLTEN_TABLE, 'STONE')],
    ];
    for (const [name, k, molten, sets] of cases) {
      const limit = setsBelow(k, molten);
      const stays = await row([{ kind: cell(molten.id, 0, k.id), temp: limit + 1 }, wall]);
      expect(typeOf(stays.kinds[0]), `${name} just over ${limit}`).toBe(molten.id);
      expect(ctypeOf(stays.kinds[0]), name).toBe(k.id);
      const sets1 = await row([{ kind: cell(molten.id, 0, k.id), temp: limit - 1 }, wall]);
      expect(typeOf(sets1.kinds[0]), `${name} just under ${limit}`).toBe(sets.id);
      expect(ctypeOf(sets1.kinds[0]), `${name} set, the ctype is gone`).toBe(0);
      // It starts at the threshold less the overshoot scaled by the two capacities, so it holds the heat it had.
      expect(sets1.temps[0], `${name} stored temperature`).toBeCloseTo(k.above!.temp - (elementHeatCapacity(molten) / elementHeatCapacity(k)), 2);
    }
  });

  it('a molten cell without a ctype sets into its own below, as lava always did', async () => {
    const limit = lava.below!.temp - lava.below!.latent! / elementHeatCapacity(lava);
    expect(typeOf((await row([{ kind: cell(T.LAVA), temp: limit + 1 }, wall])).kinds[0])).toBe(T.LAVA);
    const set = await row([{ kind: cell(T.LAVA), temp: limit - 1 }, wall]);
    expect(typeOf(set.kinds[0])).toBe(T.STONE);
    expect(ctypeOf(set.kinds[0])).toBe(0);
    const steel = moltenMetal.below!.temp - moltenMetal.below!.latent! / elementHeatCapacity(moltenMetal);
    expect(typeOf((await row([{ kind: cell(T.MOLTEN_METAL), temp: steel - 1 }, wall])).kinds[0])).toBe(T.METAL);
  });

  it('a ctype that names no row melting into this element is read as none', async () => {
    const limit = lava.below!.temp - lava.below!.latent! / elementHeatCapacity(lava);
    // Water and gold (which melts into molten steel, not lava) are no melt of lava: it sets by its own below.
    for (const bogus of [T.WATER, GOLD, T.LAVA, 200]) {
      expect(typeOf((await row([{ kind: cell(T.LAVA, 0, bogus), temp: limit + 1 }, wall])).kinds[0]), `ctype ${bogus} over the limit`).toBe(T.LAVA);
      expect(typeOf((await row([{ kind: cell(T.LAVA, 0, bogus), temp: limit - 1 }, wall])).kinds[0]), `ctype ${bogus} under the limit`).toBe(T.STONE);
    }
  });

  it('sand melts into lava that sets into glass: the full round trip through the table', async () => {
    const molten = await row([{ kind: cell(T.SAND), temp: meltsAbove(sand) + 10 }, wall]);
    expect(typeOf(molten.kinds[0])).toBe(T.LAVA);
    expect(ctypeOf(molten.kinds[0])).toBe(GLASS);
    // Cooled under glass's setting point, it is glass, not sand.
    const set = await row([{ kind: molten.kinds[0], temp: setsBelow(glass, lava) - 5 }, wall]);
    expect(typeOf(set.kinds[0])).toBe(GLASS);
    expect(ctypeOf(set.kinds[0])).toBe(0);
  });

  it('a molten cell keeps its temperature at its ctype\'s threshold while it gives out its latent heat', async () => {
    // Stored at 1,600 °C, glass's lava is under its 1,713 °C setting point: its temperature is 1,713 and the plain lava's is 1,600.
    const glassLava = cell(T.LAVA, 0, GLASS);
    expect(GLASS_ABOVE.temp).toBe(1713);
    const sim = createSim(2, 1, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    const temp = new Uint32Array(2);
    tempView({ temp }).set([1600, 1600]);
    // Two liquid cells side by side exchange heat at their (clamped) temperatures: 1,713 against 1,600 moves heat from the
    // glass's lava into the plain one, which a plain 1,600 against 1,600 would not.
    sim.load({ kind: new Uint32Array([glassLava, cell(T.LAVA)]), temp });
    await run(sim, 1);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    expect(temps[0], 'the glass lava gave heat').toBeLessThan(1600);
    expect(temps[1], 'the plain lava took it').toBeGreaterThan(1600);
  });
});

// A tank of molten metal: gold (or steel) above a layer of steel (or gold), as a canvas.
function twoLayers(upper: { ctype: number }, lower: { ctype: number }): Canvas {
  const width = 12;
  const canvas = tank(width, 20);
  canvas.fill(T.MOLTEN_METAL, 2, width - 2, 2, 6, lower.ctype);
  canvas.fill(T.MOLTEN_METAL, 2, width - 2, 6, 10, upper.ctype);
  canvas.fillTemp(1700, 2, width - 2, 2, 10);
  return canvas;
}

// The mean height of the molten cells with this ctype.
function meanHeight(kinds: Uint32Array, width: number, ctype: number): number {
  let sum = 0;
  let n = 0;
  kinds.forEach((k, i) => {
    if (typeOf(k) === T.MOLTEN_METAL && ctypeOf(k) === ctype) {
      sum += Math.floor(i / width);
      n++;
    }
  });
  return sum / n;
}

describe.skipIf(!device)('M8.1 AC11: a molten cell moves by the density of its ctype', () => {
  const width = 12;

  it('molten gold sinks under molten steel', async () => {
    const canvas = twoLayers({ ctype: GOLD }, { ctype: T.METAL });
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    const before = await readCells(sim);
    expect(meanHeight(before, width, GOLD), 'gold starts on top').toBeGreaterThan(meanHeight(before, width, T.METAL));
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(after.filter((k) => ctypeOf(k) === GOLD).length, 'no gold cell lost or changed').toBe(before.filter((k) => ctypeOf(k) === GOLD).length);
    // Measured: gold mean height 3.5 (the bottom four rows), steel 7.5.
    expect(meanHeight(after, width, GOLD), 'gold ends under the steel').toBeLessThan(meanHeight(after, width, T.METAL) - 2);
  }, 60_000);

  it('control: with ctype 0 the cell has its row\'s density (7,000), lighter than steel\'s 7,870, so it stays on top', async () => {
    const canvas = twoLayers({ ctype: 0 }, { ctype: T.METAL });
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    const before = meanHeight(await readCells(sim), width, 0);
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(meanHeight(after, width, 0), 'the ctype 0 layer stays on top').toBeGreaterThanOrEqual(before - 0.5);
    expect(meanHeight(after, width, 0)).toBeGreaterThan(meanHeight(after, width, T.METAL) + 2);
  }, 60_000);

  it('control: steel over ctype 0 sinks through it (7,870 against 7,000)', async () => {
    const canvas = twoLayers({ ctype: T.METAL }, { ctype: 0 });
    const sim = createSim(width, 20, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    await runMany(sim, 1500);
    const after = await readCells(sim);
    expect(meanHeight(after, width, T.METAL), 'steel ends under the plain layer').toBeLessThan(meanHeight(after, width, 0) - 2);
  }, 60_000);
});

describe.skipIf(!device)('M8.1 AC8: a cell keeps its ctype', () => {
  const width = 16;
  const height = 200;

  function drop(): { canvas: Canvas; count: number } {
    const canvas = new Canvas(width, height);
    canvas.fill(T.MOLTEN_METAL, 4, 8, 150, 154, GOLD);
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
      for (const f of flyers) expect(f.cell.kind, 'a flyer carries the whole kind word').toBe(cell(typeOf(f.cell.kind), (f.cell.kind >>> 8) & 0xff, GOLD));
      const molten = kinds.filter((k) => typeOf(k) === T.MOLTEN_METAL);
      expect(molten.every((k) => ctypeOf(k) === GOLD), `after ${(step + 1) * 25} supersteps every molten cell is gold's`).toBe(true);
      expect(molten.length + flyers.length, 'no cell lost').toBe(count);
    }
    expect(flew, 'the cells reached the speed that launches them').toBe(true);
    // They are down and spread out on the floor.
    const kinds = await readCells(sim);
    const rows = new Set<number>();
    kinds.forEach((k, i) => { if (typeOf(k) === T.MOLTEN_METAL) rows.add(Math.floor(i / width)); });
    expect(Math.max(...rows), 'all of them came down').toBeLessThan(10);
  }, 60_000);

  it('through the Heat tool, which writes the temperature with withTemp', async () => {
    const { canvas } = drop();
    const sim = createSim(width, height, 1, { elements: MOLTEN_TABLE, ...NO_AIR });
    sim.load(canvas.fields);
    await run(sim, 0, { ...idleInput, mouseActive: true, brushSize: 2000, mousePos: { x: 6, y: 152 }, prevMousePos: { x: 6, y: 152 }, heating: 17 });
    const kinds = await readCells(sim);
    const temps = tempView({ temp: await sim.fields.read('temp') });
    kinds.forEach((k, i) => {
      if (typeOf(k) !== T.MOLTEN_METAL) return;
      expect(ctypeOf(k), `cell ${i}`).toBe(GOLD);
      expect(temps[i], `cell ${i} was heated`).toBe(1717);
    });
  });

  it('a new element clears it: gold that sets is gold with no ctype and keeps its variant', async () => {
    const set = await row([{ kind: cell(T.MOLTEN_METAL, 5, GOLD), temp: setsBelow(gold, moltenMetal) - 10 }, wall]);
    expect(set.kinds[0]).toBe(cell(GOLD, 5));
  });
});
