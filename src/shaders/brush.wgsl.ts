import type { ElementDef } from '../elements';
import { ABSOLUTE_ZERO, MAX_TEMP } from '../heat';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// Brush uniform: vec2f prev, vec2f cur, f32 radius, 3 x u32 flags, u32 seed, f32 heating, f32 paintTemp = 44 bytes, padded to 48
export const BRUSH_UNIFORM_WORDS = 12;

// The brush uniform (group 0, binding 0) and the test of whether a stroke reaches a position: shared by the cell brush
// and the pass that removes flyers.
export const BRUSH_COMMON_WGSL = /* wgsl */`
struct BrushUniforms {
  prev: vec2f,
  cur: vec2f,
  radius: f32,
  particleType: u32,
  erasing: u32,
  replacing: u32,
  seed: u32,
  heating: f32,
  paintTemp: f32,
};

@group(0) @binding(0) var<uniform> b: BrushUniforms;

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
`;

// Paints or erases along the segment prev -> cur, in place. Each thread only
// touches its own cell, so the pass runs before the CA steps and block rules
// never see a half-painted block. A painted cell starts at the brush's paint temperature (the element's own by default); replacing a cell discards its temperature with the rest of it. With `heating` set (the Heat and Cool
// tools) it paints nothing: it adds `heating` °C to the stored temperature of every cell that holds heat, within
// absolute zero and the table's maximum, widened to the whole latent range of the element's thresholds (a condensing
// steam cell's stored temperature runs under absolute zero, and the tools never cut that progress), and leaves empty
// space and walls alone.
export const brushWGSL = (width: number, height: number, elements: readonly ElementDef[]): string => /* wgsl */`
${cellWGSL('read_write', elements)}
${elementsWGSL}

${BRUSH_COMMON_WGSL}

const W: u32 = ${width}u;
const H: u32 = ${height}u;

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

  if (b.heating != 0.0) {
    let t = cellType(current);
    if (elHoldsHeat(t)) {
      var lowest = ${ABSOLUTE_ZERO};
      if (elBelowTemp(t) > -1e30) { lowest = min(lowest, elBelowTemp(t) - elBelowWidth(t)); }
      var highest = ${MAX_TEMP}.0;
      if (elAboveTemp(t) < 1e30) { highest = max(highest, elAboveTemp(t) + elAboveWidth(t)); }
      storeCell(idx, withTemp(current, clamp(cellStoredTemp(current) + b.heating, lowest, highest)));
    }
    return;
  }

  if (cellType(current) == EL_EMPTY || (b.replacing == 1u && cellType(current) != EL_WALL)) {
    let variant = hash2(gid.x, gid.y, b.seed) & 0xffu;
    let painted = makeCell(b.particleType, variant, elLifeStart(b.particleType));
    storeCell(idx, withTemp(painted, b.paintTemp));
  }
}
`;
