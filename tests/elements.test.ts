import { describe, expect, it } from 'vitest';
import { PROP_FIELDS, ROW_BYTES, packElements } from '../src/element-table';
import {
  DEFAULT_DRAG, DEFAULT_GRAVITY, ELEMENT, ELEMENTS, MAX_ELEMENTS, STATES, elementByKey, elementConductivity, elementDrag, elementGravity, elementHeatCapacity, elementHoldsHeat, elementInert,
  elementTemperature, latentWidth, validateElements, type ElementDef,
} from '../src/elements';
import { ABSOLUTE_ZERO, MAX_TEMP, NO_THRESHOLD, ROOM_TEMP, effectiveTemp } from '../src/heat';
import { buttonAttributes, toolbarEntries } from '../src/toolbar';
import { latentOffsets } from './metrics';

// Test rows sit far from the game's IDs and toolbar positions, which grow with the table.
const MUD: ElementDef = { key: 'MUD', id: 200, label: 'Mud', color: [0.4, 0.3, 0.2], state: 'powder', density: 1300, toolbar: 50 };

// A chain of phases with the shape of ice, water and steam: SLUSH melts at 0 °C, BROTH boils at 100 °C, VAPOR condenses there.
const SLUSH: ElementDef = {
  key: 'SLUSH', id: 201, label: 'Slush', color: [0.8, 0.9, 1], state: 'solid', density: 917, temperature: -20, conductivity: 0.2, heatCapacity: 2,
  above: { temp: 0, becomes: 'BROTH', latent: 300 },
};
const BROTH: ElementDef = {
  key: 'BROTH', id: 202, label: 'Broth', color: [0.2, 0.4, 0.7], state: 'liquid', density: 1000, conductivity: 0.3, heatCapacity: 4,
  below: { temp: 0, becomes: 'SLUSH', latent: 300 },
  above: { temp: 100, becomes: 'VAPOR', latent: 400 },
};
const VAPOR: ElementDef = {
  key: 'VAPOR', id: 203, label: 'Vapor', color: [0.9, 0.9, 0.9], state: 'gas', density: 0.6, temperature: 110, conductivity: 0.2, heatCapacity: 2,
  below: { temp: 100, becomes: 'BROTH', latent: 400 },
};
const PHASES = [SLUSH, BROTH, VAPOR];
// The chain with one row changed.
const withRow = (key: string, change: Partial<ElementDef>): ElementDef[] => [...ELEMENTS, ...PHASES.map((e) => (e.key === key ? { ...e, ...change } : e))];

describe('element table', () => {
  it('AC11: describes every current material, the IDs the cells already store', () => {
    expect(ELEMENT).toEqual({ EMPTY: 0, SAND: 1, WALL: 2, WATER: 3, SMOKE: 4, OIL: 5, FIRE: 6, METAL: 7, STONE: 8,
      ICE: 9, STEAM: 10, LAVA: 11, MOLTEN_METAL: 12,
    });
    expect(() => validateElements(ELEMENTS)).not.toThrow();
    expect(elementByKey(ELEMENTS, 'FIRE').life).toEqual({ start: 200, decay: 4, becomes: 'SMOKE' });
  });

  it('orders the densities the way the CA relies on: oil floats on water, sand sinks through both, smoke is lighter than all', () => {
    const density = (key: string): number => elementByKey(ELEMENTS, key).density;
    expect(density('SMOKE')).toBeLessThan(density('OIL'));
    expect(density('OIL')).toBeLessThan(density('WATER'));
    expect(density('WATER')).toBeLessThan(density('SAND'));
  });

  it('packs one 80-byte row per element ID, at the offset the ID gives', () => {
    expect(ROW_BYTES).toBe(80);
    expect(ROW_BYTES % 16, 'a uniform array stride').toBe(0);
    const buffer = packElements(ELEMENTS);
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer);
    expect(words).toHaveLength(MAX_ELEMENTS * PROP_FIELDS.length);
    const at = (id: number, field: string): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field);
    expect(floats[at(ELEMENT.SAND, 'density')]).toBe(1600);
    expect(floats[at(ELEMENT.WATER, 'colorB')]).toBeCloseTo(0.72, 6);
    expect(words[at(ELEMENT.WATER, 'state')]).toBe(STATES.indexOf('liquid'));
    expect(words[at(ELEMENT.OIL, 'flammable')]).toBe(1);
    expect(words[at(ELEMENT.SAND, 'flammable')]).toBe(0);
    expect(words[at(ELEMENT.FIRE, 'lifeStart')]).toBe(200);
    expect(words[at(ELEMENT.FIRE, 'lifeRule')]).toBe(4 | (ELEMENT.SMOKE << 8));
    expect(floats[at(ELEMENT.SAND, 'gravity')]).toBe(DEFAULT_GRAVITY);
    expect(floats[at(ELEMENT.WATER, 'drag')]).toBe(DEFAULT_DRAG);
    expect(words[at(ELEMENT.WALL, 'inert')]).toBe(1);
    expect(words[at(ELEMENT.SAND, 'inert')]).toBe(0);
    expect(words[at(ELEMENT.METAL, 'inert')], 'a solid that holds heat is not inert').toBe(0);
    expect(words.subarray(at(100, 'colorR'), at(101, 'colorR')).every((w) => w === 0), 'an unused ID').toBe(true);
  });

  it('counts as inert only what never changes by itself: empty space and solids without a lifetime or a rule', () => {
    const inert = ELEMENTS.filter((e) => elementInert(e)).map((e) => e.key);
    expect(inert).toEqual(expect.arrayContaining(['EMPTY', 'WALL']));
    expect(inert).toHaveLength(2);
    const wall = elementByKey(ELEMENTS, 'WALL');
    expect(elementInert({ ...wall, conductivity: 0.1 })).toBe(false);
    expect(elementInert({ ...wall, rule: 'fire' })).toBe(false);
    expect(elementInert({ ...wall, life: { start: 10, decay: 1, becomes: 'EMPTY' } })).toBe(false);
  });

  it('gives powders and liquids gravity by default, and everything else none', () => {
    for (const e of ELEMENTS) {
      const falls = e.state === 'powder' || e.state === 'liquid';
      expect(elementGravity(e), e.key).toBe(falls ? DEFAULT_GRAVITY : 0);
      expect(elementDrag(e), e.key).toBe(DEFAULT_DRAG);
    }
    expect(elementGravity({ ...MUD, gravity: 0.01 })).toBe(0.01);
    expect(elementDrag({ ...MUD, drag: 0.5 })).toBe(0.5);
  });

  it('M5: starts fire at its flame temperature and everything else at room temperature, packed for the GPU', () => {
    const painted: Record<string, number> = { FIRE: 1000, ICE: -20, STEAM: 110, LAVA: 1300, MOLTEN_METAL: 1600 };
    for (const e of ELEMENTS) expect(elementTemperature(e), e.key).toBe(painted[e.key] ?? ROOM_TEMP);
    expect(elementTemperature({ ...MUD, temperature: -20 })).toBe(-20);
    const floats = new Float32Array(packElements(ELEMENTS));
    const at = (id: number): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === 'temperature');
    expect(floats[at(ELEMENT.FIRE)]).toBe(1000);
    expect(floats[at(ELEMENT.WATER)]).toBe(ROOM_TEMP);
  });

  it('M5: gives METAL and STONE their conductivity and capacity, and everything else a default', () => {
    const metal = elementByKey(ELEMENTS, 'METAL');
    const stone = elementByKey(ELEMENTS, 'STONE');
    expect([metal.state, metal.density, elementConductivity(metal), elementHeatCapacity(metal)]).toEqual(['solid', 7870, 1, 3.5]);
    expect([stone.state, stone.density, elementConductivity(stone), elementHeatCapacity(stone)]).toEqual(['solid', 2700, 0.1, 2.2]);
    expect(elementConductivity(MUD)).toBe(0);
    expect(elementHeatCapacity(MUD)).toBe(1);
    expect(ELEMENTS.filter((e) => !elementHoldsHeat(e)).map((e) => e.key).sort()).toEqual(['EMPTY', 'WALL']);
  });

  it('M5: packs conductivity, heat capacity and whether the element holds heat for the GPU', () => {
    const buffer = packElements([...ELEMENTS, { ...MUD, conductivity: 0.25, heatCapacity: 2 }]);
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer);
    const at = (id: number, field: string): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field);
    expect(floats[at(ELEMENT.METAL, 'conductivity')]).toBe(1);
    expect(floats[at(ELEMENT.METAL, 'heatCapacity')]).toBe(3.5);
    expect(floats[at(ELEMENT.STONE, 'conductivity')]).toBeCloseTo(0.1, 7);
    expect(floats[at(200, 'conductivity')]).toBe(0.25);
    expect(floats[at(200, 'heatCapacity')]).toBe(2);
    expect(floats[at(ELEMENT.WALL, 'conductivity')]).toBe(0);
    expect(floats[at(ELEMENT.WALL, 'heatCapacity')]).toBe(1);
    for (const key of ['METAL', 'STONE', 'SAND', 'WATER', 'OIL', 'SMOKE', 'FIRE'] as const) expect(words[at(ELEMENT[key], 'holdsHeat')], key).toBe(1);
    for (const key of ['EMPTY', 'WALL'] as const) expect(words[at(ELEMENT[key], 'holdsHeat')], key).toBe(0);
  });

  it.each([
    ['a negative conductivity', { conductivity: -0.1 }, /MUD: conductivity must be a number in 0\.\.1/],
    ['a conductivity above 1', { conductivity: 1.5 }, /MUD: conductivity must be a number in 0\.\.1/],
    ['a conductivity that is not a number', { conductivity: NaN }, /MUD: conductivity must be a number in 0\.\.1/],
    ['a heat capacity of 0', { heatCapacity: 0 }, /MUD: heatCapacity must be a finite number above 0/],
    ['a negative heat capacity', { heatCapacity: -1 }, /MUD: heatCapacity must be a finite number above 0/],
    ['an infinite heat capacity', { heatCapacity: Infinity }, /MUD: heatCapacity must be a finite number above 0/],
  ])('M5: rejects %s', (_name, change, message) => {
    expect(() => validateElements([...ELEMENTS, { ...MUD, ...change }])).toThrow(message);
  });

  it('M5: counts a transition as holding heat, also without a conductivity, and keeps such a solid out of the inert skip', () => {
    const solid: ElementDef = { ...MUD, state: 'solid', above: { temp: 100, becomes: 'WATER', latent: 10 } };
    expect(elementHoldsHeat(solid)).toBe(true);
    expect(elementInert(solid)).toBe(false);
    expect(elementHoldsHeat({ ...MUD, below: { temp: 0, becomes: 'WATER' } })).toBe(true);
    expect(elementInert({ ...solid, above: undefined })).toBe(true);
  });

  it('M5: packs the thresholds, their latent widths and their targets for the GPU', () => {
    const buffer = packElements([...ELEMENTS, ...PHASES]);
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer);
    const at = (id: number, field: string): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === field);
    expect(latentWidth(BROTH, BROTH.above!)).toBe(100);
    expect([floats[at(202, 'belowTemp')], floats[at(202, 'belowWidth')], floats[at(202, 'aboveTemp')], floats[at(202, 'aboveWidth')]]).toEqual([0, 75, 100, 100]);
    expect(words[at(202, 'transitions')]).toBe(201 | (203 << 8));
    expect([floats[at(201, 'belowTemp')], floats[at(201, 'aboveTemp')], floats[at(201, 'aboveWidth')]]).toEqual([Math.fround(-NO_THRESHOLD), 0, 150]);
    expect(words[at(201, 'transitions')], 'only an above target').toBe(202 << 8);
    expect(words[at(203, 'transitions')], 'only a below target').toBe(202);
    for (const key of ['SAND', 'WALL'] as const) {
      expect([floats[at(ELEMENT[key], 'belowTemp')], floats[at(ELEMENT[key], 'aboveTemp')]], key).toEqual([Math.fround(-NO_THRESHOLD), Math.fround(NO_THRESHOLD)]);
      expect([floats[at(ELEMENT[key], 'belowWidth')], floats[at(ELEMENT[key], 'aboveWidth')], words[at(ELEMENT[key], 'transitions')]], key).toEqual([0, 0, 0]);
    }
    expect(words[at(201, 'holdsHeat')]).toBe(1);
  });

  it('M5: clamps a stored temperature to the thresholds, so a cell taking in latent heat stays at its threshold', () => {
    expect(effectiveTemp(BROTH, 40)).toBe(40);
    expect(effectiveTemp(BROTH, 140), 'boiling water that took 40 of its latent heat').toBe(100);
    expect(effectiveTemp(BROTH, -30), 'freezing water').toBe(0);
    expect(effectiveTemp(BROTH, 100), 'exactly at a threshold').toBe(100);
    expect(effectiveTemp(SLUSH, 40)).toBe(0);
    expect(effectiveTemp(SLUSH, -250)).toBe(-250);
    expect(effectiveTemp(VAPOR, 9000)).toBe(9000);
    expect(effectiveTemp(MUD, -273.15)).toBe(-273.15);
    expect(effectiveTemp(MUD, MAX_TEMP)).toBe(MAX_TEMP);
  });

  it('M5: accepts a table of transitions, and a one-way transition without latent heat', () => {
    expect(() => validateElements([...ELEMENTS, ...PHASES])).not.toThrow();
    const oneWay: ElementDef = { ...MUD, above: { temp: 250, becomes: 'FIRE' } };
    expect(() => validateElements([...ELEMENTS, oneWay])).not.toThrow();
  });

  it.each<[string, ElementDef[], RegExp]>([
    ['a negative latent heat', withRow('SLUSH', { above: { temp: 0, becomes: 'BROTH', latent: -1 } }), /SLUSH: above\.latent must be a finite number/],
    ['an infinite latent heat', withRow('SLUSH', { above: { temp: 0, becomes: 'BROTH', latent: Infinity } }), /SLUSH: above\.latent must be a finite number/],
    ['a below threshold not under the above one', [...ELEMENTS, { ...MUD, below: { temp: 80, becomes: 'WATER' }, above: { temp: 50, becomes: 'WATER' } }], /MUD: below\.temp must be under above\.temp/],
    ['a transition to a missing element', withRow('SLUSH', { above: { temp: 0, becomes: 'GHOST', latent: 300 } }), /SLUSH: above\.becomes "GHOST" is not in the table/],
    ['a threshold outside its target\'s range', withRow('SLUSH', { above: { temp: 150, becomes: 'BROTH', latent: 300 } }), /SLUSH: above\.temp 150 is outside the range 0\.\.100 of BROTH/],
    ['a paint temperature outside its own range', withRow('SLUSH', { temperature: 50 }), /SLUSH: temperature 50 is outside its own range -Infinity\.\.0/],
    ['a reversible pair with two thresholds', withRow('SLUSH', { above: { temp: 10, becomes: 'BROTH', latent: 300 } }), /SLUSH: above and the below of BROTH must share their temp and latent/],
    ['a reversible pair with two latent heats', withRow('BROTH', { below: { temp: 0, becomes: 'SLUSH', latent: 200 } }), /SLUSH: above and the below of BROTH must share/],
    [
      'a reversible pair with no latent heat',
      withRow('VAPOR', { below: { temp: 100, becomes: 'BROTH' } }).map((e) => (e.key === 'BROTH' ? { ...e, above: { temp: 100, becomes: 'VAPOR' } } : e)),
      /BROTH: the pair with VAPOR needs a latent above 0/,
    ],
    ['an above threshold whose latent width passes the hottest temperature', withRow('SLUSH', { above: { temp: 0, becomes: 'BROTH', latent: 1e5 } }), /SLUSH: above\.temp 0 and its latent width 50000 must stay within/],
    ['a below threshold whose latent width passes absolute zero', withRow('BROTH', { below: { temp: 0, becomes: 'SLUSH', latent: 2000 } }), /BROTH: below\.temp 0 and its latent width 500 must stay within/],
    ['a threshold that is not a number', withRow('SLUSH', { above: { temp: NaN, becomes: 'BROTH', latent: 300 } }), /SLUSH: above\.temp NaN/],
  ])('M5: rejects %s', (_name, table, message) => {
    expect(() => validateElements(table)).toThrow(message);
  });

  it.each([['below absolute zero', ABSOLUTE_ZERO - 1], ['above the hottest', MAX_TEMP + 1], ['not a number', NaN]])('M5: rejects a temperature %s', (_name, temperature) => {
    expect(() => validateElements([...ELEMENTS, { ...MUD, temperature }])).toThrow(/MUD: temperature must be a number in/);
  });

  it.each<[string, ElementDef[], RegExp]>([
    ['a negative gravity', [...ELEMENTS, { ...MUD, gravity: -1 }], /gravity must be a finite number/],
    ['a drag of 1', [...ELEMENTS, { ...MUD, drag: 1 }], /drag must be at least 0 and below 1/],
    ['a duplicate ID', [...ELEMENTS, { ...MUD, id: ELEMENT.SAND }], /id 1 is used twice/],
    ['a duplicate key', [...ELEMENTS, { ...MUD, key: 'SAND' }], /SAND appears twice/],
    ['an ID past 8 bits', [...ELEMENTS, { ...MUD, id: 256 }], /not in 0\.\.255/],
    ['a lifetime that becomes nothing', [...ELEMENTS, { ...MUD, life: { start: 10, decay: 1, becomes: 'GHOST' } }], /"GHOST" is not in the table/],
    ['a liquid with a lifetime', [...ELEMENTS, { ...MUD, state: 'liquid', life: { start: 10, decay: 1, becomes: 'SMOKE' } }], /liquid/],
    ['a toolbar position used twice', [...ELEMENTS, { ...MUD, toolbar: 1 }], /position 1 is used twice/],
    ['a table without a wall', ELEMENTS.filter((e) => e.key !== 'WALL'), /needs an element WALL/],
    ['a wall that moves', ELEMENTS.map((e) => (e.key === 'WALL' ? { ...e, state: 'powder' as const } : e)), /WALL must have state solid/],
    ['an empty that is not empty', ELEMENTS.map((e) => (e.key === 'EMPTY' ? { ...e, state: 'gas' as const } : e)), /EMPTY must have state empty/],
    ['a rule name that is not an identifier', [...ELEMENTS, { ...MUD, rule: 'my-rule' }], /"my-rule" must be lower snake case/],
    ['a flammable element without fire', ELEMENTS.filter((e) => e.key !== 'FIRE'), /needs a FIRE/],
  ])('rejects %s', (_name, table, message) => {
    expect(() => validateElements(table)).toThrow(message);
  });
});

describe('toolbar', () => {
  it('lists the paintable elements with the current order, labels and keys', () => {
    expect(toolbarEntries(ELEMENTS)).toEqual([
      { id: ELEMENT.SAND, label: 'Sand', key: '1' },
      { id: ELEMENT.WATER, label: 'Water', key: '2' },
      { id: ELEMENT.OIL, label: 'Oil', key: '3' },
      { id: ELEMENT.FIRE, label: 'Fire', key: '4' },
      { id: ELEMENT.SMOKE, label: 'Smoke', key: '5' },
      { id: ELEMENT.WALL, label: 'Wall', key: '6' },
      { id: ELEMENT.METAL, label: 'Metal', key: '7' },
      { id: ELEMENT.STONE, label: 'Stone', key: '8' },
      { id: ELEMENT.ICE, label: 'Ice', key: '9' },
      { id: ELEMENT.LAVA, label: 'Lava', key: undefined },
      { id: ELEMENT.STEAM, label: 'Steam', key: undefined },
    ]);
  });

  it('follows a table: an extra row appears at its position, an element without one does not', () => {
    const table: ElementDef[] = [...ELEMENTS, { ...MUD, toolbar: 3 }].map((e) => (e.key === 'OIL' ? { ...e, toolbar: 70 } : e));
    expect(toolbarEntries(table).map((e) => e.label)).toEqual(['Sand', 'Water', 'Mud', 'Fire', 'Smoke', 'Wall', 'Metal', 'Stone', 'Ice', 'Lava', 'Steam', 'Oil']);
    expect(toolbarEntries([...ELEMENTS, { ...MUD, toolbar: undefined }])).toHaveLength(11);
  });

  it('gives each button the element ID in data-type and the tool-btn class', () => {
    expect(buttonAttributes({ id: 200, label: 'Mud', key: '7' })).toEqual({ type: 'button', class: 'tool-btn', 'data-type': '200' });
  });

  it('gives only the first nine buttons a key', () => {
    const table: ElementDef[] = Array.from({ length: 11 }, (_, i) => ({ ...MUD, key: `E${i + 1}`, id: i + 201, toolbar: i + 1 }));
    const unpaintable = (ELEMENTS as readonly ElementDef[]).filter((e) => e.toolbar === undefined);
    expect(toolbarEntries([...unpaintable, ...table]).map((e) => e.key))
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined, undefined]);
  });
});

describe('M5.4c latent offsets', () => {
  it('give the elements joined by transitions the heat a phase change leaves in place, and none to those that hold no heat', () => {
    const offsets = latentOffsets(ELEMENTS);
    const offset = (key: keyof typeof ELEMENT): number => offsets.get(ELEMENT[key])!;
    // Ice -> water at 0 °C (latent 300, capacities 1.9 and 4.2), water -> steam at 100 °C (latent 400, steam 2.0). The
    // offsets are relative: the first element of a group in the table (water) gets 0.
    expect(offset('WATER')).toBe(0);
    expect(offset('WATER') - offset('ICE')).toBeCloseTo(300, 9);
    expect(offset('STEAM') - offset('WATER')).toBeCloseTo((4.2 - 2) * 100 + 400, 9);
    expect(offsets.has(ELEMENT.EMPTY)).toBe(false);
    expect(offsets.has(ELEMENT.WALL)).toBe(false);
    // The same graph walked from another start: the offsets differ only by a constant per group.
    const reversed = latentOffsets([...ELEMENTS].reverse());
    expect(reversed.get(ELEMENT.STEAM)! - reversed.get(ELEMENT.ICE)!).toBeCloseTo(offset('STEAM') - offset('ICE'), 9);
  });
});
