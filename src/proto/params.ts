// Constants of the M4.1 movement prototype (docs/plans/m4-element-engine.md), frozen before the first measurement.
// Units: cells, dispatches. y = 0 is the bottom row.

export type MovementModel = 'baseline' | 'a' | 'c';

export const PROTO = {
  // Added to every grain's downward speed each dispatch: a grain reaches A's top speed after falling 16 cells.
  gravity: 1 / 32,
  // A's speed limit on each axis, and the speed a landing flyer keeps.
  maxSpeed: 1,
  // Share of a grain's sideways speed lost each time it is found resting on something (every other dispatch).
  // Without it, debris that lands keeps sliding along a flat surface until it meets a wall.
  friction: 1 / 4,
  // Share of a flyer's velocity lost per dispatch.
  flyerDrag: 1 / 64,
  // C: a grain faster than this leaves the grid as a flyer, and a flyer slower than this lands.
  launchSpeed: 1.5,
  // C: the most flyers in the air at once; past it, cells stay in the grid with their speed clamped to `maxSpeed`.
  maxFlyers: 1 << 18,
  // C: the speed of grains and flyers is clamped to this, so the path a flyer walks per dispatch stays short.
  maxFlyerSpeed: 16,
  // C: a flyer that fails to land this many times counts as jammed (decision rule c6).
  jamRetries: 8,
} as const;

// Variant bit set by `blast` on every grain it pushes, so P2 can follow them.
export const BLAST_MARK = 1;

// The prototype constants for `timeScale` times as many dispatches per unit of game time: velocities shrink by the
// scale, accelerations by its square, and the per-dispatch losses so that the loss per unit of game time is unchanged.
// The speed limits stay in cells per dispatch, which is what more steps per frame buys (T4).
export function scaledParams(timeScale: number): { gravity: number; friction: number; flyerDrag: number; launchSpeed: number } {
  const perStep = (loss: number): number => 1 - (1 - loss) ** (1 / timeScale);
  return {
    gravity: PROTO.gravity / timeScale ** 2,
    // Friction applies once per two dispatches whatever the scale, so it scales like a per-dispatch loss.
    friction: perStep(PROTO.friction),
    flyerDrag: perStep(PROTO.flyerDrag),
    launchSpeed: PROTO.launchSpeed / timeScale,
  };
}
