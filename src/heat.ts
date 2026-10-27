import type { ElementDef } from './elements';

// Temperatures, in °C. A cell's stored temperature is its `temp` field (`src/cell-fields.ts`); empty space and walls
// hold no heat, and their `temp` word means nothing.

/** What an element is painted and loaded at when its row names no `temperature`. */
export const ROOM_TEMP = 20;

/** The range a stored temperature stays in, and every temperature of the element table lies in. */
export const ABSOLUTE_ZERO = -273.15;
export const MAX_TEMP = 9999;

/** What the Heat and Cool tools add to or take from every cell of the stroke per frame: about 1,000 °C a second at 60 FPS. */
export const HEAT_TOOL_RATE = 17;

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
