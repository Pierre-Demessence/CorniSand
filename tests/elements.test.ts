import { describe, expect, it } from 'vitest';
import { PROP_FIELDS, ROW_BYTES, packElements } from '../src/element-table';
import { DEFAULT_DRAG, DEFAULT_GRAVITY, ELEMENT, ELEMENTS, MAX_ELEMENTS, STATES, elementByKey, elementDrag, elementGravity, elementInert, validateElements, type ElementDef } from '../src/elements';
import { buttonAttributes, toolbarEntries } from '../src/toolbar';

const MUD: ElementDef = { key: 'MUD', id: 7, label: 'Mud', color: [0.4, 0.3, 0.2], state: 'powder', density: 1300, toolbar: 7 };

describe('element table', () => {
  it('AC11: describes every current material, the IDs the cells already store', () => {
    expect(ELEMENT).toEqual({ EMPTY: 0, SAND: 1, WALL: 2, WATER: 3, SMOKE: 4, OIL: 5, FIRE: 6 });
    expect(() => validateElements(ELEMENTS)).not.toThrow();
    expect(elementByKey(ELEMENTS, 'FIRE').life).toEqual({ start: 200, decay: 4, becomes: 'SMOKE' });
  });

  it('orders the densities the way the CA relies on: oil floats on water, sand sinks through both, smoke is lighter than all', () => {
    const density = (key: string): number => elementByKey(ELEMENTS, key).density;
    expect(density('SMOKE')).toBeLessThan(density('OIL'));
    expect(density('OIL')).toBeLessThan(density('WATER'));
    expect(density('WATER')).toBeLessThan(density('SAND'));
  });

  it('packs one 48-byte row per element ID, at the offset the ID gives', () => {
    expect(ROW_BYTES).toBe(48);
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
    expect(words.subarray(at(100, 'colorR'), at(101, 'colorR')).every((w) => w === 0), 'an unused ID').toBe(true);
  });

  it('counts as inert only what never changes by itself: empty space and solids without a lifetime or a rule', () => {
    const inert = ELEMENTS.filter((e) => elementInert(e)).map((e) => e.key);
    expect(inert).toEqual(expect.arrayContaining(['EMPTY', 'WALL']));
    expect(inert).toHaveLength(2);
    const wall = elementByKey(ELEMENTS, 'WALL');
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
    ]);
  });

  it('follows a table: an extra row appears at its position, an element without one does not', () => {
    const table: ElementDef[] = [...ELEMENTS, { ...MUD, toolbar: 3 }].map((e) => (e.key === 'OIL' ? { ...e, toolbar: 7 } : e));
    expect(toolbarEntries(table).map((e) => e.label)).toEqual(['Sand', 'Water', 'Mud', 'Fire', 'Smoke', 'Wall', 'Oil']);
    expect(toolbarEntries([...ELEMENTS, { ...MUD, toolbar: undefined }])).toHaveLength(6);
  });

  it('gives each button the element ID in data-type and the tool-btn class', () => {
    expect(buttonAttributes({ id: 7, label: 'Mud', key: '7' })).toEqual({ type: 'button', class: 'tool-btn', 'data-type': '7' });
  });

  it('gives only the first nine buttons a key', () => {
    const table: ElementDef[] = Array.from({ length: 11 }, (_, i) => ({ ...MUD, key: `E${i + 1}`, id: i + 10, toolbar: i + 1 }));
    const unpaintable = (ELEMENTS as readonly ElementDef[]).filter((e) => e.toolbar === undefined);
    expect(toolbarEntries([...unpaintable, ...table]).map((e) => e.key))
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined, undefined]);
  });
});
