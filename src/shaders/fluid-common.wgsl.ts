import { FLUID, PARTICLE_KIND } from '../fluid-params';

/** Bytes of the WGSL `Particle` struct { px, py, vx, vy: f32, kind: u32 }; the array stride. */
export const PARTICLE_BYTES = 20;
/** Words of the WGSL `FluidState` struct. */
export const STATE_WORDS = 5;
/** Particle passes use workgroups of this many threads. */
export const PARTICLE_WORKGROUP = 256;
/** Cell and face passes use 8x8 workgroups. */
export const GRID_WORKGROUP = 8;

// A float literal WGSL accepts: `2` must read `2.0`.
const f32 = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

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
const COUNT_CLAMP: u32 = ${FLUID.countClamp}u;

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
