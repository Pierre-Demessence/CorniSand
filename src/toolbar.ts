import type { ElementDef } from './elements';

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
