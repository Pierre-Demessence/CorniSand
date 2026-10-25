import { FLUID, FLUID_FLAG, PARTICLE_KIND } from '../fluid-params';

/** Bytes of the WGSL `Particle` struct { px, py, vx, vy: f32, kind: u32 }; the array stride. */
export const PARTICLE_BYTES = 20;
/** Words of the WGSL `FluidState` struct. */
export const STATE_WORDS = 5;
/** Particle passes use workgroups of this many threads. */
export const PARTICLE_WORKGROUP = 256;
/** Cell and face passes use 8x8 workgroups. */
export const GRID_WORKGROUP = 8;

/** Workgroups per row of a list dispatch: n listed tiles run as (min(n, LIST_ROW), ceil(n / LIST_ROW)) workgroups. */
export const LIST_ROW = 4096;

/** The tiles of the fluid grid: `GRID_WORKGROUP` x `GRID_WORKGROUP` cells, one per workgroup of a cell or face pass. */
export const tileGrid = (width: number, height: number): { columns: number; rows: number; count: number } => {
  const columns = Math.ceil((width + 1) / GRID_WORKGROUP);
  const rows = Math.ceil((height + 1) / GRID_WORKGROUP);
  return { columns, rows, count: columns * rows };
};

/** Indirect dispatch arguments (and the direct dispatch size) of a list of `n` tiles. */
export const listDispatch = (n: number): [number, number, number] => [Math.min(n, LIST_ROW), Math.max(1, Math.ceil(n / LIST_ROW)), 1];

// A float literal WGSL accepts: `2` must read `2.0`.
const f32 = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * A list of tiles that a pass runs over instead of the whole grid: word 0 is the count, then the tile ids
 * (`row * GRID_GROUPS_X + column`) in ascending order. Workgroup i of the dispatch (LIST_ROW per row) takes tile i.
 * `tileCell` is the thread's `global_invocation_id` for the tile its workgroup got: x is 0xFFFFFFFF beyond the end
 * of the list, which every `x < W` style bounds test rejects, and z is the tile id. Control flow around barriers
 * must not depend on it; test `listed(wid)` (the same for the whole workgroup) instead.
 */
export const tilesWGSL = (binding: number): string => /* wgsl */`
@group(0) @binding(${binding}) var<storage, read> tileList: array<u32>;
const LIST_ROW: u32 = ${LIST_ROW}u;
const NO_CELL = vec3u(0xFFFFFFFFu, 0xFFFFFFFFu, 0u);

fn listed(wid: vec3u) -> bool { return wid.y * LIST_ROW + wid.x < tileList[0]; }

fn tileCell(wid: vec3u, lid: vec3u) -> vec3u {
  if (!listed(wid)) { return NO_CELL; }
  let t = tileList[1u + wid.y * LIST_ROW + wid.x];
  return vec3u((t % GRID_GROUPS_X) * ${GRID_WORKGROUP}u + lid.x, (t / GRID_GROUPS_X) * ${GRID_WORKGROUP}u + lid.y, t);
}
`;

// Shared by every fluid shader, so the grid size, the capacity, the constants of `fluid-params.ts` and the particle
// layout exist once. Include `cellWGSL` as well where cell types are needed.
export const fluidCommonWGSL = (width: number, height: number, capacity: number): string => /* wgsl */`

const W: u32 = ${width}u;
const H: u32 = ${height}u;
const CAPACITY: u32 = ${capacity}u;

// One 2D indirect dispatch covers the cells and the (W + 1) x (H + 1) faces of both velocity components.
const GRID_GROUPS_X: u32 = ${Math.ceil((width + 1) / GRID_WORKGROUP)}u;
const GRID_GROUPS_Y: u32 = ${Math.ceil((height + 1) / GRID_WORKGROUP)}u;

const PER_CELL: u32 = ${FLUID.perCell}u;
const LATTICE = array<vec2f, ${FLUID.lattice.length}>(${FLUID.lattice.map(([x, y]) => `vec2f(${f32(x)}, ${f32(y)})`).join(', ')});

const GRAVITY: f32 = ${f32(FLUID.gravity)};
const OMEGA: f32 = ${f32(FLUID.omega)};
const THETA: f32 = ${f32(FLUID.theta)};
const FLIP_RATIO: f32 = ${f32(FLUID.flipRatio)};
const DAMPING: f32 = ${f32(FLUID.damping)};
const STIFFNESS: f32 = ${f32(FLUID.stiffness)};
const PULL: f32 = ${f32(FLUID.pull)};
const MAX_SPEED: f32 = ${f32(FLUID.maxSpeed)};
const FIXED_SCALE: f32 = ${f32(FLUID.fixedScale)};
// Fixed-point weight a face needs before it carries a velocity.
const MIN_WEIGHT: f32 = ${f32(FLUID.minWeight * FLUID.fixedScale)};
const OIL_DENSITY: f32 = ${f32(FLUID.oilDensity)};
const RESOLVE_LIFT: f32 = ${f32(FLUID.resolveLift)};
const COUNT_CLAMP: u32 = ${FLUID.countClamp}u;

const FLAG_AIR: u32 = ${FLUID_FLAG.AIR}u;
const FLAG_LIQUID: u32 = ${FLUID_FLAG.LIQUID}u;
const FLAG_SOLID: u32 = ${FLUID_FLAG.SOLID}u;

const KIND_WATER: u32 = ${PARTICLE_KIND.WATER}u;
const KIND_OIL: u32 = ${PARTICLE_KIND.OIL}u;
// Dead particles stay in the buffer until the next frame's compaction but must not count, scatter or move.
const KIND_DEAD: u32 = ${PARTICLE_KIND.DEAD}u;

struct Particle {
  px: f32,
  py: f32,
  vx: f32,
  vy: f32,
  kind: u32,
};

// count: live particles after the last compaction. spawnCursor: next free slot, where the brush appends.
// compactCursor: write position of the running compaction. water, oil: per-kind totals of the live particles.
struct FluidState {
  count: atomic<u32>,
  spawnCursor: atomic<u32>,
  compactCursor: atomic<u32>,
  water: atomic<u32>,
  oil: atomic<u32>,
};

fn cellIndex(x: u32, y: u32) -> u32 { return y * W + x; }

// The cell a position lies in, kept inside the grid.
fn cellOf(px: f32, py: f32) -> vec2u {
  return min(vec2u(vec2f(max(px, 0.0), max(py, 0.0))), vec2u(W - 1u, H - 1u));
}
`;
