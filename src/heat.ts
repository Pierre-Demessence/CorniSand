import type { ElementDef } from './elements';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from './physics';

// Temperatures, in °C. A cell's stored temperature is its `temp` field (`src/cell-fields.ts`); empty space and walls
// hold no heat, and their `temp` word means nothing.

/** What an element is painted and loaded at when its row names no `temperature`. */
export const ROOM_TEMP = 20;

/** The range a stored temperature stays in, and every temperature of the element table lies in. */
export const ABSOLUTE_ZERO = -273.15;
export const MAX_TEMP = 9999;

/** What the Heat and Cool tools add to or take from every cell of the stroke per frame: about 1,000 °C a second at 60 FPS. */
export const HEAT_TOOL_RATE = 17;

/**
 * Share of the temperature difference per unit of conductivity (W/m·K) and per unit of 1 / capacity (MJ/m³·K) that a
 * pair of neighbors closes in one exchange: PAIR_TIME / CELL_SIZE² of the explicit heat equation, in the table's units.
 */
export const CONDUCTION = PAIR_TIME / CELL_SIZE ** 2 / HEAT_UNIT;

/**
 * The share of the way to their capacity-weighted mean that two neighbors move in one exchange (`exchangeHeat`): the
 * heat equation for a pair of cells, with the harmonic mean of their conductivities (W/m·K) and their capacities
 * (MJ/m³·K), at most 1 (never past the mean). 0 when either conducts nothing. Mirrors the share in `exchangeHeat` in
 * `src/shaders/heat.wgsl.ts`.
 */
export function heatShare(kA: number, cA: number, kB: number, cB: number): number {
  if (!(kA > 0 && kB > 0)) return 0;
  return Math.min(1, CONDUCTION * ((2 * kA * kB) / (kA + kB)) * ((cA + cB) / (cA * cB)));
}

/** The threshold of a transition an element does not have: far enough out that no stored temperature reaches it, and still a finite f32. */
export const NO_THRESHOLD = 3e38;

/**
 * The temperature a cell of this element conducts and shows at: its stored temperature clamped to the element's
 * thresholds. They differ only while the cell takes in or gives out the latent heat of a transition. Mirrors `cellTemp`
 * in `src/shaders/heat.wgsl.ts`.
 */
export function effectiveTemp(e: Pick<ElementDef, 'below' | 'above'>, stored: number): number {
  return Math.min(Math.max(stored, e.below?.temp ?? -NO_THRESHOLD), e.above?.temp ?? NO_THRESHOLD);
}

/** A color stop of a temperature ramp: display RGB (what the canvas shows), 0 to 1 per channel. */
export interface RampKnot {
  temp: number;
  color: readonly [number, number, number];
}

/**
 * The heat view's colors: dark blue when cold, through purple, red and orange to near white. Each knot is brighter than
 * the one before (Rec. 709 luminance), so brightness alone orders the temperatures and the view does not rely on hue
 * (the user is red-green colorblind). Between knots the color is linear; outside the first and last it stays flat.
 * Generates the shader's `heatColor` and the legend's gradient.
 */
export const HEAT_RAMP: readonly RampKnot[] = [
  { temp: -50, color: [0.02, 0.03, 0.30] },
  { temp: 20, color: [0.35, 0.05, 0.45] },
  { temp: 300, color: [0.85, 0.05, 0.10] },
  { temp: 800, color: [1.0, 0.45, 0.05] },
  { temp: 1500, color: [1.0, 0.90, 0.20] },
  { temp: 2000, color: [1.0, 1.0, 0.90] },
];

/** The temperatures the legend labels: the ramp's ends and the steps between, spaced so the labels do not overlap. */
export const HEAT_LEGEND_TEMPS: readonly number[] = [-50, 100, 500, 1000, 2000];

/** Where things start to glow in the normal view (°C), and where the glow is at full weight. */
export const GLOW_START = 525;
export const GLOW_FULL = 2000;

/** The color a glowing cell adds to its own: dull red where glow starts, orange, then yellow-white. Scaled by the glow weight. */
export const GLOW_RAMP: readonly RampKnot[] = [
  { temp: GLOW_START, color: [0.45, 0.08, 0.02] },
  { temp: 1000, color: [0.90, 0.40, 0.05] },
  { temp: 1600, color: [1.0, 0.90, 0.60] },
];

/** A CSS `linear-gradient` over the legend's range (`HEAT_LEGEND_TEMPS`' first to last) in the ramp's colors. */
export function heatRampCSS(ramp: readonly RampKnot[] = HEAT_RAMP): string {
  const first = ramp[0].temp;
  const span = ramp[ramp.length - 1].temp - first;
  const stops = ramp.map((k) => {
    const [r, g, b] = k.color.map((c) => Math.round(c * 255));
    return `rgb(${r} ${g} ${b}) ${(((k.temp - first) / span) * 100).toFixed(2)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
