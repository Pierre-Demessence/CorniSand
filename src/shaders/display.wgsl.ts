import type { ElementDef } from '../elements';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatDisplayWGSL, heatWGSL } from './heat.wgsl';

// `graphics` maps a graphics name (`ElementDef.graphics`) to its WGSL color function.
export const displayWGSL = (elements: readonly ElementDef[], graphics: Readonly<Record<string, string>>): string => {
  const styled = elements.filter((e) => e.graphics !== undefined);
  for (const e of styled) if (!(e.graphics! in graphics)) throw new Error(`element ${e.key}: unknown graphics "${e.graphics}"`);
  const graphicsNames = [...new Set(styled.map((e) => e.graphics!))];

  return /* wgsl */`
${cellWGSL('read', elements)}
${elementsWGSL}
${heatWGSL}
${heatDisplayWGSL}
${graphicsNames.map((n) => graphics[n]).join('\n')}

struct DisplayUniforms {
  simResolution: vec2f,
  screenResolution: vec2f,
  mousePos: vec2f,
  brushSize: f32,
  showBrush: f32,
  erasing: f32,
  replacing: f32,
  heatView: f32,
  _pad: f32,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle: 3 vertices, no buffer needed
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 0.0),
    vec2f(2.0, 0.0),
    vec2f(0.0, 2.0),
  );
  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  out.uv = uv[vertexIndex];
  return out;
}

@group(0) @binding(0) var<uniform> u: DisplayUniforms;
// The kind word of the flyer in each cell, 0 where none flies (src/shaders/flyers.wgsl.ts, overlayWGSL).
@group(3) @binding(0) var<storage, read> flyerKinds: array<u32>;

fn ditherNoise(pos: vec2f) -> f32 {
  return fract(sin(dot(pos, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;
  let w = u32(u.simResolution.x);
  let h = u32(u.simResolution.y);
  let cellX = min(u32(uv.x * u.simResolution.x), w - 1u);
  let cellY = min(u32(uv.y * u.simResolution.y), h - 1u);
  let idx = cellY * w + cellX;
  var cell = loadCell(idx);
  // A flyer is drawn in the empty cell it is over; one over a filled cell (it lands there next step) is not.
  var overFlyer = false;
  if (cellType(cell) == EL_EMPTY) {
    cell.kind = flyerKinds[idx];
    overFlyer = cellType(cell) != EL_EMPTY;
  }
  let pType = cellType(cell);

  // Background gradient with dithering
  let gy = in.position.y / u.screenResolution.y;
  var color = mix(vec3f(0.06, 0.06, 0.08), vec3f(0.10, 0.10, 0.13), gy);
  color += (ditherNoise(in.position.xy) - 0.5) / 128.0;

  // A flyer's cell is empty, so its temp word means nothing: the flyer is drawn in its element's color, with no glow or
  // heat color.
  if (pType != EL_EMPTY) {
    color = elColor(pType);
    let holdsHeat = !overFlyer && elHoldsHeat(pType);
    if (u.heatView > 0.5) {
      if (holdsHeat) {
        color = heatColor(cellTemp(cell));
      } else if (!overFlyer) {
        color *= 0.3;
      }
    } else {
      var hasGraphics = false;
      switch (pType) {
${styled.map((e) => `        case EL_${e.key}: { color = graphics_${e.graphics}(cell, color); hasGraphics = true; }`).join('\n')}
        default: {}
      }
      if (holdsHeat && !hasGraphics) {
        let t = cellTemp(cell);
        color += glowColor(t) * glowWeight(t);
      }
    }
  }

  // Brush cursor
  if (u.showBrush > 0.5) {
    let simPos = uv * u.simResolution;
    let dist = length(simPos - u.mousePos);
    let pixelSize = u.simResolution.x / u.screenResolution.x;
    let ringWidth = max(1.0, 1.5 * pixelSize);

    if (abs(dist - u.brushSize) < ringWidth) {
      var ringColor = vec3f(0.9, 0.9, 0.9);
      if (u.erasing > 0.5) {
        ringColor = vec3f(0.95, 0.30, 0.30);
      } else if (u.replacing > 0.5) {
        ringColor = vec3f(0.95, 0.70, 0.20);
      }
      color = mix(color, ringColor, 0.55);
    }
  }

  return vec4f(color, 1.0);
}
`;
};
