export const PARTICLE_TYPES = {
  EMPTY: 0,
  SAND: 1,
  WALL: 2,
  WATER: 3,
  SMOKE: 4,
  OIL: 5,
  FIRE: 6,
} as const;

// Lifetime a fire cell starts with; it burns down each CA step.
export const FIRE_MAX_LIFE = 200;
