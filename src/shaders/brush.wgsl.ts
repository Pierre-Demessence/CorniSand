import type { ElementDef } from '../elements';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// Brush uniform: vec2f prev, vec2f cur, f32 radius, 3 x u32 flags, u32 seed, 3 pad = 48 bytes
export const BRUSH_UNIFORM_WORDS = 12;

// Paints or erases along the segment prev -> cur, in place. Each thread only
// touches its own cell, so the pass runs before the CA steps and block rules
// never see a half-painted block.
export const brushWGSL = (width: number, height: number, elements: readonly ElementDef[]): string => /* wgsl */`
${cellWGSL('read_write', elements)}
${elementsWGSL}

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

@group(0) @binding(0) var<uniform> b: BrushUniforms;

const W: u32 = ${width}u;
const H: u32 = ${height}u;

// Whether the brush stroke along prev -> cur reaches the cell at integer position pos.
fn brushReaches(pos: vec2f) -> bool {
  let ab = b.cur - b.prev;
  let segLen2 = dot(ab, ab);
  var t: f32 = 0.0;
  if (segLen2 > 0.001) {
    t = clamp(dot(pos - b.prev, ab) / segLen2, 0.0, 1.0);
  }
  return length(pos - (b.prev + t * ab)) <= b.radius;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }

  let pos = vec2f(f32(gid.x), f32(gid.y));
  if (!brushReaches(pos)) { return; }

  let idx = gid.y * W + gid.x;
  let current = loadCell(idx);

  if (b.erasing == 1u) {
    storeCell(idx, makeCell(EL_EMPTY, 0u, 0u));
    return;
  }

  if (cellType(current) == EL_EMPTY || (b.replacing == 1u && cellType(current) != EL_WALL)) {
    let variant = hash2(gid.x, gid.y, b.seed) & 0xffu;
    storeCell(idx, makeCell(b.particleType, variant, elLifeStart(b.particleType)));
  }
}
`;
