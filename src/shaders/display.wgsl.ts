import { AIR, AIR_VIEW, PRESSURE_RAMP, type AirShape } from '../air';
import type { ElementDef } from '../elements';
import { ROOM_TEMP } from '../heat';
import { LOOK, WALL_LEVEL, WALL_RANGE } from '../look';
import { wgslFloat } from '../movement';
import { COVER_CELLS } from './glow.wgsl';
import { airSamplersWGSL } from './air.wgsl';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatDisplayWGSL, heatWGSL, rampWGSL } from './heat.wgsl';
import { displayPropsWGSL, graphicsWGSL, lightWGSL } from './light.wgsl';

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

// The wall behind the field, the grain of the cells and the finished look's color path. The wall is a display value: a
// tinted grey, brighter toward the top center and darker toward the corners, at the brightness of the `wall` uniform.
// The dither (interleaved gradient noise, Jimenez 2014) keeps its gradient from banding; it is added to the wall alone, so
// the cells keep their exact colors.
const lookWGSL = /* wgsl */`
const WALL_LEVEL: f32 = ${wgslFloat(WALL_LEVEL)};
const WALL_RANGE: f32 = ${wgslFloat(WALL_RANGE)};
const WALL_TINT: vec3f = vec3f(0.94, 0.98, 1.06);
const SOLID_NOISE: f32 = ${wgslFloat(LOOK.solidNoise)};
// Cells between the lattice points of the solids' noise.
const NOISE_SPACING: f32 = 12.0;

fn interleavedNoise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn wallColor(uv: vec2f, pixel: vec2f) -> vec3f {
  let p = uv * 2.0 - 1.0;
  let light = 1.0 - 0.30 * p.x * p.x - 0.125 * (1.0 - p.y);
  let level = WALL_LEVEL + WALL_RANGE * u.wall * sqrt(u.wall);
  return WALL_TINT * (level * light) + (interleavedNoise(pixel) - 0.5) / 255.0;
}

// Smooth noise of a place in cells, 0 to 1, from a hash of the lattice points around it.
fn latticeValue(x: i32, y: i32) -> f32 {
  return f32(hash2(u32(x), u32(y), 0x6e6f6973u) & 0xffffu) / 65535.0;
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let x = i32(i.x);
  let y = i32(i.y);
  return mix(mix(latticeValue(x, y), latticeValue(x + 1, y), w.x), mix(latticeValue(x, y + 1), latticeValue(x + 1, y + 1), w.x), w.y);
}

// The variant as a signed byte over 128: -1 to 127/128, 0 for variant 0.
fn cellShade(c: Cell) -> f32 {
  let v = i32(cellVariant(c));
  return f32(select(v, v - 256, v >= 128)) / 128.0;
}

// The cell's color with its grain: brighter or darker by the strength of its element times its shade, a little warmer
// when brighter. A solid's strength varies slowly with its place (it never moves); variant 0 is the table color.
fn grainColor(c: Cell, base: vec3f, cellPos: vec2f) -> vec3f {
  let t = cellType(c);
  var strength = displayProps[t].grain;
  if (strength == 0.0) { return base; }
  if (elState(t) == ST_SOLID) {
    strength *= 1.0 + SOLID_NOISE * (2.0 * valueNoise(cellPos / NOISE_SPACING) - 1.0);
  }
  return base * (1.0 + strength * cellShade(c) * vec3f(1.15, 1.0, 0.85));
}

// Light above 1 turns white by how far over it is (after Khronos PBR Neutral, whose compression knee at 0.76 is left out:
// it would change the table colors that reach 1, such as fire's red). Up to 1 it changes nothing.
const DESATURATION: f32 = 0.5;
fn toneMap(c: vec3f) -> vec3f {
  let peak = max(c.r, max(c.g, c.b));
  if (peak <= 1.0) { return c; }
  let toWhite = 1.0 - 1.0 / (DESATURATION * (peak - 1.0) + 1.0);
  return mix(c / peak, vec3f(1.0), toWhite);
}
`;

// `graphics` maps a graphics name (`ElementDef.graphics`) to its WGSL color function.
export const displayWGSL = (elements: readonly ElementDef[], graphics: Readonly<Record<string, string>>, air?: AirShape): string => {
  const { styled, source: graphicsSource } = graphicsWGSL(elements, graphics);

  return /* wgsl */`
${cellWGSL('read', elements)}
${elementsWGSL}
${heatWGSL}
${heatDisplayWGSL}
${rampWGSL('pressureColor', PRESSURE_RAMP)}
${graphicsSource}

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
  // 1 for the cells look, 0 for the finished look.
  cellsLook: f32,
  wall: f32,
  // The strength of the halo: 0 adds none.
  glow: f32,
  // How dark the shadow of fully opaque matter is: 0 draws none.
  shadow: f32,
  // How much of the wall a full cloud of gas hides: 0 draws gas as cells.
  gas: f32,
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
${displayPropsWGSL}
// The blurred light of the glow chain (src/glow.ts, linear, world orientation).
@group(0) @binding(3) var glowTex: texture_2d<f32>;
@group(0) @binding(4) var glowSampler: sampler;
// How shaded each texel of the cover grid is (src/shadow.ts), world orientation.
@group(0) @binding(5) var shadowTex: texture_2d<f32>;
// The gas cells as a cloud (src/glow.ts): the mean linear color of the gas cells of each texel of the cover grid times their
// share, and that share in alpha, world orientation.
@group(0) @binding(6) var gasTex: texture_2d<f32>;
${lightWGSL(styled)}
${lookWGSL}
${airDisplayWGSL(air)}
${windMarkWGSL}
// The flyer in each cell, two words: its kind word (0 where none flies) and its temperature's bits (src/shaders/flyers.wgsl.ts,
// overlayWGSL).
@group(3) @binding(0) var<storage, read> flyerWords: array<u32>;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;
  let w = u32(u.simResolution.x);
  let h = u32(u.simResolution.y);
  let cellX = min(u32(uv.x * u.simResolution.x), w - 1u);
  let cellY = min(u32(uv.y * u.simResolution.y), h - 1u);
  let idx = cellY * w + cellX;
  var cell = loadCell(idx);
  // A flyer is drawn in the empty cell it is over, with its temperature; one over a filled cell (it lands there next step)
  // is not.
  if (cellType(cell) == EL_EMPTY) {
    cell.kind = flyerWords[2u * idx];
    cell.temp = bitcast<f32>(flyerWords[2u * idx + 1u]);
  }
  let pType = cellType(cell);

  let simPos = uv * u.simResolution;
  // The air view takes the place of the heat view when both are asked for.
  let airView = u.airView > 0.5;
  let heatView = u.heatView > 0.5 && !airView;
  let air = airCentersAt(simPos);
  // The finished look draws gas as a soft layer over the wall, not as cells.
  let softGas = u.cellsLook < 0.5 && !heatView && !airView && u.gas > 0.0 && pType != EL_EMPTY && elState(pType) == ST_GAS;

  // The wall behind the field, dithered.
  var color = wallColor(uv, in.position.xy);
  // In the heat view empty space shows the temperature of its air, dimmed so the cells that hold heat stand out.
  if (HAS_AIR && heatView && pType == EL_EMPTY) {
    color = heatColor(air.y) * 0.5;
  }

  if (pType != EL_EMPTY && !softGas) {
    color = elColor(pType);
    let holdsHeat = elHoldsHeat(pType);
    if (heatView) {
      if (holdsHeat) {
        color = heatColor(cellTemp(cell));
      } else {
        color *= 0.3;
      }
    } else {
      // The views draw the cells without grain.
      if (!airView) {
        color = grainColor(cell, color, vec2f(f32(cellX), f32(cellY)));
      }
      color = litColor(cell, color);
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

  // The finished look's shadows: matter toward the light darkens the empty space and the gas behind it. Fire shines and
  // filled cells are lit, so they take none. The shade is read bilinearly at the pixel's place, so the edges are soft.
  if (u.cellsLook < 0.5 && !heatView && !airView && u.shadow > 0.0 && (pType == EL_EMPTY || elState(pType) == ST_GAS)) {
    let coverSize = vec2f(textureDimensions(shadowTex));
    let shade = textureSampleLevel(shadowTex, glowSampler, simPos / (${COVER_CELLS}.0 * coverSize), 0.0).r;
    color *= 1.0 - u.shadow * shade;
  }

  // The finished look: the color in linear light, the halo added, tone mapped, encoded again. The views take today's math
  // as it is. A cell's own glow is clamped per channel first, as in the cells look, so a lone hot cell is drawn the same in
  // both looks; only light added in linear light (the halo) reaches the tone map above 1. The halo is the blurred light of
  // the cells that radiate (src/glow.ts), added around them: a cell that radiates is drawn by its own color alone, except a gas
  // cell, which is part of the cloud and shines through the halo.
  if (u.cellsLook < 0.5 && !heatView && !airView) {
    var light = srgbToLinear(clamp(color, vec3f(0.0), vec3f(1.0)));
    // The cloud lies over empty space and over the gas cells it stands for; a filled cell hides it.
    if (u.gas > 0.0 && (pType == EL_EMPTY || softGas)) {
      let gasSize = vec2f(textureDimensions(gasTex));
      let gas = textureSampleLevel(gasTex, glowSampler, simPos / (${COVER_CELLS}.0 * gasSize), 0.0);
      light = light * (1.0 - gas.a * u.gas) + gas.rgb * u.gas;
    }
    if (u.glow > 0.0 && (softGas || dot(cellEmission(cell), vec3f(1.0)) <= 0.0)) {
      light += textureSampleLevel(glowTex, glowSampler, uv, 0.0).rgb * u.glow;
    }
    color = linearToSrgb(toneMap(light));
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
