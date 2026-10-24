import { cellWGSL } from './cell.wgsl';
import { fluidCommonWGSL } from './fluid-common.wgsl';

// Brush uniform: vec2f prev, vec2f cur, f32 radius, 3 x u32 flags, u32 seed, 3 pad = 48 bytes
export const BRUSH_UNIFORM_WORDS = 12;

// The brush shape, shared by the cell brush and the particle kill so both reach exactly the same cells.
export const brushShapeWGSL = /* wgsl */`

struct BrushUniforms {
  prev: vec2f,
  cur: vec2f,
  radius: f32,
  particleType: u32,
  erasing: u32,
  replacing: u32,
  seed: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

// Whether the brush stroke along prev -> cur reaches the cell at integer position pos.
fn brushReaches(b: BrushUniforms, pos: vec2f) -> bool {
  let ab = b.cur - b.prev;
  let segLen2 = dot(ab, ab);
  var t: f32 = 0.0;
  if (segLen2 > 0.001) {
    t = clamp(dot(pos - b.prev, ab) / segLen2, 0.0, 1.0);
  }
  return length(pos - (b.prev + t * ab)) <= b.radius;
}
`;

// Paints or erases along the segment prev -> cur, in place. Each thread only
// touches its own cell, so the pass needs no second buffer and runs before the
// CA steps: block rules never see a half-painted block. Painting a liquid
// appends its particles to the current particle buffer, after the live ones.
export const brushWGSL = (width: number, height: number, capacity: number): string => /* wgsl */`
${cellWGSL}
${fluidCommonWGSL(width, height, capacity)}
${brushShapeWGSL}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> b: BrushUniforms;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> state: FluidState;

// Reserves PER_CELL slots after the live particles and fills them. When the store cannot hold them the
// reserved slots that exist are marked dead, so compaction drops them, and the caller leaves the cell alone.
fn spawnParticles(cell: vec2u, kind: u32) -> bool {
  let base = atomicAdd(&state.spawnCursor, PER_CELL);
  if (base + PER_CELL > CAPACITY) {
    for (var j = 0u; j < PER_CELL; j++) {
      if (base + j < CAPACITY) { particles[base + j].kind = KIND_DEAD; }
    }
    return false;
  }
  for (var j = 0u; j < PER_CELL; j++) {
    let offset = LATTICE[j];
    particles[base + j] = Particle(f32(cell.x) + offset.x, f32(cell.y) + offset.y, 0.0, 0.0, kind);
  }
  return true;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }

  let pos = vec2f(f32(gid.x), f32(gid.y));
  if (!brushReaches(b, pos)) { return; }

  let idx = cellIndex(gid.x, gid.y);
  let current = cells[idx];

  if (b.erasing == 1u) {
    cells[idx] = makeCell(TYPE_EMPTY, 0u, 0u);
    return;
  }

  if (cellType(current) == TYPE_EMPTY || (b.replacing == 1u && cellType(current) != TYPE_WALL)) {
    if (b.particleType == TYPE_WATER || b.particleType == TYPE_OIL) {
      let kind = select(KIND_WATER, KIND_OIL, b.particleType == TYPE_OIL);
      if (!spawnParticles(gid.xy, kind)) { return; }
    }
    let variant = hash2(gid.x, gid.y, b.seed) & 0xffu;
    var life: u32 = 0u;
    if (b.particleType == TYPE_FIRE) { life = FIRE_MAX_LIFE; }
    cells[idx] = makeCell(b.particleType, variant, life);
  }
}
`;
