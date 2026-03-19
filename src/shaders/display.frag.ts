export const displayFragShader = /* glsl */`
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_simResolution;
uniform vec2 u_screenResolution;
uniform vec2 u_mousePos;
uniform float u_brushSize;
uniform float u_showBrush;
uniform float u_erasing;

vec3 getSandColor(float variant) {
  float t = variant / 255.0;
  vec3 light = vec3(0.90, 0.82, 0.58);
  vec3 mid   = vec3(0.76, 0.68, 0.46);
  vec3 dark  = vec3(0.58, 0.48, 0.30);
  if (t < 0.5) return mix(mid, light, t * 2.0);
  return mix(mid, dark, (t - 0.5) * 2.0);
}

vec3 getWallColor(float variant) {
  float t = variant / 255.0;
  return mix(vec3(0.38, 0.40, 0.42), vec3(0.48, 0.50, 0.52), t);
}

vec3 getWaterColor(float variant) {
  float t = variant / 255.0;
  vec3 light = vec3(0.25, 0.52, 0.82);
  vec3 dark = vec3(0.12, 0.32, 0.62);
  return mix(light, dark, t);
}

vec3 getSmokeColor(float variant) {
  float t = variant / 255.0;
  vec3 light = vec3(0.55, 0.55, 0.58);
  vec3 dark = vec3(0.35, 0.35, 0.38);
  return mix(light, dark, t);
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
  }

  // Brush cursor indicator
  if (u_showBrush > 0.5) {
    vec2 simPos = uv * u_simResolution;
    float dist = length(simPos - u_mousePos);
    float pixelSize = u_simResolution.x / u_screenResolution.x;
    float ringWidth = max(1.0, 1.5 * pixelSize);

    if (abs(dist - u_brushSize) < ringWidth) {
      vec3 ringColor = u_erasing > 0.5 ? vec3(0.95, 0.30, 0.30) : vec3(0.9, 0.9, 0.9);
      color = mix(color, ringColor, 0.55);
    }
  }

  gl_FragColor = vec4(color, 1.0);
}
`;
