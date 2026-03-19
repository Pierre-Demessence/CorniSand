export const simulationFragShader = /* glsl */`
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_offset;
uniform float u_seed;

uniform vec2 u_mousePos;
uniform vec2 u_prevMousePos;
uniform float u_brushSize;
uniform float u_particleType;
uniform float u_mouseActive;
uniform float u_erasing;

#define TYPE_EMPTY 0.0
#define TYPE_SAND  1.0
#define TYPE_WALL  2.0
#define TYPE_WATER 3.0

float getType(vec4 cell) {
  return floor(cell.r * 255.0 + 0.5);
}

vec4 encodeCell(float pType, float variant) {
  return vec4(pType / 255.0, variant / 255.0, 0.0, 1.0);
}

bool isEmpty(float t) { return t < 0.5; }
bool isSand(float t)  { return abs(t - TYPE_SAND) < 0.5; }
bool isWater(float t) { return abs(t - TYPE_WATER) < 0.5; }
bool isWall(float t)  { return abs(t - TYPE_WALL) < 0.5; }
bool isFalling(float t) { return isSand(t) || isWater(t); }
bool isLiquid(float t) { return isWater(t); }

// Sand displaces empty and water (sinks); water displaces empty only
bool canDisplace(float mover, float target) {
  if (isEmpty(target)) return true;
  if (isSand(mover) && isWater(target)) return true;
  return false;
}

float hash21(vec2 p) {
  p = fract(p * vec2(233.34, 851.74));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

vec4 readCell(vec2 pos) {
  if (pos.x < 0.0 || pos.x >= u_resolution.x ||
      pos.y < 0.0 || pos.y >= u_resolution.y) {
    return encodeCell(TYPE_WALL, 0.0);
  }
  return texture2D(u_state, (pos + 0.5) / u_resolution);
}

void main() {
  vec2 pos = floor(gl_FragCoord.xy);
  vec4 current = readCell(pos);

  // --- Mouse input: paint or erase ---
  if (u_mouseActive > 0.5) {
    vec2 ab = u_mousePos - u_prevMousePos;
    float segLen2 = dot(ab, ab);
    float t = segLen2 > 0.001 ? clamp(dot(pos - u_prevMousePos, ab) / segLen2, 0.0, 1.0) : 0.0;
    vec2 closest = u_prevMousePos + t * ab;
    float dist = length(pos - closest);
    if (dist <= u_brushSize) {
      if (u_erasing > 0.5) {
        float ct = getType(current);
        if (!isEmpty(ct)) {
          gl_FragColor = encodeCell(TYPE_EMPTY, 0.0);
          return;
        }
      } else {
        float ct = getType(current);
        if (isEmpty(ct)) {
          float variant = floor(hash21(pos * 0.97 + vec2(u_seed * 7.13)) * 256.0);
          gl_FragColor = encodeCell(u_particleType, variant);
          return;
        }
      }
    }
  }

  // --- Margolus neighborhood cellular automaton ---
  float offset = u_offset;
  vec2 blockOrigin = floor((pos - offset) / 2.0) * 2.0 + offset;
  vec2 local = pos - blockOrigin;

  vec4 vBL = readCell(blockOrigin);
  vec4 vBR = readCell(blockOrigin + vec2(1.0, 0.0));
  vec4 vTL = readCell(blockOrigin + vec2(0.0, 1.0));
  vec4 vTR = readCell(blockOrigin + vec2(1.0, 1.0));

  float tBL = getType(vBL), tBR = getType(vBR);
  float tTL = getType(vTL), tTR = getType(vTR);

  vec4 oBL = vBL, oBR = vBR, oTL = vTL, oTR = vTR;
  float otBL = tBL, otBR = tBR, otTL = tTL, otTR = tTR;

  // Phase 1: Vertical fall (gravity + density: sand sinks through water)
  if (isFalling(otTL) && canDisplace(otTL, otBL)) {
    vec4 tmp = oTL; oTL = oBL; oBL = tmp;
    float tt = otTL; otTL = otBL; otBL = tt;
  }
  if (isFalling(otTR) && canDisplace(otTR, otBR)) {
    vec4 tmp = oTR; oTR = oBR; oBR = tmp;
    float tt = otTR; otTR = otBR; otBR = tt;
  }

  // Phase 2: Diagonal slide (randomized to prevent directional bias)
  float rnd = hash21(blockOrigin * 0.731 + vec2(u_seed));

  if (rnd > 0.5) {
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      vec4 tmp = oTL; oTL = oBR; oBR = tmp;
      float tt = otTL; otTL = otBR; otBR = tt;
    }
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      vec4 tmp = oTR; oTR = oBL; oBL = tmp;
      float tt = otTR; otTR = otBL; otBL = tt;
    }
  } else {
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      vec4 tmp = oTR; oTR = oBL; oBL = tmp;
      float tt = otTR; otTR = otBL; otBL = tt;
    }
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      vec4 tmp = oTL; oTL = oBR; oBR = tmp;
      float tt = otTL; otTL = otBR; otBR = tt;
    }
  }

  // Phase 3: Horizontal liquid flow (water spreads sideways)
  float rnd2 = hash21(blockOrigin * 1.37 + vec2(u_seed + 7.0));

  // Bottom row: only flow water that was already here before this step
  // (prevents fall-then-spread diagonal jets)
  bool blWasLiquid = isLiquid(tBL);
  bool brWasLiquid = isLiquid(tBR);

  if (rnd2 > 0.5) {
    if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      vec4 tmp = oBL; oBL = oBR; oBR = tmp;
      float tt = otBL; otBL = otBR; otBR = tt;
    } else if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      vec4 tmp = oBR; oBR = oBL; oBL = tmp;
      float tt = otBR; otBR = otBL; otBL = tt;
    }
  } else {
    if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      vec4 tmp = oBR; oBR = oBL; oBL = tmp;
      float tt = otBR; otBR = otBL; otBL = tt;
    } else if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      vec4 tmp = oBL; oBL = oBR; oBR = tmp;
      float tt = otBL; otBL = otBR; otBR = tt;
    }
  }

  // Top row: liquid flows if blocked below
  if (isLiquid(otTL) && isEmpty(otTR) && !canDisplace(otTL, otBL)) {
    vec4 tmp = oTL; oTL = oTR; oTR = tmp;
    float tt = otTL; otTL = otTR; otTR = tt;
  } else if (isLiquid(otTR) && isEmpty(otTL) && !canDisplace(otTR, otBR)) {
    vec4 tmp = oTR; oTR = oTL; oTL = tmp;
    float tt = otTR; otTR = otTL; otTL = tt;
  }

  // Output
  int lx = int(local.x);
  int ly = int(local.y);

  if (lx == 0 && ly == 0)      gl_FragColor = oBL;
  else if (lx == 1 && ly == 0) gl_FragColor = oBR;
  else if (lx == 0 && ly == 1) gl_FragColor = oTL;
  else                          gl_FragColor = oTR;
}
`;
