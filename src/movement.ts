// Constants of the velocity movement (docs/decisions.md "Cells move by velocity"). Units: cells and dispatches (one
// Margolus pass); y = 0 is the bottom row. What an element sets for itself (`gravity`, `drag`) is in the element table.
export const MOVEMENT = {
  // A cell in the grid moves at most this many cells per dispatch along each axis (a 2x2 block has room for one).
  maxSpeed: 1,
  // A cell faster than this leaves the grid as a flyer, and a flyer slower than this lands. Above the diagonal of
  // `maxSpeed` (1.41), so a launch refused at the flyer cap stays in the grid clamped to `maxSpeed` and does not
  // count as a launch again.
  launchSpeed: 1.5,
  // The speed limit of any cell or flyer, so the path a flyer walks in one dispatch stays short.
  maxFlyerSpeed: 16,
  // Share of its sideways speed a cell resting on something loses per dispatch it is found resting (every other
  // dispatch, as it is the top cell of its block every other dispatch). Without it, debris that lands keeps sliding
  // along a flat surface until it meets a wall.
  friction: 1 / 4,
  // Below this sideways speed a resting cell stops: a share lost per dispatch never reaches 0 by itself in binary16.
  restSpeed: 1 / 256,
  // The most flyers in the air at once; past it, launching cells stay in the grid. A claim key holds the slot in 18 bits.
  maxFlyers: 1 << 18,
  // A flyer that fails to land this many times counts as jammed (`FlyerStats.jammed`).
  jamRetries: 8,
} as const;

/** Largest `maxFlyers` the claim keys can address. */
export const MAX_FLYER_SLOTS = 1 << 18;

/** A WGSL float literal. */
export const wgslFloat = (x: number): string => {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
};

export const movementWGSL = (maxFlyers: number): string => /* wgsl */`
const MAX_SPEED: f32 = ${wgslFloat(MOVEMENT.maxSpeed)};
const LAUNCH_SPEED: f32 = ${wgslFloat(MOVEMENT.launchSpeed)};
const MAX_FLYER_SPEED: f32 = ${wgslFloat(MOVEMENT.maxFlyerSpeed)};
const FRICTION: f32 = ${wgslFloat(MOVEMENT.friction)};
const REST_SPEED: f32 = ${wgslFloat(MOVEMENT.restSpeed)};
const MAX_FLYERS: u32 = ${maxFlyers}u;
const JAM_RETRIES: u32 = ${MOVEMENT.jamRetries}u;
`;

// Workgroups of the offset-1 CA dispatch, where the CA counts the launches: one launch count per workgroup.
export function launchGroups(width: number, height: number): { x: number; y: number } {
  return { x: Math.ceil(Math.ceil((width + 1) / 2) / 8), y: Math.ceil(Math.ceil((height + 1) / 2) / 8) };
}
