import { CELL_FIELDS } from '../cell-fields';
import type { ElementDef } from '../elements';
import { elementConstantsWGSL } from './elements.wgsl';

// The hash: what a shader needs even when it does not touch cells.
export const commonWGSL = /* wgsl */`
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

// The element constants, the `Cell` struct and its accessors: what a shader needs to hold cells without binding the
// field buffers (the flyer passes keep a cell in each flyer).
export const cellTypesWGSL = (elements: readonly ElementDef[]): string => /* wgsl */`
${commonWGSL}
${elementConstantsWGSL(elements)}

struct Cell {
${CELL_FIELDS.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}
};

// A struct cannot be compared with ==.
fn cellEq(a: Cell, b: Cell) -> bool {
  return ${names.map((n) => `a.${n} == b.${n}`).join(' && ')};
}

fn cellType(c: Cell) -> u32 { return c.kind & 0xffu; }
fn cellVariant(c: Cell) -> u32 { return (c.kind >> 8u) & 0xffu; }
fn cellLife(c: Cell) -> u32 { return c.life; }
fn cellVelocity(c: Cell) -> vec2f { return unpack2x16float(c.velocity); }
fn cellRemainder(c: Cell) -> vec2f { return unpack2x16float(c.remainder); }

// A new cell: every field but the element, variant and life starts at zero.
fn makeCell(t: u32, variant: u32, life: u32) -> Cell {
  return Cell(${CELL_FIELDS.map((f) => MAKE_CELL_ARGS[f.name] ?? `${f.wgslType}(0)`).join(', ')});
}

// The same cell as another element or another life: every field but the ones named is kept. A rule that changes a
// cell goes through these, never through \`makeCell\`, which would drop the fields it does not know about.
fn withType(c: Cell, t: u32, variant: u32, life: u32) -> Cell {
  var r = c;
  r.kind = t | (variant << 8u);
  r.life = life;
  return r;
}

fn withLife(c: Cell, life: u32) -> Cell {
  var r = c;
  r.life = life;
  return r;
}

fn withMotion(c: Cell, velocity: vec2f, remainder: vec2f) -> Cell {
  var r = c;
  r.velocity = pack2x16float(velocity);
  r.remainder = pack2x16float(remainder);
  return r;
}
`;

// The field buffers as bindings (group 1, binding = field index, generated from CELL_FIELDS) with \`loadCell\`; only a
// read_write pass gets the stores. \`access\` is how the pass binds the fields.
export const cellBindingsWGSL = (access: 'read' | 'read_write'): string => /* wgsl */`
${CELL_FIELDS.map((f, i) => `@group(1) @binding(${i}) var<storage, ${access}> field_${f.name}: array<${f.wgslType}>;`).join('\n')}

fn loadCell(i: u32) -> Cell {
  return Cell(${names.map((n) => `field_${n}[i]`).join(', ')});
}

// The kind word alone, for a pass that decides from the element whether it needs the other fields.
fn loadKind(i: u32) -> u32 { return field_kind[i]; }

${access === 'read_write' ? /* wgsl */`
fn storeCell(i: u32, c: Cell) {
${names.map((n) => `  field_${n}[i] = c.${n};`).join('\n')}
}

// Writes back only the fields of \`c\` that differ from \`before\`, the cell as it was loaded.
fn storeChanged(i: u32, c: Cell, before: Cell) {
${names.map((n) => `  if (c.${n} != before.${n}) { field_${n}[i] = c.${n}; }`).join('\n')}
}
` : ''}
`;

// Shared by every shader that reads cells: the types and the bindings.
export const cellWGSL = (access: 'read' | 'read_write', elements: readonly ElementDef[]): string => /* wgsl */`
${cellTypesWGSL(elements)}
${cellBindingsWGSL(access)}
`;
