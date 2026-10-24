import { cellWGSL } from './cell.wgsl';

// Paints or erases along the segment prev -> cur, in place. Each thread only
// touches its own cell, so the pass needs no second buffer and runs before the
// CA steps: block rules never see a half-painted block.
export const brushWGSL = (width: number, height: number): string => /* wgsl */`
${cellWGSL}

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

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> b: BrushUniforms;

const W: u32 = ${width}u;
const H: u32 = ${height}u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }

  let pos = vec2f(f32(gid.x), f32(gid.y));
  let ab = b.cur - b.prev;
  let segLen2 = dot(ab, ab);
  var t: f32 = 0.0;
  if (segLen2 > 0.001) {
    t = clamp(dot(pos - b.prev, ab) / segLen2, 0.0, 1.0);
  }
  if (length(pos - (b.prev + t * ab)) > b.radius) { return; }

  let idx = gid.y * W + gid.x;
  let current = cells[idx];

  if (b.erasing == 1u) {
    cells[idx] = makeCell(TYPE_EMPTY, 0u, 0u);
    return;
  }

  if (cellType(current) == TYPE_EMPTY || (b.replacing == 1u && cellType(current) != TYPE_WALL)) {
    let variant = hash2(gid.x, gid.y, b.seed) & 0xffu;
    var life: u32 = 0u;
    if (b.particleType == TYPE_FIRE) { life = FIRE_MAX_LIFE; }
    cells[idx] = makeCell(b.particleType, variant, life);
  }
}
`;
