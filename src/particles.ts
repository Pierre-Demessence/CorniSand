export const PARTICLE_TYPES = {
  EMPTY: 0,
  SAND: 1,
  WALL: 2,
  WATER: 3,
  SMOKE: 4,
  OIL: 5,
  FIRE: 6,
} as const;

export type ParticleType = typeof PARTICLE_TYPES[keyof typeof PARTICLE_TYPES];

export const VALID_PARTICLE_TYPES = new Set<number>(Object.values(PARTICLE_TYPES));
