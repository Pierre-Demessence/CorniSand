import { cellName, elementTemperature, type ElementDef, type Transition } from './elements';
import { ABSOLUTE_ZERO, HEAT_TOOL_RATE, MAX_TEMP } from './heat';

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
  /** The element ID the entry selects: the row of a button, or for a row without one the row with a button it is painted from. */
  id: number;
  /** °C the temperature field shows once the entry is picked: its row's `temperature`. */
  temperature: number;
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
      .map((e): ElementEntry => ({ kind: 'element', id: e.id, label: e.label, description: e.description ?? '', tab: category, color: e.color, temperature: elementTemperature(e) }));
    if (entries.length > 0) tabs.push({ name: category, entries });
  }
  if (tools.length > 0) {
    tabs.push({ name: TOOLS_TAB, entries: tools.map((tool): ToolEntry => ({ kind: 'tool', tool, label: tool.label, description: tool.description, tab: TOOLS_TAB })) });
  }
  return tabs;
}

/**
 * The row with a button (a `toolbar` position) that paints `row`: `row` itself, or the nearest one along its transitions
 * (`below` and `above`), found breadth first. Undefined when none is reachable.
 */
export function buttonRow(table: readonly ElementDef[], row: ElementDef): ElementDef | undefined {
  const byKey = new Map(table.map((e) => [e.key, e]));
  const seen = new Set<string>();
  let frontier = [row];
  while (frontier.length > 0) {
    const found = frontier.find((e) => e.toolbar !== undefined);
    if (found) return found;
    const next: ElementDef[] = [];
    for (const e of frontier) {
      seen.add(e.key);
      for (const step of [e.below, e.above]) {
        const target = step && byKey.get(step.becomes);
        if (target && !seen.has(target.key) && !next.includes(target)) next.push(target);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * The entries whose label contains `query`, ignoring case, in tab order; none for a query of only spaces. With the `table`,
 * a row without a button of its own that matches follows them, as an entry that selects the row with a button it is
 * painted from, at the matching row's temperature (Steam: Water at 110 °C).
 */
export function searchEntries(tabs: readonly PickerTab[], query: string, table: readonly ElementDef[] = []): PickerEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const entries = tabs.flatMap((tab) => tab.entries);
  const direct = entries.filter((entry) => entry.label.toLowerCase().includes(needle));
  const buttons = new Map(entries.flatMap((entry) => (entry.kind === 'element' ? [[entry.id, entry] as const] : [])));
  const reached = table
    .filter((row) => row.toolbar === undefined && row.label.toLowerCase().includes(needle))
    .flatMap((row): ElementEntry[] => {
      const button = buttonRow(table, row);
      const entry = button && buttons.get(button.id);
      if (!entry) return [];
      const temperature = elementTemperature(row);
      return [{ ...entry, label: row.label, color: row.color, temperature, description: `Painted as ${entry.label} at ${temperature} °C.` }];
    });
  return [...direct, ...reached];
}

/**
 * What the brush writes: the element, and whether a flammable row painted past its ignition temperature catches fire by
 * itself.
 */
export interface PaintTarget {
  id: number;
  ignites: boolean;
}

/**
 * The element a brush of `id` painted at `temp` (°C) writes: from the row, follows `above` while `temp` is above its
 * threshold and `below` while it is under (the stored temperature is compared with the threshold itself, latent heat not
 * yet taken in), so water at -10 °C is ice, steel at 1,600 °C is molten steel and sand at 1,800 °C is molten glass. At exactly a
 * threshold the row stays. A change into a plasma (fire) is never followed: the row is painted as itself, flagged as igniting.
 */
export function paintTarget(table: readonly ElementDef[], id: number, temp: number): PaintTarget {
  const byKey = new Map<string, ElementDef>(table.map((e) => [e.key, e]));
  let row: ElementDef | undefined = table.find((e) => e.id === id);
  if (!row) throw new Error(`paintTarget: no element with id ${id}`);
  const seen = new Set<number>();
  while (!seen.has(row.id)) {
    seen.add(row.id);
    const step: Transition | undefined = row.above && temp > row.above.temp ? row.above : row.below && temp < row.below.temp ? row.below : undefined;
    const next: ElementDef | undefined = step && byKey.get(step.becomes);
    if (!next) break;
    if (next.state === 'plasma') return { id: row.id, ignites: true };
    row = next;
  }
  return { id: row.id, ignites: false };
}

/** The paint temperature kept to whole degrees inside `ABSOLUTE_ZERO`..`MAX_TEMP`. */
export function clampPaintTemp(temp: number): number {
  return Math.min(MAX_TEMP, Math.max(Math.ceil(ABSOLUTE_ZERO), Math.round(temp)));
}

/** The paint temperature one step up (`direction` 1) or down (-1): 10 °C, 100 °C when `big`. */
export function stepPaintTemp(temp: number, direction: 1 | -1, big: boolean): number {
  return clampPaintTemp(temp + direction * (big ? 100 : 10));
}

/** The preview beside the temperature field: the name of what a brush of `id` at `temp` paints (`cellName`), and whether it ignites. */
export function paintPreview(table: readonly ElementDef[], id: number, temp: number): string {
  const target = paintTarget(table, id, temp);
  return `→ ${cellName(table, target.id)}${target.ignites ? ' (ignites)' : ''}`;
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
  /** Receives the paint temperature field: its steps, the field and the preview. Hidden while a tool is selected. */
  paint: HTMLElement;
  search: HTMLInputElement;
}

export interface Picker {
  /** The entries on show: the search's matches, or the tab's. The n-th is selected by number key n. */
  shown(): PickerEntry[];
  /** Selects `entry`: shows its tab, clears the search, sets the paint temperature to the entry's and calls `onChange`. */
  choose(entry: PickerEntry): void;
  /** The paint temperature in °C (meaningless while a tool is selected). */
  temperature(): number;
  focusSearch(): void;
}

/**
 * Fills `parts` from `tabs` and keeps them in step with the selection. `initial` is selected without calling `onChange`
 * (the caller applies it). `onChange` hears every pick and every change of the paint temperature. Enter in the search
 * selects its first match, Escape clears it; picking an entry clears it too. `elements` names what the brush will paint
 * and lets the search find rows without a button.
 */
export function renderPicker(
  parts: PickerParts,
  tabs: readonly PickerTab[],
  initial: PickerEntry,
  onChange: (entry: PickerEntry, temperature: number) => void,
  elements: readonly ElementDef[],
): Picker {
  const doc = parts.tabs.ownerDocument;
  let activeTab = Math.max(0, tabs.findIndex((tab) => tab.name === initial.tab));
  let selected = initial;
  let temperature = initial.kind === 'element' ? initial.temperature : 0;
  let query = '';
  let entryButtons = new Map<PickerEntry, HTMLButtonElement>();
  const tabButtons: HTMLButtonElement[] = [];

  const shown = (): PickerEntry[] => (query.trim() === '' ? tabs[activeTab].entries : searchEntries(tabs, query, elements));

  // The paint temperature: steps of 10 °C (100 with Shift), the field and what will be painted.
  const stepButton = (text: string, label: string): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'tool-btn picker-step';
    button.setAttribute('aria-label', label);
    button.textContent = text;
    return button;
  };
  const minus = stepButton('−', 'Colder by 10 degrees (Shift: 100)');
  const plus = stepButton('+', 'Warmer by 10 degrees (Shift: 100)');
  const field = doc.createElement('input');
  field.setAttribute('type', 'number');
  field.setAttribute('step', '10');
  field.id = 'picker-temperature';
  field.setAttribute('aria-label', 'Paint temperature in degrees Celsius');
  const unit = doc.createElement('span');
  unit.textContent = '°C';
  const preview = doc.createElement('span');
  preview.className = 'picker-preview';
  preview.setAttribute('aria-live', 'polite');
  parts.paint.append(minus, field, unit, plus, preview);

  function renderPaint(writeField: boolean): void {
    parts.paint.hidden = selected.kind !== 'element';
    if (writeField) field.value = String(temperature);
    preview.textContent = selected.kind === 'element' ? paintPreview(elements, selected.id, temperature) : '';
  }

  function setTemperature(next: number): void {
    temperature = clampPaintTemp(next);
    renderPaint(true);
    onChange(selected, temperature);
  }

  minus.addEventListener('click', (e) => setTemperature(stepPaintTemp(temperature, -1, e.shiftKey)));
  plus.addEventListener('click', (e) => setTemperature(stepPaintTemp(temperature, 1, e.shiftKey)));
  field.addEventListener('input', () => {
    const typed = field.valueAsNumber;
    if (!Number.isFinite(typed)) return;
    temperature = clampPaintTemp(typed);
    renderPaint(false);
    onChange(selected, temperature);
  });
  field.addEventListener('change', () => renderPaint(true));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') field.blur();
  });

  function renderSelected(): void {
    parts.selected.replaceChildren();
    const label = doc.createElement('span');
    label.className = 'picker-selected-label';
    label.textContent = 'Selected:';
    parts.selected.appendChild(label);
    if (selected.kind === 'element') parts.selected.appendChild(swatch(selected));
    parts.selected.appendChild(doc.createTextNode(selected.label));
    renderPaint(true);
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
    // A row without a button selects the button's own entry, at the temperature of the row that was found.
    selected = entry.kind === 'element' ? tabs.flatMap((t) => t.entries).find((e) => e.kind === 'element' && e.id === entry.id) ?? entry : entry;
    if (entry.kind === 'element') temperature = entry.temperature;
    if (tab >= 0) activeTab = tab;
    clearSearch();
    renderSelected();
    if (rebuild) renderEntries();
    else markSelected();
    onChange(selected, temperature);
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
  return { shown, choose, temperature: () => temperature, focusSearch: () => parts.search.focus() };
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
