export const displayWGSL = /* wgsl */`

struct DisplayUniforms {
  simResolution: vec2f,
  screenResolution: vec2f,
  mousePos: vec2f,
  brushSize: f32,
  showBrush: f32,
  erasing: f32,
  replacing: f32,
  _pad: vec2f,
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

@group(0) @binding(0) var stateTex: texture_2d<f32>;
@group(0) @binding(1) var stateSampler: sampler;
@group(0) @binding(2) var<uniform> u: DisplayUniforms;

fn ditherNoise(pos: vec2f) -> f32 {
  return fract(sin(dot(pos, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn getFireColor(life: f32) -> vec3f {
  let t = clamp(life / 200.0, 0.0, 1.0);
  let bright = vec3f(1.0, 0.72, 0.12);
  let dim = vec3f(0.80, 0.18, 0.04);
  return mix(dim, bright, t);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;
  let cell = textureSample(stateTex, stateSampler, uv);

  let pType = floor(cell.r * 255.0 + 0.5);
  let variant = floor(cell.g * 255.0 + 0.5);

  // Background gradient with dithering
  let gy = in.position.y / u.screenResolution.y;
  var color = mix(vec3f(0.06, 0.06, 0.08), vec3f(0.10, 0.10, 0.13), gy);
  color += (ditherNoise(in.position.xy) - 0.5) / 128.0;

  if (pType > 0.5 && pType < 1.5) {
    color = vec3f(0.80, 0.70, 0.48); // Sand
  } else if (pType > 1.5 && pType < 2.5) {
    color = vec3f(0.43, 0.45, 0.47); // Wall
  } else if (pType > 2.5 && pType < 3.5) {
    color = vec3f(0.18, 0.42, 0.72); // Water
  } else if (pType > 3.5 && pType < 4.5) {
    color = vec3f(0.72, 0.72, 0.74); // Smoke
  } else if (pType > 4.5 && pType < 5.5) {
    color = vec3f(0.22, 0.16, 0.10); // Oil
  } else if (pType > 5.5 && pType < 6.5) {
    let life = floor(cell.b * 255.0 + 0.5);
    color = getFireColor(life);
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
