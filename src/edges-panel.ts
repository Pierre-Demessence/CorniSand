import { SIDES, formatEdges, type EdgeState, type Edges, type Side } from './edges';

// The player's name for each side: the bottom is the floor.
export const SIDE_LABELS: Readonly<Record<Side, string>> = { left: 'Left', right: 'Right', bottom: 'Floor', top: 'Top' };

/** The text of a side's toggle: "Floor: closed". The state is said in words, not only by the bar's line style. */
export function edgeLabel(side: Side, state: EdgeState): string {
  return `${SIDE_LABELS[side]}: ${state}`;
}

/** The query string (with its `?`, or empty) that keeps `edges` and every other parameter; the default writes no parameter. */
export function edgesSearch(search: string, edges: Edges): string {
  const params = new URLSearchParams(search);
  const value = formatEdges(edges);
  if (value === null) params.delete('edges');
  else params.set('edges', value);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Fills `panel` (hidden to start) with the Edges panel: one toggle per side around a square, each labeled with its side and
 * state and drawn with a solid bar when closed and a dashed one when open. A click flips that side and calls `onChange` with
 * the new edges. `button` opens and closes the panel; Escape and a click outside close it.
 */
export function renderEdgesPanel(
  button: HTMLButtonElement,
  panel: HTMLElement,
  initial: Edges,
  onChange: (edges: Edges) => void,
): void {
  const doc = panel.ownerDocument;
  let edges = initial;

  const toggles = new Map<Side, HTMLButtonElement>();
  const grid = doc.createElement('div');
  grid.className = 'edges-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'World edges');
  for (const side of SIDES) {
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = `edge-toggle edge-${side}`;
    const text = doc.createElement('span');
    text.className = 'edge-text';
    const bar = doc.createElement('span');
    bar.className = 'edge-bar';
    toggle.append(text, bar);
    toggle.addEventListener('click', () => {
      edges = { ...edges, [side]: edges[side] === 'open' ? 'closed' : 'open' };
      update();
      onChange(edges);
    });
    toggles.set(side, toggle);
    grid.appendChild(toggle);
  }
  const world = doc.createElement('div');
  world.className = 'edges-world';
  grid.appendChild(world);
  panel.replaceChildren(grid);

  function update(): void {
    for (const [side, toggle] of toggles) {
      toggle.dataset.state = edges[side];
      toggle.querySelector('.edge-text')!.textContent = edgeLabel(side, edges[side]);
    }
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-pressed', String(open));
  }

  update();
  setOpen(false);
  button.addEventListener('click', () => { setOpen(panel.hidden === true); });
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    setOpen(false);
    button.focus();
  });
  doc.addEventListener('pointerdown', (e) => {
    if (panel.hidden || !(e.target instanceof Node)) return;
    if (!panel.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
}
