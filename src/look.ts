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
  /**
   * How much of the blurred light of the hot cells (the halo) the finished look adds around them, 0 to 1 (0 draws none and
   * records no glow pass): the halo near a large pool is this share of the light the pool radiates.
   */
  glowStrength: number;
  /** Downsamples of the glow chain below the emission texture (half the cells' resolution), 1 to 6; each doubles the halo's reach. */
  glowLevels: number;
  /**
   * How dark the shadow of fully opaque matter is on the wall behind it, 0 to 1: the wall under a stone's shadow shows
   * `1 - shadowDarkness` of its brightness. 0 draws no shadow and records no shadow pass.
   */
  shadowDarkness: number;
  /** How far a shadow reaches, in cover texels (4 cells each), 1 to 64: it fades to nothing over this distance. */
  shadowLength: number;
  /**
   * How much of the wall a full cloud of gas hides, 0 to 1: gas cells are drawn as a soft layer (smoke, steam) whose
   * strength is the share of gas cells around, times this. 0 draws gas as cells, as the cells look does, and records no
   * gas texture.
   */
  gasOpacity: number;
  /**
   * How much deeper the finished look draws a liquid than it is, 0 or more: the liquid's tint is its absorption per cell
   * times the depth above it in cells times this. Real water absorbs so little that 128 cells (17 cm) would show almost
   * nothing. 0 draws no tint and records no coverage pass for it.
   */
  depthScale: number;
  /** The direction toward the light on the screen, x to the right and y up: shadows fall the opposite way. Any non-zero vector. */
  lightDirection: readonly [number, number];
  /**
   * How far hot air shifts the picture behind it, in cells: at `SHIMMER_SPAN` degrees above room temperature or more, each
   * pixel reads the picture up to this far from its place, by a noise that rises with time. 0 draws no heat shimmer.
   */
  shimmer: number;
  /** Cells the picture shifts per unit of pressure gradient (pressure per cell): about 2 cells across a blast's front. 0 draws none. */
  shimmerPressure: number;
  /** The most the shimmer shifts a pixel, in cells, heat and pressure together. */
  shimmerMax: number;
}

export const LOOK: Readonly<LookSettings> = {
  wall: 0.35,
  grainPowder: 0.1,
  grainSolid: 0.03,
  solidNoise: 0.2,
  glowStrength: 0.08,
  glowLevels: 4,
  shadowDarkness: 0.7,
  shadowLength: 24,
  gasOpacity: 0.8,
  depthScale: 100,
  lightDirection: [-1, 1],
  shimmer: 1.5,
  shimmerPressure: 10,
  shimmerMax: 3,
};

/** Degrees above room temperature at which the air's heat shimmer reaches its full amplitude, and the dead zone below which air is at rest. */
export const SHIMMER_SPAN = 500;
export const SHIMMER_DEAD = 1;
/** Cells between the lattice points of the shimmer's noise, and cells per second its pattern rises. */
export const SHIMMER_SIZE = 6;
export const SHIMMER_RISE = 12;

/** Cover texels (4 cells each) of the column above a liquid pixel that its depth is summed over; a deeper liquid saturates. */
export const DEPTH_TEXELS = 32;

const MAX_GLOW_LEVELS = 6;
const MAX_SHADOW_LENGTH = 64;

/** The wall's brightness at `wall` 0 and the range above it, at the top center, as a display value (0 to 1). */
export const WALL_LEVEL = 0.04;
export const WALL_RANGE = 0.5;

/**
 * The settings with the defaults applied, the wall's brightness, the glow strength and the shadow's darkness kept in 0..1,
 * the gas opacity in 0..1, the depth scale 0 or more, the glow levels a whole number in 1..6, the shadow's length a whole
 * number in 1..64 and the light's direction a unit vector (the default when it is zero or not finite).
 */
export function lookSettings(overrides: Partial<LookSettings> = {}): LookSettings {
  const settings = { ...LOOK, ...overrides };
  return {
    ...settings,
    wall: Math.min(1, Math.max(0, settings.wall)),
    glowStrength: Math.min(1, Math.max(0, settings.glowStrength)),
    glowLevels: Math.min(MAX_GLOW_LEVELS, Math.max(1, Math.round(settings.glowLevels))),
    shadowDarkness: Math.min(1, Math.max(0, settings.shadowDarkness)),
    gasOpacity: Math.min(1, Math.max(0, settings.gasOpacity)),
    depthScale: Number.isFinite(settings.depthScale) ? Math.max(0, settings.depthScale) : LOOK.depthScale,
    shadowLength: Math.min(MAX_SHADOW_LENGTH, Math.max(1, Math.round(settings.shadowLength))),
    lightDirection: unitVector(settings.lightDirection) ?? unitVector(LOOK.lightDirection)!,
    shimmer: nonNegative(settings.shimmer, LOOK.shimmer),
    shimmerPressure: nonNegative(settings.shimmerPressure, LOOK.shimmerPressure),
    shimmerMax: nonNegative(settings.shimmerMax, LOOK.shimmerMax),
  };
}

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function unitVector([x, y]: readonly [number, number]): readonly [number, number] | undefined {
  const length = Math.hypot(x, y);
  return Number.isFinite(length) && length > 0 ? [x / length, y / length] : undefined;
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
