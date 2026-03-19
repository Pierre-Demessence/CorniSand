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

export interface ParticlePhysics {
  density: number;
  viscosity: number;
  isFluid: boolean;
  isSolid: boolean;
}

export const PARTICLE_PHYSICS: Record<number, ParticlePhysics> = {
  [PARTICLE_TYPES.EMPTY]:  { density: 0.0,  viscosity: 0.0,  isFluid: false, isSolid: false },
  [PARTICLE_TYPES.SAND]:   { density: 2.0,  viscosity: 0.0,  isFluid: false, isSolid: true  },
  [PARTICLE_TYPES.WALL]:   { density: 999., viscosity: 0.0,  isFluid: false, isSolid: true  },
  [PARTICLE_TYPES.WATER]:  { density: 1.0,  viscosity: 0.01, isFluid: true,  isSolid: false },
  [PARTICLE_TYPES.SMOKE]:  { density: 0.1,  viscosity: 0.0,  isFluid: true,  isSolid: false },
  [PARTICLE_TYPES.OIL]:    { density: 0.8,  viscosity: 0.05, isFluid: true,  isSolid: false },
  [PARTICLE_TYPES.FIRE]:    { density: 0.0,  viscosity: 0.0,  isFluid: false, isSolid: false },
};
