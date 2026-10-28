import { wgslFloat } from '../movement';
import { texelVertexWGSL } from './glow.wgsl';

/** Texel format of the shadow texture: one channel, filterable and renderable. */
export const SHADOW_FORMAT = 'r8unorm';

// The shadow pass: for each texel of the cover texture, how much of the light reaching it the matter toward the light
// blocks. It marches `length` texels toward the light (a unit vector in texel coordinates, x right and row up, as the
// textures are in world orientation) and keeps the strongest opacity weighted by `1 - step / length`: a wall of stone
// right beside the texel shades it fully, one at the end of the march not at all, so shadows have soft ends. The cover
// is read bilinearly, so edges are soft too. A sample beyond the grid blocks nothing.
export const shadowWGSL = (length: number, towardLight: readonly [number, number]): string => /* wgsl */`
@group(0) @binding(0) var cover: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

${texelVertexWGSL}

const LENGTH: i32 = ${length};
const TOWARD_LIGHT: vec2f = vec2f(${wgslFloat(towardLight[0])}, ${wgslFloat(towardLight[1])});

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(cover));
  let origin = in.uv * size;
  var shadow = 0.0;
  for (var k = 1; k <= LENGTH; k++) {
    let p = origin + TOWARD_LIGHT * f32(k);
    if (any(p < vec2f(0.0)) || any(p > size)) { continue; }
    let opacity = textureSampleLevel(cover, smp, p / size, 0.0).r;
    shadow = max(shadow, opacity * (1.0 - f32(k) / f32(LENGTH)));
  }
  return vec4f(shadow, 0.0, 0.0, 1.0);
}
`;
