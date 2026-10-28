import type { ElementDef } from '../elements';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatDisplayWGSL, heatWGSL } from './heat.wgsl';
import { displayPropsWGSL, graphicsWGSL, lightWGSL } from './light.wgsl';

/** Texture format of the emission texture and the glow chain: HDR, filterable, blendable and a storage texture. */
export const GLOW_FORMAT = 'rgba16float';

/** Cells per emission texel, along each axis. */
export const EMISSION_CELLS = 2;

/** Texel format of the cover texture (opacity in the red channel; the liquid and gas fractions of M11.5 and M11.6 follow in green and blue). */
export const COVER_FORMAT = 'rgba8unorm';

/** Cells per cover texel, along each axis: one thread of the coverage pass writes one. */
export const COVER_CELLS = 4;

// The coverage pass: the light of every cell, one thread per 4x4 cells. It writes the emission texture, one texel per 2x2
// cells holding the mean of their cells' `cellEmission` (0 beyond the grid), world orientation: texel row r covers the
// cell rows 2r and 2r + 1, so a texture coordinate is the cell's position over the grid's size. A flyer's cell is the
// kind and temperature of the overlay (group 3, two words per cell: src/flyers.ts) over an empty cell. It also writes the
// cover texture, one texel per 4x4 cells holding the mean opacity of their cells (`displayProps[...].opacity`, 0 beyond the
// grid): what the shadow pass marches through.
export const coverageWGSL = (elements: readonly ElementDef[], graphics: Readonly<Record<string, string>>, width: number, height: number): string => {
  const { styled, source } = graphicsWGSL(elements, graphics);
  return /* wgsl */`
${cellWGSL('read', elements)}
${elementsWGSL}
${heatWGSL}
${heatDisplayWGSL}
${source}
${displayPropsWGSL}
${lightWGSL(styled)}

@group(0) @binding(3) var emission: texture_storage_2d<${GLOW_FORMAT}, write>;
@group(0) @binding(4) var cover: texture_storage_2d<${COVER_FORMAT}, write>;
@group(3) @binding(0) var<storage, read> flyerWords: array<u32>;

const WIDTH: u32 = ${width}u;
const HEIGHT: u32 = ${height}u;

fn emissionAt(x: u32, y: u32) -> vec3f {
  if (x >= WIDTH || y >= HEIGHT) { return vec3f(0.0); }
  let idx = y * WIDTH + x;
  var kind = loadKind(idx);
  var flying = false;
  if ((kind & 0xffu) == EL_EMPTY) {
    kind = flyerWords[2u * idx];
    flying = true;
  }
  if (!elHoldsHeat(kind & 0xffu)) { return vec3f(0.0); }
  var c = loadCell(idx);
  if (flying) {
    c.kind = kind;
    c.temp = bitcast<f32>(flyerWords[2u * idx + 1u]);
  }
  return cellEmission(c);
}

fn opacityAt(x: u32, y: u32) -> f32 {
  if (x >= WIDTH || y >= HEIGHT) { return 0.0; }
  let idx = y * WIDTH + x;
  var id = loadKind(idx) & 0xffu;
  if (id == EL_EMPTY) { id = flyerWords[2u * idx] & 0xffu; }
  return displayProps[id].opacity;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(emission);
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      let tx = gid.x * 2u + i;
      let ty = gid.y * 2u + j;
      if (tx >= size.x || ty >= size.y) { continue; }
      var sum = vec3f(0.0);
      for (var b = 0u; b < ${EMISSION_CELLS}u; b++) {
        for (var a = 0u; a < ${EMISSION_CELLS}u; a++) {
          sum += emissionAt(tx * ${EMISSION_CELLS}u + a, ty * ${EMISSION_CELLS}u + b);
        }
      }
      textureStore(emission, vec2u(tx, ty), vec4f(sum / ${EMISSION_CELLS * EMISSION_CELLS}.0, 0.0));
    }
  }

  let coverSize = textureDimensions(cover);
  if (gid.x < coverSize.x && gid.y < coverSize.y) {
    var opacity = 0.0;
    for (var b = 0u; b < ${COVER_CELLS}u; b++) {
      for (var a = 0u; a < ${COVER_CELLS}u; a++) {
        opacity += opacityAt(gid.x * ${COVER_CELLS}u + a, gid.y * ${COVER_CELLS}u + b);
      }
    }
    textureStore(cover, gid.xy, vec4f(opacity / ${COVER_CELLS * COVER_CELLS}.0, 0.0, 0.0, 0.0));
  }
}
`;
};

// The vertex shader of the passes that draw into a texture in world orientation (the glow chain, the shadow pass): a
// fullscreen triangle whose uv runs down the rows like a texture coordinate, row = the world's y.
export const texelVertexWGSL = /* wgsl */`
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = corners[vertexIndex];
  var out: VertexOutput;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}
`;

// The glow chain (Jimenez 2014, "Next Generation Post Processing in Call of Duty: Advanced Warfare"): `fs_first` and
// `fs_down` average a source texel's 13 taps into the next, half-size level (the first with the Karis average, which
// weights each group of taps by 1 / (1 + its luma) so one very hot cell does not flicker as it crosses texels), `fs_up`
// spreads a level with a 3x3 tent into the finer one, added on top by blending. All the textures are in world
// orientation (row = the world's y), so the fullscreen triangle's uv runs down the rows like a texture coordinate.
export const glowChainWGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

${texelVertexWGSL}

fn tap(uv: vec2f, offset: vec2f, texel: vec2f) -> vec3f {
  return textureSampleLevel(src, smp, uv + offset * texel, 0.0).rgb;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_down(in: VertexOutput) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  let a = tap(in.uv, vec2f(-2.0, 2.0), texel);
  let b = tap(in.uv, vec2f(0.0, 2.0), texel);
  let c = tap(in.uv, vec2f(2.0, 2.0), texel);
  let d = tap(in.uv, vec2f(-2.0, 0.0), texel);
  let e = tap(in.uv, vec2f(0.0, 0.0), texel);
  let f = tap(in.uv, vec2f(2.0, 0.0), texel);
  let g = tap(in.uv, vec2f(-2.0, -2.0), texel);
  let h = tap(in.uv, vec2f(0.0, -2.0), texel);
  let i = tap(in.uv, vec2f(2.0, -2.0), texel);
  let j = tap(in.uv, vec2f(-1.0, 1.0), texel);
  let k = tap(in.uv, vec2f(1.0, 1.0), texel);
  let l = tap(in.uv, vec2f(-1.0, -1.0), texel);
  let m = tap(in.uv, vec2f(1.0, -1.0), texel);
  let sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(sum, 0.0);
}

@fragment
fn fs_first(in: VertexOutput) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  let a = tap(in.uv, vec2f(-2.0, 2.0), texel);
  let b = tap(in.uv, vec2f(0.0, 2.0), texel);
  let c = tap(in.uv, vec2f(2.0, 2.0), texel);
  let d = tap(in.uv, vec2f(-2.0, 0.0), texel);
  let e = tap(in.uv, vec2f(0.0, 0.0), texel);
  let f = tap(in.uv, vec2f(2.0, 0.0), texel);
  let g = tap(in.uv, vec2f(-2.0, -2.0), texel);
  let h = tap(in.uv, vec2f(0.0, -2.0), texel);
  let i = tap(in.uv, vec2f(2.0, -2.0), texel);
  let j = tap(in.uv, vec2f(-1.0, 1.0), texel);
  let k = tap(in.uv, vec2f(1.0, 1.0), texel);
  let l = tap(in.uv, vec2f(-1.0, -1.0), texel);
  let m = tap(in.uv, vec2f(1.0, -1.0), texel);
  // The five groups of the 13 taps: the four corner squares carry 1/8 each, the inner square 1/2.
  let g0 = (a + b + d + e) * 0.25;
  let g1 = (b + c + e + f) * 0.25;
  let g2 = (d + e + g + h) * 0.25;
  let g3 = (e + f + h + i) * 0.25;
  let g4 = (j + k + l + m) * 0.25;
  let w0 = 0.125 / (1.0 + luma(g0));
  let w1 = 0.125 / (1.0 + luma(g1));
  let w2 = 0.125 / (1.0 + luma(g2));
  let w3 = 0.125 / (1.0 + luma(g3));
  let w4 = 0.5 / (1.0 + luma(g4));
  let sum = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  return vec4f(sum, 0.0);
}

@fragment
fn fs_up(in: VertexOutput) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  let a = tap(in.uv, vec2f(-1.0, 1.0), texel);
  let b = tap(in.uv, vec2f(0.0, 1.0), texel);
  let c = tap(in.uv, vec2f(1.0, 1.0), texel);
  let d = tap(in.uv, vec2f(-1.0, 0.0), texel);
  let e = tap(in.uv, vec2f(0.0, 0.0), texel);
  let f = tap(in.uv, vec2f(1.0, 0.0), texel);
  let g = tap(in.uv, vec2f(-1.0, -1.0), texel);
  let h = tap(in.uv, vec2f(0.0, -1.0), texel);
  let i = tap(in.uv, vec2f(1.0, -1.0), texel);
  let sum = (e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i)) / 16.0;
  return vec4f(sum, 0.0);
}
`;
