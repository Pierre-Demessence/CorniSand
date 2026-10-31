import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import {
  ELEMENT as T, ELEMENTS, GLASS_QUENCH, crackTarget, elementByKey, elementHoldsHeat, shockLimit, validateElements, type ElementDef,
} from '../src/elements';
import { PROP_FIELDS, ROW_BYTES, packElements } from '../src/element-table';
import { CRUCIBLE } from '../src/scenarios';
import { Canvas, WALL, tank } from '../src/scene-canvas';
import { cell, createSim, device, readCells, runMany } from './gpu';
import { countType, heatContent } from './metrics';

// Thermal shock (M8.1k): a solid cracks into its broken form when a neighbor in its block is further from its temperature than
// its shock limit, the limit coming from its toughness, expansion and stiffness (`shockLimit`).

const row$ = (key: string): ElementDef => elementByKey(ELEMENTS, key);
const typeOf = (kind: number): number => kind & 0xff;
const NO_AIR = { air: false };

// The rows that can crack.
const CRACKING = ELEMENTS.filter((e) => shockLimit(e) !== undefined);

describe('M8.1 AC27: the shock limits', () => {
  it('anchors soda-lime glass at its measured critical quench of 150 K', () => {
    expect(GLASS_QUENCH).toBe(150);
    expect(shockLimit(row$('GLASS'))).toBeCloseTo(GLASS_QUENCH, 9);
  });

  it('gives a limit to GLASS, ICE, STONE, BRICK and CERAMIC, in the order the data say: ice cracks first, then glass, ceramic, basalt, brick', () => {
    expect(CRACKING.map((e) => e.key).sort()).toEqual(['BRICK', 'CERAMIC', 'GLASS', 'ICE', 'STONE']);
    const limit = (key: string): number => shockLimit(row$(key))!;
    expect(limit('ICE')).toBeLessThan(limit('GLASS'));
    expect(limit('GLASS')).toBeLessThan(limit('CERAMIC'));
    expect(limit('CERAMIC')).toBeLessThan(limit('STONE'));
    expect(limit('STONE')).toBeLessThan(limit('BRICK'));
    // Ice withstands a few tens of degrees (it cracks in a drink); glass 150 K; alumina a little more (a crucible is preheated).
    expect(limit('ICE')).toBeGreaterThan(15);
    expect(limit('ICE')).toBeLessThan(40);
    expect(limit('CERAMIC')).toBeGreaterThan(GLASS_QUENCH);
    expect(limit('CERAMIC')).toBeLessThan(250);
  });

  it('gives no limit to a metal, diamond, a powder, a liquid or a gas', () => {
    for (const e of ELEMENTS) {
      if (CRACKING.includes(e)) continue;
      expect(shockLimit(e), e.key).toBeUndefined();
      expect(crackTarget(e), e.key).toBeUndefined();
    }
  });

  it('cracks into the broken form of the crush, and ceramic (with none) into ceramic shards', () => {
    expect(crackTarget(row$('GLASS'))).toBe('BROKEN_GLASS');
    expect(crackTarget(row$('ICE'))).toBe('SNOW');
    expect(crackTarget(row$('STONE'))).toBe('GRAVEL');
    expect(crackTarget(row$('BRICK'))).toBe('BRICK_RUBBLE');
    expect(crackTarget(row$('CERAMIC'))).toBe('CERAMIC_SHARDS');
    expect(row$('CERAMIC').pressureAbove, 'a blast still does not break ceramic').toBeUndefined();
  });

  it('scales with toughness, and against expansion and stiffness', () => {
    const glass = row$('GLASS');
    const base = shockLimit(glass)!;
    expect(shockLimit({ ...glass, toughness: glass.toughness! * 2 })).toBeCloseTo(2 * base, 9);
    expect(shockLimit({ ...glass, expansion: glass.expansion! * 2 })).toBeCloseTo(base / 2, 9);
    expect(shockLimit({ ...glass, stiffness: glass.stiffness! * 2 })).toBeCloseTo(base / 2, 9);
  });

  it('keeps the preheated crucible inside the ceramic limit and the cold one far outside it', () => {
    const steel = 1600;
    expect(steel - CRUCIBLE.preheat).toBeLessThan(shockLimit(row$('CERAMIC'))!);
    expect(steel - 20).toBeGreaterThan(shockLimit(row$('CERAMIC'))!);
  });

  it('packs the limit as a row word, 0 for a row that cannot crack, and the target in the pressure target word', () => {
    const wordOf = (name: string): number => PROP_FIELDS.findIndex((f) => f.name === name);
    const packed = packElements(ELEMENTS);
    const words = new Uint32Array(packed);
    const floats = new Float32Array(packed);
    const at = (e: ElementDef, name: string): number => (e.id * ROW_BYTES) / 4 + wordOf(name);
    expect(floats[at(row$('GLASS'), 'shockLimit')]).toBeCloseTo(GLASS_QUENCH, 3);
    expect(floats[at(row$('METAL'), 'shockLimit')]).toBe(0);
    expect(floats[at(row$('SAND'), 'shockLimit')]).toBe(0);
    expect((words[at(row$('CERAMIC'), 'transitions')] >>> 16) & 0xff).toBe(row$('CERAMIC_SHARDS').id);
    expect((words[at(row$('GLASS'), 'transitions')] >>> 16) & 0xff).toBe(row$('BROKEN_GLASS').id);
  });

  describe('validation', () => {
    const rejectRow = (key: string, changes: Partial<ElementDef>, message: RegExp): void => {
      expect(() => validateElements(ELEMENTS.map((e) => (e.key === key ? { ...e, ...changes } : e)))).toThrow(message);
    };
    it('rejects an expansion without a stiffness and the reverse', () => {
      rejectRow('GLASS', { stiffness: undefined }, /GLASS: expansion and stiffness go together/);
      rejectRow('GLASS', { expansion: undefined }, /GLASS: expansion and stiffness go together/);
    });
    it('rejects an expansion or stiffness that is not a positive number', () => {
      rejectRow('GLASS', { expansion: 0 }, /GLASS: expansion must be a finite number above 0/);
      rejectRow('GLASS', { expansion: -1e-6 }, /GLASS: expansion must be a finite number above 0/);
      rejectRow('GLASS', { stiffness: 0 }, /GLASS: stiffness must be a finite number above 0/);
      rejectRow('GLASS', { stiffness: Infinity }, /GLASS: stiffness must be a finite number above 0/);
    });
    it('rejects them on anything but a solid that holds heat', () => {
      rejectRow('WATER', { expansion: 1e-5, stiffness: 2, toughness: 1, cracksInto: 'ICE' }, /WATER: expansion and stiffness are only for a solid/);
      rejectRow('BRICK', { conductivity: 0 }, /BRICK: an element with an expansion must hold heat/);
    });
    it('rejects a cracking solid with no broken form, one that is not in the table or is itself', () => {
      rejectRow('CERAMIC', { cracksInto: undefined }, /CERAMIC: an element with an expansion needs a pressureAbove or a cracksInto/);
      rejectRow('CERAMIC', { cracksInto: 'NOPE' }, /CERAMIC: the element it cracks into, "NOPE", is not in the table/);
      rejectRow('CERAMIC', { cracksInto: 'CERAMIC' }, /CERAMIC: it cannot crack into itself/);
    });
    it('rejects a cracksInto beside a pressureAbove or without an expansion, and a toughness with neither use', () => {
      rejectRow('GLASS', { cracksInto: 'GRAVEL' }, /GLASS: cracksInto is only for an element with an expansion and no pressureAbove/);
      rejectRow('METAL', { cracksInto: 'GRAVEL' }, /METAL: cracksInto is only for/);
      rejectRow('METAL', { toughness: 3 }, /METAL: toughness is only for an element with a pressureAbove or an expansion/);
    });
    it('rejects an expansion without a toughness', () => {
      rejectRow('GLASS', { toughness: undefined }, /GLASS: toughness must be a finite number above 0/);
    });
  });
});

// Two cells side by side in one block: the cell at `base` and a diamond (which holds heat, never changes and does not crack) at
// `base + difference`, run for one superstep. Returns what the cell is afterwards and the heat of the pair before and after.
async function pair(
  kind: number,
  base: number,
  difference: number,
): Promise<{ type: number; before: number; after: number }> {
  const sim = createSim(2, 1, 1, { elements: ELEMENTS, ...NO_AIR });
  const temp = new Uint32Array(2);
  tempView({ temp }).set([base, base + difference]);
  const kinds = new Uint32Array([cell(kind), cell(T.DIAMOND)]);
  sim.load({ kind: kinds, temp });
  const before = heatContent(ELEMENTS, { kind: kinds, temp });
  await runMany(sim, 1);
  const after = await readCells(sim);
  return { type: typeOf(after[0]), before, after: heatContent(ELEMENTS, { kind: after, temp: await sim.fields.read('temp') }) };
}

describe.skipIf(!device)('M8.1 AC27: a cell against a neighbor in its block', () => {
  for (const e of CRACKING) {
    const limit = shockLimit(e)!;
    const target = elementByKey(ELEMENTS, crackTarget(e)!);

    it(`${e.key}: stays against a neighbor just under ${limit.toFixed(1)} K hotter and becomes ${target.key} against one just over, keeping its heat`, async () => {
      // Cold enough that no row has reached a threshold, and ice stays under 0 °C.
      const base = -100;
      const under = await pair(e.id, base, limit - 1);
      expect(under.type, 'just under the limit').toBe(e.id);
      const over = await pair(e.id, base, limit + 1);
      expect(over.type, 'just over the limit').toBe(target.id);
      expect(Math.abs(over.after - over.before) / Math.abs(over.before), 'relative change of the pair\'s heat').toBeLessThan(1e-4);
    });

    it(`${e.key}: cracks against a colder neighbor as well`, async () => {
      const hot = e.key === 'ICE' ? -2 : 100;
      const over = await pair(e.id, hot, -limit - 1);
      expect(over.type).toBe(target.id);
    });
  }

  it('does not crack against a wall or empty space, which hold no heat', async () => {
    for (const e of CRACKING) {
      const sim = createSim(4, 1, 1, { elements: ELEMENTS, ...NO_AIR });
      const temp = new Uint32Array(4);
      tempView({ temp }).set([-100, 0, 0, 0]);
      sim.load({ kind: new Uint32Array([cell(e.id), cell(T.WALL), cell(T.EMPTY), cell(T.EMPTY)]), temp });
      await runMany(sim, 2);
      expect(typeOf((await readCells(sim))[0]), e.key).toBe(e.id);
    }
  });

  it('never cracks a metal, diamond or aerogel against a neighbor 1,000 K hotter', async () => {
    const solids = ELEMENTS.filter((e: ElementDef) => e.state === 'solid' && elementHoldsHeat(e) && shockLimit(e) === undefined && (e.category === 'Metals' || e.key === 'DIAMOND' || e.key === 'INSULATION'));
    expect(solids.map((e) => e.key)).toEqual(expect.arrayContaining(['METAL', 'ALUMINIUM', 'COPPER', 'GOLD', 'TITANIUM', 'TUNGSTEN', 'DIAMOND']));
    for (const e of solids) {
      // A diamond beside steel at 1,100 °C; every other solid beside a diamond at 1,100 °C. One superstep moves too little heat for a melt.
      const hotPartner = e.key === 'DIAMOND' ? T.METAL : T.DIAMOND;
      const sim = createSim(2, 1, 1, { elements: ELEMENTS, ...NO_AIR });
      const temp = new Uint32Array(2);
      tempView({ temp }).set([20, 1100]);
      sim.load({ kind: new Uint32Array([cell(e.id), cell(hotPartner)]), temp });
      await runMany(sim, 1);
      expect(typeOf((await readCells(sim))[0]), e.key).toBe(e.id);
    }
  });

  it('keeps the heat of a sealed box of cracking solids and their neighbors across the cracks, over 2,000 supersteps', async () => {
    const width = 24;
    const height = 16;
    const canvas = new Canvas(width, height);
    canvas.fill(T.WALL, 0, width, 0, height);
    const band = (type: number, y0: number, temp: number): void => {
      canvas.fill(type, 2, width - 2, y0, y0 + 2);
      canvas.fillTemp(temp, 2, width - 2, y0, y0 + 2);
    };
    // Glass at 500 over water at 5, ice at -30 under basalt at 700, copper at 400 against ceramic at 20: every pair is far over its limit.
    band(T.WATER, 2, 5);
    band(T.GLASS, 4, 500);
    band(T.ICE, 6, -30);
    band(T.STONE, 8, 700);
    band(T.COPPER, 10, 400);
    band(T.CERAMIC, 12, 20);
    const sim = createSim(width, height, 3, { elements: ELEMENTS, ...NO_AIR });
    sim.load(canvas.fields);
    const heat = async (): Promise<number> => heatContent(ELEMENTS, { kind: await readCells(sim), temp: await sim.fields.read('temp') });
    const before = await heat();
    await runMany(sim, 2000);
    const cells = await readCells(sim);
    expect(countType(cells, T.BROKEN_GLASS) + countType(cells, T.SNOW) + countType(cells, T.GRAVEL), 'cells that cracked').toBeGreaterThan(0);
    expect(countType(cells, T.CERAMIC_SHARDS), 'ceramic cracked into shards, not gravel').toBeGreaterThan(0);
    expect(Math.abs((await heat()) - before) / Math.abs(before), 'relative change of the total heat').toBeLessThan(2e-3);
  }, 60_000);
});

describe.skipIf(!device)('M8.1 AC28: ice cracks in warm water', () => {
  async function snowAfter(waterTemp: number, iceTemp: number, supersteps: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const width = 20;
    const canvas = tank(width, 14);
    canvas.fill(T.WATER, WALL, width - WALL, WALL, WALL + 6);
    canvas.fillTemp(waterTemp, WALL, width - WALL, WALL, WALL + 6);
    canvas.fill(T.ICE, 8, 12, WALL + 2, WALL + 4);
    canvas.fillTemp(iceTemp, 8, 12, WALL + 2, WALL + 4);
    const sim = createSim(width, 14, 1, { elements, ...NO_AIR });
    sim.load(canvas.fields);
    await runMany(sim, supersteps);
    return countType(await readCells(sim), T.SNOW);
  }

  it('cracks a cube from the freezer into snow in water at 40 °C, within 50 supersteps', async () => {
    expect(await snowAfter(40, -20, 50)).toBeGreaterThan(0);
  }, 60_000);

  it('leaves a cube at 0 °C whole in water at 10 °C, under the ice\'s limit', async () => {
    expect(await snowAfter(10, 0, 200)).toBe(0);
  }, 60_000);

  it('control: ice that expands a tenth as much does not crack in water at 40 °C', async () => {
    const table = ELEMENTS.map((e) => (e.key === 'ICE' ? { ...e, expansion: e.expansion / 10 } : e));
    expect(await snowAfter(40, -20, 50, table)).toBe(0);
  }, 60_000);
});
