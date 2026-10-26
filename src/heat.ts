// Temperatures, in °C. A cell's stored temperature is its `temp` field (`src/cell-fields.ts`); empty space and walls
// hold no heat, and their `temp` word means nothing.

/** What an element is painted and loaded at when its row names no `temperature`. */
export const ROOM_TEMP = 20;

/** The range a stored temperature stays in, and every temperature of the element table lies in. */
export const ABSOLUTE_ZERO = -273.15;
export const MAX_TEMP = 9999;
