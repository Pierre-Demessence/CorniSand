export const displayWGSL = /* wgsl */`

struct Cell {
  pType: u32,
  variant: f32,
  lifetime: f32,
  pressure: f32,
  velocityX: f32,
  velocityY: f32,
  _pad0: f32,
  _pad1: f32,
};

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

@group(0) @binding(0) var<storage, read> cells: array<Cell>;
@group(0) @binding(1) var<uniform> u: DisplayUniforms;

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
  let w = u32(u.simResolution.x);
  let h = u32(u.simResolution.y);
  let cellX = min(u32(uv.x * u.simResolution.x), w - 1u);
  let cellY = min(u32(uv.y * u.simResolution.y), h - 1u);
  let idx = cellY * w + cellX;
  let cell = cells[idx];

  // Background gradient with dithering
  let gy = in.position.y / u.screenResolution.y;
  var color = mix(vec3f(0.06, 0.06, 0.08), vec3f(0.10, 0.10, 0.13), gy);
  color += (ditherNoise(in.position.xy) - 0.5) / 128.0;

  if (cell.pType == 1u) {
    color = vec3f(0.80, 0.70, 0.48); // Sand
  } else if (cell.pType == 2u) {
    color = vec3f(0.43, 0.45, 0.47); // Wall
  } else if (cell.pType == 3u) {
    color = vec3f(0.18, 0.42, 0.72); // Water
  } else if (cell.pType == 4u) {
    color = vec3f(0.72, 0.72, 0.74); // Smoke
  } else if (cell.pType == 5u) {
    color = vec3f(0.22, 0.16, 0.10); // Oil
  } else if (cell.pType == 6u) {
    color = getFireColor(cell.lifetime);
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
