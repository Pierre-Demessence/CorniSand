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
