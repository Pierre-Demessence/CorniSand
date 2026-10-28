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

// Convection: two cells of one liquid, one above the other, swap places when the upper one is denser. A hot blob in a
// real tank rises at about sqrt(g * beta * dT * L) (beta the thermal expansion, dT its excess over the rest, L the tank's
// height), which grows as the square root of the relative density difference, so the swap chance does too. The gain is
// tuned on tests/convection.test.ts so that a hot block of water in a tank rises at about that estimate (1 gave 0.4 of it,
// 2 gives 1.0, 3 gave 1.9).
/** The swap chance of a pair per dispatch is this times the square root of the relative density difference, at most 1. */
export const CONVECTION_GAIN = 2;

// Viscosity: a thin layer of liquid of depth h spreads under its own weight at about rho * g * h^2 / (3 mu) (a gravity
// current on a floor, mu the dynamic viscosity). The grid does not track depth, so every liquid spreads as a layer of
// this many cells deep (5.4 mm). Set so that water (mu 1e-3 Pa·s) stays at the cap of one cell per dispatch, oil (0.2 Pa·s)
// flows a little slower (0.67) and lava (30 Pa·s) creeps at a few cells per second at 1x (tests/viscosity.test.ts).
/** The depth in cells of the layer whose spreading speed a liquid's viscosity gives. */
export const REF_DEPTH = 4;

/**
 * Speed in cells per dispatch at which a liquid of density `density` (kg/m³) and dynamic viscosity `viscosity` (Pa·s)
 * spreads as a layer `REF_DEPTH` cells deep: rho g h² / (3 mu) in m/s, times the dispatch time over the cell size.
 */
export function spreadSpeed(density: number, viscosity: number): number {
  const h = REF_DEPTH * CELL_SIZE;
  return ((density * G * h * h) / (3 * viscosity)) * (DISPATCH_TIME / CELL_SIZE);
}

/**
 * Chance per dispatch that the denser cell (`upper`, kg/m³) above a lighter one (`lower`) swaps places with it: 0 when
 * the upper is not denser. Mirrors `convectionChance` in `src/shaders/ca.wgsl.ts`.
 */
export function convectionChance(upper: number, lower: number): number {
  if (!(upper > lower)) return 0;
  return Math.min(1, CONVECTION_GAIN * Math.sqrt((upper - lower) / lower));
}

// Angle of repose: a pile of grains stands at the angle at which the grains that slide off its steps come to rest. A grain
// that rests on something and has a free cell diagonally below it slides there (static friction: a step of one cell is
// stable, so a pile of such grains stands at 45 degrees, one cell of height per column). Giving the grain a sideways speed
// as it slides carries it on over the steps below until the surface's friction (`MOVEMENT.friction`) stops it, which
// flattens the pile. Fitted on tests/repose.test.ts (a pile of sand poured from a point, slide speeds from 0.05 to 0.6 cells
// per dispatch): the angle is about 45 degrees minus `REPOSE_FIT` degrees times the square of the speed, to within 3
// degrees from 20 to 45 degrees.
/** The steepest angle of repose a pile can have: a step of one cell is stable. */
export const MAX_REPOSE = 45;

/** The flattest angle of repose the fit covers (a slide speed of about 0.56 cells per dispatch). */
export const MIN_REPOSE = 20;

/** Degrees by which the pile's angle falls below `MAX_REPOSE` per (cell per dispatch)² of slide speed. */
export const REPOSE_FIT = 80;

/**
 * The sideways speed in cells per dispatch a grain gets when it slides off a step, so that a pile of it stands at the
 * angle of repose `repose` (degrees, `MIN_REPOSE` to `MAX_REPOSE`): 0 at `MAX_REPOSE`.
 */
export function slideSpeed(repose: number): number {
  return Math.sqrt((MAX_REPOSE - repose) / REPOSE_FIT);
}
