// The grid's physical scale: what one cell and one dispatch are in meters and seconds. Every physical property of the
// element table (conductivity, heat capacity, latent heat, ...) is in SI-based units and converts to cells and
// dispatches here, so a change of scale is a change of this file (`docs/decisions.md` "The grid has a physical scale
// from its gravity").

/** Standard gravity, m/s². */
export const G = 9.81;

// A grain reaches the CA's top speed (1 cell per dispatch) after falling 16 cells.
/** Downward acceleration of a powder or liquid in cells per dispatch²: the anchor of the scale. */
export const DEFAULT_GRAVITY = 1 / 32;

/** Dispatches per second at 1x speed: 4 supersteps of 2 dispatches per frame at 60 frames per second. */
export const DISPATCHES_PER_SECOND = 480;

/** Seconds in one dispatch (one Margolus pass). */
export const DISPATCH_TIME = 1 / DISPATCHES_PER_SECOND;

/**
 * Meters in one cell: the size for which `DEFAULT_GRAVITY` cells per dispatch² is `G` at `DISPATCH_TIME`. About 1.36 mm.
 */
export const CELL_SIZE = (G * DISPATCH_TIME ** 2) / DEFAULT_GRAVITY;

/**
 * Seconds between two exchanges of one pair of neighbors: a pair shares a 2x2 block on one of the two offsets, so it
 * exchanges once per superstep (every second dispatch).
 */
export const PAIR_TIME = 2 * DISPATCH_TIME;

/** Joules per cubic meter and kelvin in one unit of the table's heat capacity (MJ/m³·K); also joules per cubic meter in one unit of latent heat (MJ/m³). */
export const HEAT_UNIT = 1e6;
