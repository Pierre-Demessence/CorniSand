import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, cellName, elementByKey, elementHeatCapacity, validateElements, type ElementDef } from '../src/elements';
import { cell, createSim, device, readCells, runMany } from './gpu';

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
