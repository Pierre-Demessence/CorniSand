// The per-cell fields, in binding order: the one list every buffer, bind group and shader accessor is generated from.
// Each field is one 32-bit word per cell in its own storage buffer (`u32`, `i32` or `f32`; a packed pair is a `u32`
// read with `unpack2x16float`). Adding a field is one entry here plus the rules that use it.
export interface CellField {
  name: string;
  wgslType: 'u32' | 'i32' | 'f32';
}

export const CELL_FIELDS = [
  // Bits 0-7 element, 8-15 variant (random, set at paint time), 16-31 reserved (zero; `kindWord`).
  { name: 'kind', wgslType: 'u32' },
  // Fire: the remaining lifetime. Liquids: the sideways direction the cell last moved in (0 none, 1 left, 2 right).
  { name: 'life', wgslType: 'u32' },
  // Motion, 8 bytes per cell: the velocity in cells per dispatch and the sub-cell remainder, each two binary16 values
  // (x in the low half, y in the high half; `pack2x16float`). Zero for anything that does not fall.
  { name: 'velocity', wgslType: 'u32' },
  { name: 'remainder', wgslType: 'u32' },
  // The stored temperature in °C (`src/heat.ts`). Meaningless for a cell that holds no heat (empty space, walls).
  { name: 'temp', wgslType: 'f32' },
] as const satisfies readonly CellField[];

/** A `kind` word: the element and the variant. */
export function kindWord(type: number, variant = 0): number {
  return (type | (variant << 8)) >>> 0;
}

export type CellFieldName = (typeof CELL_FIELDS)[number]['name'];

// One array per field, `width * height` words each; row y = 0 is the bottom. An `f32` field holds the float's bits
// (`tempView`).
export type CellData = Record<CellFieldName, Uint32Array<ArrayBuffer>>;

// Every field is one 32-bit word, so every field buffer has this many bytes per cell. The device's buffer limits apply
// to one buffer, not to the sum, so this (not the sum over the fields) sizes the grid.
export const FIELD_BYTES = 4;

// The flyer overlay holds the kind word and the temperature of the flyer in each cell (`src/flyers.ts`): one buffer of two
// words per cell, which the device's buffer limits cap on its own like a field buffer.
export const OVERLAY_BYTES = 2 * FIELD_BYTES;

export function emptyCellData(cellCount: number): CellData {
  return Object.fromEntries(CELL_FIELDS.map(({ name }) => [name, new Uint32Array(cellCount)])) as CellData;
}

/** The `temp` words as the temperatures they hold: writing to the view writes the words. */
export function tempView<B extends ArrayBufferLike>(data: { temp: Uint32Array<B> }): Float32Array<B> {
  return new Float32Array(data.temp.buffer, data.temp.byteOffset, data.temp.length);
}
