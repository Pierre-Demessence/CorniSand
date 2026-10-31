// The world's four sides, each open or closed (docs/simulation.md, "Boundaries"). Through an open side matter leaves the
// world for good; a closed side is an endless wall. Left and right are x < 0 and x >= width, bottom (the floor) is y < 0
// and top is y >= height.

export type Side = 'left' | 'right' | 'bottom' | 'top';
export type EdgeState = 'open' | 'closed';
export type Edges = Readonly<Record<Side, EdgeState>>;

export const SIDES: readonly Side[] = ['left', 'right', 'bottom', 'top'];

// The floor closed and the other sides open, so sand piles on an empty screen while smoke and steam leave through the top.
export const DEFAULT_EDGES: Edges = { left: 'open', right: 'open', bottom: 'closed', top: 'open' };
export const ALL_OPEN: Edges = { left: 'open', right: 'open', bottom: 'open', top: 'open' };
export const ALL_CLOSED: Edges = { left: 'closed', right: 'closed', bottom: 'closed', top: 'closed' };

// The bit of each side in the edges word the shaders read (`edgesWGSL`): set when the side is open.
export const EDGE_BITS: Readonly<Record<Side, number>> = { left: 1, right: 2, bottom: 4, top: 8 };

export const edgesWord = (edges: Edges): number =>
  SIDES.reduce((word, side) => (edges[side] === 'open' ? word | EDGE_BITS[side] : word), 0);

// The value of `?edges=` lists the closed sides by name, comma-separated, in `SIDES` order; `none` is every side open. The
// default (only the floor closed) is no parameter at all, so `bottom` alone is never written for it.
const NONE = 'none';

/**
 * The edges a `?edges=` value names: `null` (no parameter) is `DEFAULT_EDGES`, `none` is every side open, otherwise the
 * listed sides are closed and the rest open. `undefined` for an empty value, an unknown side name or `none` among others.
 */
export function parseEdges(value: string | null): Edges | undefined {
  if (value === null) return DEFAULT_EDGES;
  const names = value.split(',').map((name) => name.trim());
  if (names.length === 1 && names[0] === NONE) return ALL_OPEN;
  const closed = new Set<Side>();
  for (const name of names) {
    const side = SIDES.find((s) => s === name);
    if (side === undefined) return undefined;
    closed.add(side);
  }
  return Object.fromEntries(SIDES.map((side) => [side, closed.has(side) ? 'closed' : 'open'])) as Edges;
}

/** The `?edges=` value for `edges`, or `null` when the parameter is left out (the default). The inverse of `parseEdges`. */
export function formatEdges(edges: Edges): string | null {
  const closed = SIDES.filter((side) => edges[side] === 'closed');
  if (SIDES.every((side) => edges[side] === DEFAULT_EDGES[side])) return null;
  return closed.length === 0 ? NONE : closed.join(',');
}
