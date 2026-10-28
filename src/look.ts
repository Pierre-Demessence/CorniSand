// How the playing field is drawn (M11, docs/plans/m11-rendering.md). The finished look is the default; the cells look
// draws each cell as itself, with its grain and the wall behind it, and nothing that spills over a cell. The heat and air
// views are precise in both.
export type Look = 'finished' | 'cells';

export interface LookSettings {
  /**
   * How bright the wall behind the field is, 0 to 1: 0 is near black (only hot things shine), 1 a lit room (a mid grey at
   * the top center). The brightness is `WALL_LEVEL` at 0 and rises to `WALL_LEVEL + WALL_RANGE` at 1.
   */
  wall: number;
  /**
   * Strength of the grain shading by state, the brightness change of the lightest and darkest variant as a share of the
   * color: a row's own `look.grain` overrides it. Only powders and solids are shaded.
   */
  grainPowder: number;
  grainSolid: number;
  /**
   * How much the grain of a solid varies across the world, 0 to 1: the grain's strength is scaled by 1 plus or minus this
   * from a smooth noise of the cell's place. A solid never moves, so its blotches stay put; variant 0 stays the table color.
   */
  solidNoise: number;
}

export const LOOK: Readonly<LookSettings> = {
  wall: 0.35,
  grainPowder: 0.1,
  grainSolid: 0.03,
  solidNoise: 0.2,
};

/** The wall's brightness at `wall` 0 and the range above it, at the top center, as a display value (0 to 1). */
export const WALL_LEVEL = 0.04;
export const WALL_RANGE = 0.5;

/** The settings with the defaults applied and the wall's brightness kept in 0..1. */
export function lookSettings(overrides: Partial<LookSettings> = {}): LookSettings {
  const settings = { ...LOOK, ...overrides };
  return { ...settings, wall: Math.min(1, Math.max(0, settings.wall)) };
}

/**
 * The wall's `wall` setting from a `?wall=` value: a number in 0..1, or undefined for an absent or invalid one (the
 * default stays).
 */
export function parseWall(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const wall = Number(value);
  return Number.isFinite(wall) && wall >= 0 && wall <= 1 ? wall : undefined;
}
