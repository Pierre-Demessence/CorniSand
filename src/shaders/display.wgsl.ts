import { AIR, AIR_VIEW, PRESSURE_RAMP, type AirShape } from '../air';
import type { ElementDef } from '../elements';
import { ROOM_TEMP } from '../heat';
import { wgslFloat } from '../movement';
import { airSamplersWGSL } from './air.wgsl';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatDisplayWGSL, heatWGSL, rampWGSL } from './heat.wgsl';

// What the display reads of the air: `airCentersAt` (pressure and temperature) and `airWindAt` (velocity, grid cells
// per dispatch) at a point of the grid, in grid cells. The air state is bound at group 0, binding 1; without air both
// return the air at rest and `HAS_AIR` is false, so the heat view leaves empty space as it is.
const airDisplayWGSL = (shape: AirShape | undefined): string => !shape ? /* wgsl */`
const HAS_AIR: bool = false;
fn airCentersAt(pos: vec2f) -> vec2f { return vec2f(0.0, ${wgslFloat(ROOM_TEMP)}); }
fn airWindAt(pos: vec2f) -> vec2f { return vec2f(0.0); }
` : /* wgsl */`
const HAS_AIR: bool = true;
// Array columns and rows: one more than the air cells (the ghost column and row).
const AW: i32 = ${shape.columns + 1};
const AH: i32 = ${shape.rows + 1};
const AIR_S: f32 = ${wgslFloat(shape.cellSize)};
@group(0) @binding(1) var<storage, read> airState: array<vec4f>;
${airSamplersWGSL('airState')}

// The pressure and temperature of an array position; the air beyond the array is at rest at room temperature.
fn centersAt(a: i32, b: i32) -> vec2f {
  if (!inArray(a, b)) { return vec2f(0.0, ${wgslFloat(ROOM_TEMP)}); }
  return airState[airIndex(a, b)].zw;
}

// Pressure and temperature at a grid point, bilinear between the centers of the four air cells around it.
fn airCentersAt(pos: vec2f) -> vec2f {
  let fx = pos.x / AIR_S + 0.5;
  let fy = pos.y / AIR_S + 0.5;
  let a = i32(floor(fx));
  let b = i32(floor(fy));
  let tx = fx - f32(a);
  let ty = fy - f32(b);
  return mix(mix(centersAt(a, b), centersAt(a + 1, b), tx), mix(centersAt(a, b + 1), centersAt(a + 1, b + 1), tx), ty);
}

fn airWindAt(pos: vec2f) -> vec2f {
  let x = pos.x / AIR_S + 1.0;
  let y = pos.y / AIR_S + 1.0;
  return vec2f(sampleU(x, y), sampleV(x, y));
}
`;

// The wind marks of the air view: one arrow per tile of screen pixels, pointing downwind. `windMark` returns the
// coverage of the light line (x) and of its dark outline (y) at a pixel (y up, as the uv).
const windMarkWGSL = /* wgsl */`
const MARK_SPACING: f32 = ${wgslFloat(AIR_VIEW.spacing)};
const MARK_MAX: f32 = ${wgslFloat(AIR_VIEW.maxLength)};
const MARK_MIN: f32 = ${wgslFloat(AIR_VIEW.minLength)};
const MARK_EXPONENT: f32 = ${wgslFloat(AIR_VIEW.exponent)};
const MARK_MAX_SPEED: f32 = ${wgslFloat(AIR.maxSpeed)};
// The arrowhead's strokes leave the tip at 30 degrees from the line.
const HEAD_COS: f32 = 0.8660254;
const HEAD_SIN: f32 = 0.5;

fn segmentDistance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
  return length(p - (a + t * ab));
}

fn windMark(pixel: vec2f) -> vec2f {
  let center = (floor(pixel / MARK_SPACING) + 0.5) * MARK_SPACING;
  let wind = airWindAt(center / u.screenResolution * u.simResolution);
  let speed = length(wind);
  let length_ = MARK_MAX * pow(min(speed / MARK_MAX_SPEED, 1.0), MARK_EXPONENT);
  if (length_ < MARK_MIN) { return vec2f(0.0); }
  let dir = wind / speed;
  let tip = center + dir * (0.5 * length_);
  let tail = center - dir * (0.5 * length_);
  let head = min(5.0, 0.5 * length_);
  let back = -dir;
  let left = vec2f(back.x * HEAD_COS - back.y * HEAD_SIN, back.x * HEAD_SIN + back.y * HEAD_COS);
  let right = vec2f(back.x * HEAD_COS + back.y * HEAD_SIN, -back.x * HEAD_SIN + back.y * HEAD_COS);
  let d = min(segmentDistance(pixel, tail, tip), min(segmentDistance(pixel, tip, tip + left * head), segmentDistance(pixel, tip, tip + right * head)));
  return vec2f(1.0 - smoothstep(0.5, 1.0, d), 1.0 - smoothstep(1.4, 2.0, d));
}
`;

// `graphics` maps a graphics name (`ElementDef.graphics`) to its WGSL color function.
export const displayWGSL = (elements: readonly ElementDef[], graphics: Readonly<Record<string, string>>, air?: AirShape): string => {
  const styled = elements.filter((e) => e.graphics !== undefined);
  for (const e of styled) if (!(e.graphics! in graphics)) throw new Error(`element ${e.key}: unknown graphics "${e.graphics}"`);
  const graphicsNames = [...new Set(styled.map((e) => e.graphics!))];

  return /* wgsl */`
${cellWGSL('read', elements)}
${elementsWGSL}
${heatWGSL}
${heatDisplayWGSL}
${rampWGSL('pressureColor', PRESSURE_RAMP)}
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
  airView: f32,
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
${airDisplayWGSL(air)}
${windMarkWGSL}
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

  let simPos = uv * u.simResolution;
  // The air view takes the place of the heat view when both are asked for.
  let airView = u.airView > 0.5;
  let heatView = u.heatView > 0.5 && !airView;
  let air = airCentersAt(simPos);

  // Background gradient with dithering
  let gy = in.position.y / u.screenResolution.y;
  var color = mix(vec3f(0.06, 0.06, 0.08), vec3f(0.10, 0.10, 0.13), gy);
  color += (ditherNoise(in.position.xy) - 0.5) / 128.0;
  // In the heat view empty space shows the temperature of its air, dimmed so the cells that hold heat stand out.
  if (HAS_AIR && heatView && pType == EL_EMPTY) {
    color = heatColor(air.y) * 0.5;
  }

  // A flyer's cell is empty, so its temp word means nothing: the flyer is drawn in its element's color, with no glow or
  // heat color.
  if (pType != EL_EMPTY) {
    color = elColor(pType);
    let holdsHeat = !overFlyer && elHoldsHeat(pType);
    if (heatView) {
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

  // Air view: the pressure in a ramp of rising luminance, the materials faded over it, the wind as arrows.
  if (airView) {
    let pressure = pressureColor(air.x);
    if (pType == EL_EMPTY) {
      color = pressure;
    } else {
      color = mix(pressure, color, 0.3);
    }
    let mark = windMark(uv * u.screenResolution);
    color = mix(color, vec3f(0.02), 0.85 * mark.y);
    color = mix(color, vec3f(0.97), mark.x);
  }

  // Brush cursor
  if (u.showBrush > 0.5) {
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
