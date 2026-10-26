// The per-cell fields, in binding order: the one list every buffer, bind group and shader accessor is generated from.
// Each field is one 32-bit word per cell in its own storage buffer (`u32`, `i32` or `f32`; a packed pair is a `u32`
// read with `unpack2x16float`). Adding a field is one entry here plus the rules that use it.
export interface CellField {
  name: string;
  wgslType: 'u32' | 'i32' | 'f32';
}

export const CELL_FIELDS = [
  // Bits 0-7 element, 8-15 variant (random, set at paint time), 16-31 reserved.
  { name: 'kind', wgslType: 'u32' },
  // Fire: the remaining lifetime. Liquids: the sideways direction the cell last moved in (0 none, 1 left, 2 right).
  { name: 'life', wgslType: 'u32' },
] as const satisfies readonly CellField[];

export type CellFieldName = (typeof CELL_FIELDS)[number]['name'];

// One array per field, `width * height` words each; row y = 0 is the bottom.
export type CellData = Record<CellFieldName, Uint32Array<ArrayBuffer>>;

// Every field is one 32-bit word, so every field buffer has this many bytes per cell. The device's buffer limits apply
// to one buffer, not to the sum, so this (not the sum over the fields) sizes the grid.
export const FIELD_BYTES = 4;

export function emptyCellData(cellCount: number): CellData {
  return Object.fromEntries(CELL_FIELDS.map(({ name }) => [name, new Uint32Array(cellCount)])) as CellData;
}
