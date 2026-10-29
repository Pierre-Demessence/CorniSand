import type { ElementDef } from './elements';
import { HEAT_TOOL_RATE } from './heat';

/**
 * The picker's tabs for elements, in order. A paintable element names one in `ElementDef.category`; a tab with no entry is
 * not shown. The tools have a tab of their own after these (`TOOLS_TAB`).
 */
export const CATEGORIES = ['Powders', 'Liquids', 'Gases', 'Solids', 'Metals', 'Explosives', 'Special', 'Life'] as const;
export type Category = (typeof CATEGORIES)[number];

/** The last tab: Heat, Cool and Wind. */
export const TOOLS_TAB = 'Tools';

export interface Tool {
  /** The `data-tool` value of its button. */
  id: string;
  label: string;
  /** One sentence for the entry's tooltip. */
  description: string;
  /** °C per frame the tool adds to the cells of a stroke (`SimulationInput.heating`). */
  heating: number;
  /** `'wind'`: the tool blows the air under the stroke instead of changing cells (`SimulationInput.wind`). */
  air?: 'wind';
}

/** The tools after the elements: they change the cells (Heat, Cool) or the air (Wind) under the brush instead of painting. */
export const TOOLS: readonly Tool[] = [
  { id: 'heat', label: 'Heat', description: 'Warms the cells under the brush while you hold the button down.', heating: HEAT_TOOL_RATE },
  { id: 'cool', label: 'Cool', description: 'Cools the cells under the brush while you hold the button down.', heating: -HEAT_TOOL_RATE },
  { id: 'wind', label: 'Wind', description: 'Drag to blow the air along the stroke; light things drift with it.', heating: 0, air: 'wind' },
];

interface EntryBase {
  label: string;
  /** The tooltip. */
  description: string;
  /** The name of the tab that holds it: a `Category` or `TOOLS_TAB`. */
  tab: string;
}

/** A paintable element. */
export interface ElementEntry extends EntryBase {
  kind: 'element';
  /** The element ID the entry paints. */
  id: number;
  /** Linear RGB, 0-1: the swatch's color. */
  color: readonly [number, number, number];
}

/** A tool. */
export interface ToolEntry extends EntryBase {
  kind: 'tool';
  tool: Tool;
}

export type PickerEntry = ElementEntry | ToolEntry;

export interface PickerTab {
  name: string;
  /** In `toolbar` order (tools in `TOOLS` order). */
  entries: PickerEntry[];
}

/**
 * The picker's tabs: one per category that holds a paintable element (a row with `toolbar`), in `CATEGORIES` order, each
 * with its entries by `toolbar` position, then the Tools tab. Every paintable element and tool is in exactly one tab.
 */
export function pickerTabs(elements: readonly ElementDef[], tools: readonly Tool[] = TOOLS): PickerTab[] {
  const tabs: PickerTab[] = [];
  for (const category of CATEGORIES) {
    const entries = elements
      .filter((e) => e.toolbar !== undefined && e.category === category)
      .sort((a, b) => a.toolbar! - b.toolbar!)
      .map((e): ElementEntry => ({ kind: 'element', id: e.id, label: e.label, description: e.description ?? '', tab: category, color: e.color }));
    if (entries.length > 0) tabs.push({ name: category, entries });
  }
  if (tools.length > 0) {
    tabs.push({ name: TOOLS_TAB, entries: tools.map((tool): ToolEntry => ({ kind: 'tool', tool, label: tool.label, description: tool.description, tab: TOOLS_TAB })) });
  }
  return tabs;
}

/** The entries whose label contains `query`, ignoring case, in tab order; none for a query of only spaces. */
export function searchEntries(tabs: readonly PickerTab[], query: string): PickerEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return tabs.flatMap((tab) => tab.entries).filter((entry) => entry.label.toLowerCase().includes(needle));
}

/** The number key that selects the entry at `index` of the entries shown: 1 to 9, none after the ninth. */
export function entryKey(index: number): string | undefined {
  return index >= 0 && index < 9 ? String(index + 1) : undefined;
}

/** The entry a key press selects among the `shown` entries: the n-th for 1 to 9, none with Ctrl, Alt or Meta (those belong to the browser). */
export function entryForKey(
  shown: readonly PickerEntry[],
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
): PickerEntry | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
  if (!/^[1-9]$/.test(event.key)) return undefined;
  return shown[Number(event.key) - 1];
}

/** A linear RGB color (0-1) as the CSS color it is displayed as. */
export function swatchColor(color: readonly [number, number, number]): string {
  const encode = (c: number): number => {
    const v = Math.min(1, Math.max(0, c));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  return `rgb(${encode(color[0])} ${encode(color[1])} ${encode(color[2])})`;
}

/** The elements of the DOM that `renderPicker` fills. */
export interface PickerParts {
  /** Receives one button per tab. */
  tabs: HTMLElement;
  /** Receives the buttons of the tab shown, or of the search's matches. */
  entries: HTMLElement;
  /** Names the selected entry. */
  selected: HTMLElement;
  search: HTMLInputElement;
}

export interface Picker {
  /** The entries on show: the search's matches, or the tab's. The n-th is selected by number key n. */
  shown(): PickerEntry[];
  /** Selects `entry`: shows its tab, clears the search and calls `onSelect`. */
  choose(entry: PickerEntry): void;
  focusSearch(): void;
}

/**
 * Fills `parts` from `tabs` and keeps them in step with the selection. `initial` is selected without calling `onSelect`
 * (the caller applies it). Enter in the search selects its first match, Escape clears it; picking an entry clears it too.
 */
export function renderPicker(parts: PickerParts, tabs: readonly PickerTab[], initial: PickerEntry, onSelect: (entry: PickerEntry) => void): Picker {
  const doc = parts.tabs.ownerDocument;
  let activeTab = Math.max(0, tabs.findIndex((tab) => tab.name === initial.tab));
  let selected = initial;
  let query = '';
  let entryButtons = new Map<PickerEntry, HTMLButtonElement>();
  const tabButtons: HTMLButtonElement[] = [];

  const shown = (): PickerEntry[] => (query.trim() === '' ? tabs[activeTab].entries : searchEntries(tabs, query));

  function renderSelected(): void {
    parts.selected.replaceChildren();
    const label = doc.createElement('span');
    label.className = 'picker-selected-label';
    label.textContent = 'Selected:';
    parts.selected.appendChild(label);
    if (selected.kind === 'element') parts.selected.appendChild(swatch(selected));
    parts.selected.appendChild(doc.createTextNode(selected.label));
  }

  function swatch(entry: ElementEntry): HTMLElement {
    const el = doc.createElement('span');
    el.className = 'picker-swatch';
    el.style.background = swatchColor(entry.color);
    return el;
  }

  function markSelected(): void {
    tabButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === activeTab)));
    for (const [entry, button] of entryButtons) {
      const on = entry === selected;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  function renderEntries(): void {
    parts.entries.replaceChildren();
    entryButtons = new Map();
    const list = shown();
    if (list.length === 0) {
      const none = doc.createElement('span');
      none.className = 'picker-empty';
      none.textContent = `No element or tool matches "${query.trim()}".`;
      parts.entries.appendChild(none);
    }
    list.forEach((entry, i) => {
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      button.className = 'tool-btn picker-entry';
      if (entry.kind === 'element') button.setAttribute('data-type', String(entry.id));
      else button.setAttribute('data-tool', entry.tool.id);
      button.setAttribute('data-tip', entry.description);
      if (entry.kind === 'element') button.appendChild(swatch(entry));
      button.appendChild(doc.createTextNode(entry.label));
      const key = entryKey(i);
      if (key !== undefined) {
        const hint = doc.createElement('span');
        hint.className = 'picker-key';
        hint.textContent = key;
        button.appendChild(hint);
      }
      button.addEventListener('click', () => choose(entry));
      parts.entries.appendChild(button);
      entryButtons.set(entry, button);
    });
    markSelected();
  }

  function clearSearch(): void {
    query = '';
    parts.search.value = '';
  }

  function choose(entry: PickerEntry): void {
    const tab = tabs.findIndex((t) => t.name === entry.tab);
    const rebuild = query.trim() !== '' || (tab >= 0 && tab !== activeTab);
    selected = entry;
    if (tab >= 0) activeTab = tab;
    clearSearch();
    renderSelected();
    if (rebuild) renderEntries();
    else markSelected();
    onSelect(entry);
  }

  tabs.forEach((tab, i) => {
    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'tool-btn picker-tab';
    button.textContent = tab.name;
    button.addEventListener('click', () => {
      activeTab = i;
      clearSearch();
      renderEntries();
    });
    parts.tabs.appendChild(button);
    tabButtons.push(button);
  });

  parts.search.addEventListener('input', () => {
    query = parts.search.value;
    renderEntries();
  });
  parts.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = shown()[0];
      if (query.trim() !== '' && first) {
        choose(first);
        parts.search.blur();
      }
    } else if (e.key === 'Escape') {
      clearSearch();
      renderEntries();
      parts.search.blur();
    }
  });

  renderSelected();
  renderEntries();
  return { shown, choose, focusSearch: () => parts.search.focus() };
}

/** Which of the two views that replace the materials' colors is on; at most one is. */
export interface Views {
  heat: boolean;
  air: boolean;
}

/** The views after toggling `which`: turning one on turns the other off. */
export function toggleView(views: Views, which: keyof Views): Views {
  const on = !views[which];
  return { heat: which === 'heat' ? on : false, air: which === 'air' ? on : false };
}

/** Adds a separator and the heat view toggle to `container`; its `aria-pressed` says whether the view is on. */
export function renderHeatViewToggle(container: HTMLElement): HTMLButtonElement {
  const doc = container.ownerDocument;
  const separator = doc.createElement('div');
  separator.className = 'separator';
  container.appendChild(separator);
  const button = doc.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('class', 'tool-btn');
  button.setAttribute('aria-pressed', 'false');
  button.textContent = 'Heat view';
  container.appendChild(button);
  return button;
}

/** Adds the air view toggle to `container`, after the heat view's; its `aria-pressed` says whether the view is on. */
export function renderAirViewToggle(container: HTMLElement): HTMLButtonElement {
  const button = container.ownerDocument.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('class', 'tool-btn');
  button.setAttribute('aria-pressed', 'false');
  button.textContent = 'Air view';
  container.appendChild(button);
  return button;
}
