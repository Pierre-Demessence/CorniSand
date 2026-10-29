import type { ElementDef } from '../elements';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatDisplayWGSL, heatWGSL } from './heat.wgsl';
import { displayPropsWGSL, graphicsWGSL, lightWGSL } from './light.wgsl';

/** Texture format of the emission texture and the glow chain: HDR, filterable, blendable and a storage texture. */
export const GLOW_FORMAT = 'rgba16float';

/** Cells per emission texel, along each axis. */
export const EMISSION_CELLS = 2;

/** Texel format of the gas texture: HDR, filterable and a storage texture. */
export const GAS_FORMAT = 'rgba16float';

/** Texel format of the cover texture (opacity in the red channel, the liquid fraction in green). */
export const COVER_FORMAT = 'rgba8unorm';

/** Cells per cover texel, along each axis: one thread of the coverage pass writes one. */
export const COVER_CELLS = 4;

// The coverage pass: the light of every cell, one thread per 4x4 cells. It writes the emission texture, one texel per 2x2
// cells holding the mean of their cells' `cellEmission` (0 beyond the grid), world orientation: texel row r covers the
// cell rows 2r and 2r + 1, so a texture coordinate is the cell's position over the grid's size. A flyer's cell is the
// kind and temperature of the overlay (group 3, two words per cell: src/flyers.ts) over an empty cell. It also writes the
// cover texture, one texel per 4x4 cells holding the mean opacity of their cells (`displayProps[...].opacity`, 0 beyond the
// grid): what the shadow pass marches through. The liquid fraction (the share of liquid cells among those that are not solid
// or powder) goes in its green channel, which the display sums up a column for a liquid's depth. The gas texture, at the same
// resolution, holds the gas cells' color: the sum of their linear colors over the 16 cells in rgb and their count over 16
// in alpha, so a bilinear sample is the mean color of the gas around times its share.
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
@group(0) @binding(5) var gasCloud: texture_storage_2d<${GAS_FORMAT}, write>;
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

// A gas cell's linear color, as the cells look would draw it, and 1 in alpha; 0 for anything else.
fn gasAt(x: u32, y: u32) -> vec4f {
  if (x >= WIDTH || y >= HEIGHT) { return vec4f(0.0); }
  let idx = y * WIDTH + x;
  let id = loadKind(idx) & 0xffu;
  if (id == EL_EMPTY || elState(id) != ST_GAS) { return vec4f(0.0); }
  let c = loadCell(idx);
  return vec4f(srgbToLinear(clamp(litColor(c, elColor(id)), vec3f(0.0), vec3f(1.0))), 1.0);
}

// (1, 1) for a liquid cell, (0, 1) for a cell a liquid could fill (empty space, gas, fire), (0, 0) for a solid or a powder
// and beyond the grid.
fn liquidAt(x: u32, y: u32) -> vec2f {
  if (x >= WIDTH || y >= HEIGHT) { return vec2f(0.0); }
  let state = elState(loadKind(y * WIDTH + x) & 0xffu);
  if (state == ST_SOLID || state == ST_POWDER) { return vec2f(0.0); }
  return vec2f(select(0.0, 1.0, state == ST_LIQUID), 1.0);
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
    var liquid = vec2f(0.0);
    var gas = vec4f(0.0);
    for (var b = 0u; b < ${COVER_CELLS}u; b++) {
      for (var a = 0u; a < ${COVER_CELLS}u; a++) {
        opacity += opacityAt(gid.x * ${COVER_CELLS}u + a, gid.y * ${COVER_CELLS}u + b);
        liquid += liquidAt(gid.x * ${COVER_CELLS}u + a, gid.y * ${COVER_CELLS}u + b);
        gas += gasAt(gid.x * ${COVER_CELLS}u + a, gid.y * ${COVER_CELLS}u + b);
      }
    }
    gas /= ${COVER_CELLS * COVER_CELLS}.0;
    // The liquid's share of the cells it could fill, so a texel cut by a wall or a sand bed counts as full.
    let filled = select(0.0, liquid.x / liquid.y, liquid.y > 0.0);
    textureStore(cover, gid.xy, vec4f(opacity / ${COVER_CELLS * COVER_CELLS}.0, filled, 0.0, 0.0));
    textureStore(gasCloud, gid.xy, gas);
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

// The 13 taps around a texel: a to i the corners, edges and center of a 5x5 square (2 texels apart), j to m the corners of
// the inner 3x3 one.
fn taps13(uv: vec2f) -> array<vec3f, 13> {
  let texel = 1.0 / vec2f(textureDimensions(src));
  return array<vec3f, 13>(
    tap(uv, vec2f(-2.0, 2.0), texel), tap(uv, vec2f(0.0, 2.0), texel), tap(uv, vec2f(2.0, 2.0), texel),
    tap(uv, vec2f(-2.0, 0.0), texel), tap(uv, vec2f(0.0, 0.0), texel), tap(uv, vec2f(2.0, 0.0), texel),
    tap(uv, vec2f(-2.0, -2.0), texel), tap(uv, vec2f(0.0, -2.0), texel), tap(uv, vec2f(2.0, -2.0), texel),
    tap(uv, vec2f(-1.0, 1.0), texel), tap(uv, vec2f(1.0, 1.0), texel),
    tap(uv, vec2f(-1.0, -1.0), texel), tap(uv, vec2f(1.0, -1.0), texel),
  );
}

@fragment
fn fs_down(in: VertexOutput) -> @location(0) vec4f {
  let t = taps13(in.uv);
  let sum = t[4] * 0.125 + (t[0] + t[2] + t[6] + t[8]) * 0.03125 + (t[1] + t[3] + t[5] + t[7]) * 0.0625 + (t[9] + t[10] + t[11] + t[12]) * 0.125;
  return vec4f(sum, 0.0);
}

@fragment
fn fs_first(in: VertexOutput) -> @location(0) vec4f {
  let t = taps13(in.uv);
  // The five groups of the 13 taps: the four corner squares carry 1/8 each, the inner square 1/2.
  let g0 = (t[0] + t[1] + t[3] + t[4]) * 0.25;
  let g1 = (t[1] + t[2] + t[4] + t[5]) * 0.25;
  let g2 = (t[3] + t[4] + t[6] + t[7]) * 0.25;
  let g3 = (t[4] + t[5] + t[7] + t[8]) * 0.25;
  let g4 = (t[9] + t[10] + t[11] + t[12]) * 0.25;
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
