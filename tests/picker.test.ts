import { describe, expect, it } from 'vitest';
import { ELEMENT, ELEMENTS, elementTemperature, type ElementDef } from '../src/elements';
import { ABSOLUTE_ZERO, MAX_TEMP } from '../src/heat';
import {
  CATEGORIES, TOOLS, TOOLS_TAB, buttonRow, clampPaintTemp, entryForKey, entryKey, paintPreview, paintTarget, pickerTabs, searchEntries, stepPaintTemp, swatchColor,
  type PickerEntry,
} from '../src/toolbar';

const MUD: ElementDef = {
  key: 'MUD', id: 200, label: 'Mud', color: [0.4, 0.3, 0.2], state: 'powder', density: 1300, toolbar: 50, category: 'Powders', description: 'Wet earth.',
};

const labels = (entries: readonly PickerEntry[]): string[] => entries.map((e) => e.label);
const key = (k: string, modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });

describe('M8.1 AC2 picker tabs', () => {
  const tabs = pickerTabs(ELEMENTS);

  it('has one tab per category that holds an entry, in CATEGORIES order, and Tools last', () => {
    const names = tabs.map((t) => t.name);
    expect(names.at(-1)).toBe(TOOLS_TAB);
    const categoryTabs = names.slice(0, -1);
    expect(categoryTabs).toEqual(CATEGORIES.filter((c) => ELEMENTS.some((e: ElementDef) => e.toolbar !== undefined && e.category === c)));
    expect(names).toEqual(['Powders', 'Liquids', 'Gases', 'Solids', 'Metals', 'Explosives', 'Tools']);
  });

  it('puts every paintable element and every tool in exactly one tab', () => {
    const entries = tabs.flatMap((t) => t.entries);
    const elementIds = entries.flatMap((e) => (e.kind === 'element' ? [e.id] : []));
    const paintable = ELEMENTS.filter((e: ElementDef) => e.toolbar !== undefined).map((e: ElementDef) => e.id);
    expect([...elementIds].sort((a, b) => a - b)).toEqual([...paintable].sort((a, b) => a - b));
    expect(entries.flatMap((e) => (e.kind === 'tool' ? [e.tool.id] : []))).toEqual(TOOLS.map((t) => t.id));
    for (const tab of tabs) for (const entry of tab.entries) expect(entry.tab).toBe(tab.name);
  });

  it('lists the current elements by category in toolbar order', () => {
    const byTab = Object.fromEntries(tabs.map((t) => [t.name, labels(t.entries)]));
    expect(byTab).toEqual({
      Powders: ['Sand'],
      Liquids: ['Water', 'Oil'],
      Gases: ['Smoke'],
      Solids: ['Wall', 'Stone'],
      Metals: ['Metal'],
      Explosives: ['Fire', 'Gunpowder'],
      Tools: ['Heat', 'Cool', 'Wind'],
    });
  });

  it('follows a table: an extra row appears at its position, a row without a position or a category does not', () => {
    const before = ELEMENTS.map((e: ElementDef) => (e.key === 'SAND' ? { ...e, toolbar: 70 } : e));
    const powders = (table: readonly ElementDef[]) => labels(pickerTabs(table).find((t) => t.name === 'Powders')!.entries);
    expect(powders([...before, { ...MUD, toolbar: 3 }])).toEqual(['Mud', 'Sand']);
    expect(powders([...ELEMENTS, { ...MUD, toolbar: undefined }])).toEqual(['Sand']);
    expect(pickerTabs([...ELEMENTS, { ...MUD, category: 'Life' }]).map((t) => t.name)).toContain('Life');
  });

  it('gives tools and elements a description for the tooltip', () => {
    for (const entry of tabs.flatMap((t) => t.entries)) expect(entry.description.trim(), entry.label).not.toBe('');
  });
});

describe('M8.1 AC3 number keys', () => {
  const tabs = pickerTabs(ELEMENTS);
  const liquids = tabs.find((t) => t.name === 'Liquids')!.entries;

  it('maps 1 to 9 to the n-th entry shown', () => {
    expect(entryForKey(liquids, key('1'))).toBe(liquids[0]);
    expect(entryForKey(liquids, key('3'))).toBe(liquids[2]);
    expect(entryForKey(liquids, key('4'))).toBeUndefined();
    expect(entryForKey(liquids, key('0'))).toBeUndefined();
    expect(entryForKey(liquids, key('a'))).toBeUndefined();
  });

  it('does nothing with Ctrl, Alt or Meta (B11)', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) expect(entryForKey(liquids, key('1', { [modifier]: true }))).toBeUndefined();
  });

  it('gives only the first nine entries a key', () => {
    expect([0, 1, 8, 9].map(entryKey)).toEqual(['1', '2', '9', undefined]);
  });
});

describe('M8.1 AC4 search', () => {
  const tabs = pickerTabs(ELEMENTS);

  it('matches the label ignoring case, in tab order', () => {
    expect(labels(searchEntries(tabs, 'ea'))).toEqual(['Heat']);
    expect(labels(searchEntries(tabs, 'SAND'))).toEqual(['Sand']);
    expect(labels(searchEntries(tabs, 'l'))).toEqual(['Oil', 'Wall', 'Metal', 'Cool']);
  });

  it('finds tools as well as elements', () => {
    expect(labels(searchEntries(tabs, 'wind'))).toEqual(['Wind']);
  });

  it('matches nothing for an empty or blank query or text that is in no label', () => {
    expect(searchEntries(tabs, '')).toEqual([]);
    expect(searchEntries(tabs, '   ')).toEqual([]);
    expect(searchEntries(tabs, 'zzz')).toEqual([]);
  });

  it('does not search the descriptions', () => {
    expect(searchEntries(tabs, 'barrier')).toEqual([]);
  });
});

describe('picker swatch', () => {
  it('converts linear RGB to the CSS sRGB color', () => {
    expect(swatchColor([0, 0, 0])).toBe('rgb(0 0 0)');
    expect(swatchColor([1, 1, 1])).toBe('rgb(255 255 255)');
    expect(swatchColor([0.5, 0.2, 0.0031308])).toBe('rgb(188 124 10)');
  });
});

describe('M8.1 AC31 paintTarget', () => {
  const target = (key: keyof typeof ELEMENT, temp: number) => paintTarget(ELEMENTS, ELEMENT[key], temp);

  it('follows the transitions the temperature passes', () => {
    expect(target('WATER', -10)).toEqual({ id: ELEMENT.ICE, ignites: false });
    expect(target('WATER', 20)).toEqual({ id: ELEMENT.WATER, ignites: false });
    expect(target('WATER', 110)).toEqual({ id: ELEMENT.STEAM, ignites: false });
    expect(target('STONE', 1300)).toEqual({ id: ELEMENT.LAVA, ignites: false });
    expect(target('METAL', 1600)).toEqual({ id: ELEMENT.MOLTEN_METAL, ignites: false });
    expect(target('ICE', 20)).toEqual({ id: ELEMENT.WATER, ignites: false });
    expect(target('STEAM', 20)).toEqual({ id: ELEMENT.WATER, ignites: false });
  });

  it('stays at exactly a threshold', () => {
    expect(target('WATER', 100).id).toBe(ELEMENT.WATER);
    expect(target('WATER', 0).id).toBe(ELEMENT.WATER);
    expect(target('STONE', 1200).id).toBe(ELEMENT.STONE);
  });

  it('never paints fire: a flammable row past its ignition is itself, flagged as igniting', () => {
    expect(target('OIL', 300)).toEqual({ id: ELEMENT.OIL, ignites: true });
    expect(target('OIL', 250).ignites).toBe(false);
    expect(target('GUNPOWDER', 500)).toEqual({ id: ELEMENT.GUNPOWDER, ignites: true });
  });

  it('gives a row with nothing to pass back as itself', () => {
    expect(target('SAND', 9000)).toEqual({ id: ELEMENT.SAND, ignites: false });
    expect(target('FIRE', 1000)).toEqual({ id: ELEMENT.FIRE, ignites: false });
  });

  it('paints every row except EMPTY: it has a button, or a button row at its own temperature makes it', () => {
    const table: readonly ElementDef[] = ELEMENTS;
    const buttons = table.filter((e) => e.toolbar !== undefined);
    for (const row of table) {
      if (row.id === ELEMENT.EMPTY || row.toolbar !== undefined) continue;
      const reachedBy = buttons.filter((b) => paintTarget(ELEMENTS, b.id, elementTemperature(row)).id === row.id);
      expect(reachedBy.length, `${row.key} has no button and no button's row paints it`).toBeGreaterThan(0);
    }
  });

  it('ICE, STEAM, LAVA and MOLTEN_METAL have no button', () => {
    for (const key of ['ICE', 'STEAM', 'LAVA', 'MOLTEN_METAL'] as const) {
      expect((ELEMENTS as readonly ElementDef[]).find((e) => e.key === key)?.toolbar, key).toBeUndefined();
    }
  });
});

describe('M8.1 AC33 paint temperature', () => {
  const tabs = pickerTabs(ELEMENTS);
  const entry = (label: string): PickerEntry => tabs.flatMap((t) => t.entries).find((e) => e.label === label)!;

  it('starts an entry at its row temperature', () => {
    expect(entry('Water')).toMatchObject({ temperature: 20 });
    expect(entry('Smoke')).toMatchObject({ temperature: 150 });
    expect(entry('Fire')).toMatchObject({ temperature: 1000 });
  });

  it('names what will be painted', () => {
    expect(paintPreview(ELEMENTS, ELEMENT.WATER, -10)).toBe('→ Ice');
    expect(paintPreview(ELEMENTS, ELEMENT.WATER, 110)).toBe('→ Steam');
    expect(paintPreview(ELEMENTS, ELEMENT.STONE, 1300)).toBe('→ Lava');
    expect(paintPreview(ELEMENTS, ELEMENT.OIL, 300)).toBe('→ Oil (ignites)');
    expect(paintPreview(ELEMENTS, ELEMENT.OIL, 20)).toBe('→ Oil');
  });

  it('steps by 10 °C, 100 with Shift, and stays inside absolute zero and the maximum', () => {
    expect(stepPaintTemp(20, 1, false)).toBe(30);
    expect(stepPaintTemp(20, -1, false)).toBe(10);
    expect(stepPaintTemp(20, 1, true)).toBe(120);
    expect(stepPaintTemp(-270, -1, false)).toBe(Math.ceil(ABSOLUTE_ZERO));
    expect(stepPaintTemp(MAX_TEMP - 5, 1, false)).toBe(MAX_TEMP);
    expect(clampPaintTemp(20.4)).toBe(20);
    expect(clampPaintTemp(1e9)).toBe(MAX_TEMP);
    expect(clampPaintTemp(-1e9)).toBe(Math.ceil(ABSOLUTE_ZERO));
  });

  it('finds the nearest row with a button along the transitions', () => {
    const row = (key: string) => ELEMENTS.find((e: ElementDef) => e.key === key)!;
    expect(buttonRow(ELEMENTS, row('STEAM'))?.key).toBe('WATER');
    expect(buttonRow(ELEMENTS, row('ICE'))?.key).toBe('WATER');
    expect(buttonRow(ELEMENTS, row('LAVA'))?.key).toBe('STONE');
    expect(buttonRow(ELEMENTS, row('MOLTEN_METAL'))?.key).toBe('METAL');
    expect(buttonRow(ELEMENTS, row('SAND'))?.key).toBe('SAND');
    expect(buttonRow(ELEMENTS, row('EMPTY'))).toBeUndefined();
  });

  it('search finds a row without a button as the material it is painted from, at its own temperature', () => {
    const steam = searchEntries(tabs, 'steam', ELEMENTS);
    expect(steam).toHaveLength(1);
    expect(steam[0]).toMatchObject({ kind: 'element', id: ELEMENT.WATER, label: 'Steam', temperature: 110 });
    const lava = searchEntries(tabs, 'lava', ELEMENTS);
    expect(lava[0]).toMatchObject({ id: ELEMENT.STONE, label: 'Lava', temperature: 1300 });
    expect(labels(searchEntries(tabs, 'ice', ELEMENTS))).toEqual(['Ice']);
    expect(labels(searchEntries(tabs, 'molten', ELEMENTS))).toEqual(['Molten metal']);
    expect(searchEntries(tabs, 'empty', ELEMENTS)).toEqual([]);
    for (const hit of [...steam, ...lava]) expect(hit.description.trim()).not.toBe('');
  });

  it('search without a table matches buttons only', () => {
    expect(searchEntries(tabs, 'steam')).toEqual([]);
  });
});
