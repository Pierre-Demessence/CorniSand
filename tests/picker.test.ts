import { describe, expect, it } from 'vitest';
import { ELEMENTS, type ElementDef } from '../src/elements';
import { CATEGORIES, TOOLS, TOOLS_TAB, entryForKey, entryKey, pickerTabs, searchEntries, swatchColor, type PickerEntry } from '../src/toolbar';

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
      Liquids: ['Water', 'Oil', 'Lava'],
      Gases: ['Smoke', 'Steam'],
      Solids: ['Wall', 'Stone', 'Ice'],
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
    expect(labels(searchEntries(tabs, 'ea'))).toEqual(['Steam', 'Heat']);
    expect(labels(searchEntries(tabs, 'SAND'))).toEqual(['Sand']);
    expect(labels(searchEntries(tabs, 'l'))).toEqual(['Oil', 'Lava', 'Wall', 'Metal', 'Cool']);
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
