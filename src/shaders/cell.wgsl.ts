import { CELL_FIELDS } from '../cell-fields';
import { FIRE_MAX_LIFE, PARTICLE_TYPES } from '../particles';

// IDs, constants and the hash: what a shader needs even when it does not touch cells.
export const commonWGSL = /* wgsl */`

const TYPE_EMPTY: u32 = ${PARTICLE_TYPES.EMPTY}u;
const TYPE_SAND: u32  = ${PARTICLE_TYPES.SAND}u;
const TYPE_WALL: u32  = ${PARTICLE_TYPES.WALL}u;
const TYPE_WATER: u32 = ${PARTICLE_TYPES.WATER}u;
const TYPE_SMOKE: u32 = ${PARTICLE_TYPES.SMOKE}u;
const TYPE_OIL: u32   = ${PARTICLE_TYPES.OIL}u;
const TYPE_FIRE: u32  = ${PARTICLE_TYPES.FIRE}u;

const FIRE_MAX_LIFE: u32 = ${FIRE_MAX_LIFE}u;

// PCG-RXS-M-XS 32-bit output hash (O'Neill's pcg_hash).
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Random word for a 2D integer coordinate (block or cell) and a per-step seed.
fn hash2(x: u32, y: u32, seed: u32) -> u32 {
  return pcg(x ^ pcg(y ^ seed));
}
`;

const names = CELL_FIELDS.map((f) => f.name);

// How `makeCell(t, variant, life)` fills each field; a field not listed starts at zero.
const MAKE_CELL_ARGS: Partial<Record<string, string>> = { kind: 't | (variant << 8u)', life: 'life' };

// Shared by every shader that reads cells: `commonWGSL`, plus a `Cell` struct, the field bindings (group 1, binding =
// field index, generated from CELL_FIELDS) and the accessors. `access` is how the pass binds the fields; only a
// read_write pass gets the stores.
export const cellWGSL = (access: 'read' | 'read_write'): string => /* wgsl */`
${commonWGSL}

struct Cell {
${CELL_FIELDS.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}
};

${CELL_FIELDS.map((f, i) => `@group(1) @binding(${i}) var<storage, ${access}> field_${f.name}: array<${f.wgslType}>;`).join('\n')}

fn loadCell(i: u32) -> Cell {
  return Cell(${names.map((n) => `field_${n}[i]`).join(', ')});
}

// A struct cannot be compared with ==.
fn cellEq(a: Cell, b: Cell) -> bool {
  return ${names.map((n) => `a.${n} == b.${n}`).join(' && ')};
}

${access === 'read_write' ? /* wgsl */`
fn storeCell(i: u32, c: Cell) {
${names.map((n) => `  field_${n}[i] = c.${n};`).join('\n')}
}

// Writes back only the fields of \`c\` that differ from \`before\`, the cell as it was loaded.
fn storeChanged(i: u32, c: Cell, before: Cell) {
${names.map((n) => `  if (c.${n} != before.${n}) { field_${n}[i] = c.${n}; }`).join('\n')}
}
` : ''}

fn cellType(c: Cell) -> u32 { return c.kind & 0xffu; }
fn cellVariant(c: Cell) -> u32 { return (c.kind >> 8u) & 0xffu; }
fn cellLife(c: Cell) -> u32 { return c.life; }

fn makeCell(t: u32, variant: u32, life: u32) -> Cell {
  return Cell(${CELL_FIELDS.map((f) => MAKE_CELL_ARGS[f.name] ?? `${f.wgslType}(0)`).join(', ')});
}
`;
