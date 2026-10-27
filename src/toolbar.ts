import type { ElementDef } from './elements';
import { HEAT_TOOL_RATE } from './heat';

export interface ToolbarEntry {
  /** The element ID the button paints. */
  id: number;
  label: string;
  /** The number key that selects it: its position, up to 9. */
  key: string | undefined;
}

/** The paintable elements in toolbar order. */
export function toolbarEntries(elements: readonly ElementDef[]): ToolbarEntry[] {
  return elements
    .filter((e) => e.toolbar !== undefined)
    .sort((a, b) => a.toolbar! - b.toolbar!)
    .map((e, i) => ({ id: e.id, label: e.label, key: i < 9 ? String(i + 1) : undefined }));
}

export interface Tool {
  /** The `data-tool` value of its button. */
  id: string;
  label: string;
  /** °C per frame the tool adds to the cells of a stroke (`SimulationInput.heating`). */
  heating: number;
}

/** The tools after the elements: they change the cells under the brush instead of painting. */
export const TOOLS: readonly Tool[] = [
  { id: 'heat', label: 'Heat', heating: HEAT_TOOL_RATE },
  { id: 'cool', label: 'Cool', heating: -HEAT_TOOL_RATE },
];

/** The attributes of an entry's button. */
export function buttonAttributes(entry: ToolbarEntry): Record<string, string> {
  return { type: 'button', class: 'tool-btn', 'data-type': String(entry.id) };
}

/** Adds one button per entry to `container`, in order, and returns them. */
export function renderToolbar(container: HTMLElement, entries: readonly ToolbarEntry[]): HTMLButtonElement[] {
  return entries.map((entry) => {
    const button = container.ownerDocument.createElement('button');
    for (const [name, value] of Object.entries(buttonAttributes(entry))) button.setAttribute(name, value);
    button.textContent = entry.label;
    container.appendChild(button);
    return button;
  });
}

/** The attributes of a tool's button. */
export function toolAttributes(tool: Tool): Record<string, string> {
  return { type: 'button', class: 'tool-btn', 'data-tool': tool.id };
}

/** Adds a separator and one button per tool to `container`, in order, and returns the buttons. */
export function renderTools(container: HTMLElement, tools: readonly Tool[]): HTMLButtonElement[] {
  const doc = container.ownerDocument;
  const separator = doc.createElement('div');
  separator.className = 'separator';
  container.appendChild(separator);
  return tools.map((tool) => {
    const button = doc.createElement('button');
    for (const [name, value] of Object.entries(toolAttributes(tool))) button.setAttribute(name, value);
    button.textContent = tool.label;
    container.appendChild(button);
    return button;
  });
}
