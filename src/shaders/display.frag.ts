export const displayFragShader = /* glsl */`
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_simResolution;
uniform vec2 u_screenResolution;
uniform vec2 u_mousePos;
uniform float u_brushSize;
uniform float u_showBrush;
uniform float u_erasing;
uniform float u_replacing;

vec3 getSandColor(float variant) {
  return vec3(0.80, 0.70, 0.48);
}

vec3 getWallColor(float variant) {
  return vec3(0.43, 0.45, 0.47);
}

vec3 getWaterColor(float variant) {
  return vec3(0.18, 0.42, 0.72);
}

vec3 getSmokeColor(float variant) {
  return vec3(0.72, 0.72, 0.74);
}

vec3 getOilColor(float variant) {
  return vec3(0.22, 0.16, 0.10);
}

vec3 getFireColor(float life) {
  float t = clamp(life / 200.0, 0.0, 1.0); // FIRE_MAX_LIFE from simulation shader
  vec3 bright = vec3(1.0, 0.72, 0.12);
  vec3 dim = vec3(0.80, 0.18, 0.04);
  return mix(dim, bright, t);
}

float ditherNoise(vec2 pos) {
  return fract(sin(dot(pos, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_screenResolution;
  vec4 cell = texture2D(u_state, uv);

  float pType = floor(cell.r * 255.0 + 0.5);
  float variant = floor(cell.g * 255.0 + 0.5);

  // Background: subtle dark gradient with dithering to prevent banding
  float gy = gl_FragCoord.y / u_screenResolution.y;
  vec3 color = mix(vec3(0.06, 0.06, 0.08), vec3(0.10, 0.10, 0.13), gy);
  color += (ditherNoise(gl_FragCoord.xy) - 0.5) / 128.0;

  if (pType > 0.5 && pType < 1.5) {
    color = getSandColor(variant);
  } else if (pType > 1.5 && pType < 2.5) {
    color = getWallColor(variant);
  } else if (pType > 2.5 && pType < 3.5) {
    color = getWaterColor(variant);
  } else if (pType > 3.5 && pType < 4.5) {
    color = getSmokeColor(variant);
  } else if (pType > 4.5 && pType < 5.5) {
    color = getOilColor(variant);
  } else if (pType > 5.5 && pType < 6.5) {
    float life = floor(cell.b * 255.0 + 0.5);
    color = getFireColor(life);
  }

  // Brush cursor indicator
  if (u_showBrush > 0.5) {
    vec2 simPos = uv * u_simResolution;
    float dist = length(simPos - u_mousePos);
    float pixelSize = u_simResolution.x / u_screenResolution.x;
    float ringWidth = max(1.0, 1.5 * pixelSize);

    if (abs(dist - u_brushSize) < ringWidth) {
      vec3 ringColor = u_erasing > 0.5 ? vec3(0.95, 0.30, 0.30) : u_replacing > 0.5 ? vec3(0.95, 0.70, 0.20) : vec3(0.9, 0.9, 0.9);
      color = mix(color, ringColor, 0.55);
    }
  }

  gl_FragColor = vec4(color, 1.0);
}
`;
