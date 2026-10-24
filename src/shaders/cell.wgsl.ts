import { FIRE_MAX_LIFE, PARTICLE_TYPES } from '../particles';

// One cell is a single u32: bits 0-7 type, 8-15 variant, 16-31 lifetime.
export const CELL_BYTES = 4;

// Shared by every shader that reads cells, so IDs, layout and hash exist once.
export const cellWGSL = /* wgsl */`

const TYPE_EMPTY: u32 = ${PARTICLE_TYPES.EMPTY}u;
const TYPE_SAND: u32  = ${PARTICLE_TYPES.SAND}u;
const TYPE_WALL: u32  = ${PARTICLE_TYPES.WALL}u;
const TYPE_WATER: u32 = ${PARTICLE_TYPES.WATER}u;
const TYPE_SMOKE: u32 = ${PARTICLE_TYPES.SMOKE}u;
const TYPE_OIL: u32   = ${PARTICLE_TYPES.OIL}u;
const TYPE_FIRE: u32  = ${PARTICLE_TYPES.FIRE}u;

const FIRE_MAX_LIFE: u32 = ${FIRE_MAX_LIFE}u;

fn cellType(c: u32) -> u32 { return c & 0xffu; }
fn cellVariant(c: u32) -> u32 { return (c >> 8u) & 0xffu; }
fn cellLife(c: u32) -> u32 { return c >> 16u; }

fn makeCell(t: u32, variant: u32, life: u32) -> u32 {
  return t | (variant << 8u) | (life << 16u);
}

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
