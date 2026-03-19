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
uniform float u_replacing;

#define TYPE_EMPTY 0.0
#define TYPE_SAND  1.0
#define TYPE_WALL  2.0
#define TYPE_WATER 3.0
#define TYPE_SMOKE 4.0
#define TYPE_OIL   5.0
#define TYPE_FIRE  6.0

#define FIRE_MAX_LIFE 200.0
#define FIRE_DECAY 4.0

float getType(vec4 cell) {
  return floor(cell.r * 255.0 + 0.5);
}

float getLife(vec4 cell) {
  return floor(cell.b * 255.0 + 0.5);
}

vec4 encodeCell(float pType, float variant) {
  return vec4(pType / 255.0, variant / 255.0, 0.0, 1.0);
}

vec4 encodeCellWithLife(float pType, float variant, float life) {
  return vec4(pType / 255.0, variant / 255.0, life / 255.0, 1.0);
}

bool isEmpty(float t) { return t < 0.5; }
bool isSand(float t)  { return abs(t - TYPE_SAND) < 0.5; }
bool isWater(float t) { return abs(t - TYPE_WATER) < 0.5; }
bool isWall(float t)  { return abs(t - TYPE_WALL) < 0.5; }
bool isSmoke(float t) { return abs(t - TYPE_SMOKE) < 0.5; }
bool isOil(float t)   { return abs(t - TYPE_OIL) < 0.5; }
bool isFire(float t)  { return abs(t - TYPE_FIRE) < 0.5; }
bool isFalling(float t) { return isSand(t) || isWater(t) || isOil(t); }
bool isLiquid(float t) { return isWater(t) || isOil(t); }
bool isGas(float t) { return isSmoke(t); }

// Density: smoke < empty < oil < water < sand < wall
bool canDisplace(float mover, float target) {
  if (isEmpty(target)) return true;
  if (isSand(mover) && (isWater(target) || isOil(target) || isSmoke(target))) return true;
  if (isWater(mover) && (isOil(target) || isSmoke(target))) return true;
  if (isOil(mover) && isSmoke(target)) return true;
  return false;
}

// Smoke rises through empty, oil, water, and fire
bool canRiseThrough(float target) {
  return isEmpty(target) || isWater(target) || isOil(target) || isFire(target);
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
        if (isEmpty(ct) || (u_replacing > 0.5 && !isWall(ct))) {
          float variant = floor(hash21(pos * 0.97 + vec2(u_seed * 7.13)) * 256.0);
          if (isFire(u_particleType)) {
            gl_FragColor = encodeCellWithLife(TYPE_FIRE, variant, FIRE_MAX_LIFE);
          } else {
            gl_FragColor = encodeCell(u_particleType, variant);
          }
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

  // Phase 0: Smoke rises (reverse gravity)
  if (isGas(otBL) && canRiseThrough(otTL)) {
    vec4 tmp = oBL; oBL = oTL; oTL = tmp;
    float tt = otBL; otBL = otTL; otTL = tt;
  }
  if (isGas(otBR) && canRiseThrough(otTR)) {
    vec4 tmp = oBR; oBR = oTR; oTR = tmp;
    float tt = otBR; otBR = otTR; otTR = tt;
  }

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

  // Phase 4: Smoke horizontal dispersion
  float rnd3 = hash21(blockOrigin * 2.13 + vec2(u_seed + 13.0));

  // Top row: smoke disperses when blocked above (ceiling/other smoke)
  bool tlWasGas = isGas(tTL);
  bool trWasGas = isGas(tTR);

  if (rnd3 > 0.5) {
    if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      vec4 tmp = oTL; oTL = oTR; oTR = tmp;
      float tt = otTL; otTL = otTR; otTR = tt;
    } else if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      vec4 tmp = oTR; oTR = oTL; oTL = tmp;
      float tt = otTR; otTR = otTL; otTL = tt;
    }
  } else {
    if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      vec4 tmp = oTR; oTR = oTL; oTL = tmp;
      float tt = otTR; otTR = otTL; otTL = tt;
    } else if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      vec4 tmp = oTL; oTL = oTR; oTR = tmp;
      float tt = otTL; otTL = otTR; otTR = tt;
    }
  }

  // Bottom row: smoke disperses sideways (with wasGas guard and randomized direction)
  bool blWasGas = isGas(tBL);
  bool brWasGas = isGas(tBR);

  if (rnd3 > 0.5) {
    if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      vec4 tmp = oBL; oBL = oBR; oBR = tmp;
      float tt = otBL; otBL = otBR; otBR = tt;
    } else if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      vec4 tmp = oBR; oBR = oBL; oBL = tmp;
      float tt = otBR; otBR = otBL; otBL = tt;
    }
  } else {
    if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      vec4 tmp = oBR; oBR = oBL; oBL = tmp;
      float tt = otBR; otBR = otBL; otBL = tt;
    } else if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      vec4 tmp = oBL; oBL = oBR; oBR = tmp;
      float tt = otBL; otBL = otBR; otBR = tt;
    }
  }

  // Phase 5: Fire reactions (aging, ignition, extinguishing)
  // Age fire and kill dead fire → smoke
  if (isFire(otBL)) {
    float life = getLife(oBL) - FIRE_DECAY;
    if (life <= 0.0) { oBL = encodeCell(TYPE_SMOKE, oBL.g * 255.0); otBL = TYPE_SMOKE; }
    else { oBL.b = life / 255.0; }
  }
  if (isFire(otBR)) {
    float life = getLife(oBR) - FIRE_DECAY;
    if (life <= 0.0) { oBR = encodeCell(TYPE_SMOKE, oBR.g * 255.0); otBR = TYPE_SMOKE; }
    else { oBR.b = life / 255.0; }
  }
  if (isFire(otTL)) {
    float life = getLife(oTL) - FIRE_DECAY;
    if (life <= 0.0) { oTL = encodeCell(TYPE_SMOKE, oTL.g * 255.0); otTL = TYPE_SMOKE; }
    else { oTL.b = life / 255.0; }
  }
  if (isFire(otTR)) {
    float life = getLife(oTR) - FIRE_DECAY;
    if (life <= 0.0) { oTR = encodeCell(TYPE_SMOKE, oTR.g * 255.0); otTR = TYPE_SMOKE; }
    else { oTR.b = life / 255.0; }
  }

  // Oil ignition: oil adjacent to fire becomes fire
  bool blNeighborFire = isFire(otBR) || isFire(otTL) || isFire(otTR);
  bool brNeighborFire = isFire(otBL) || isFire(otTL) || isFire(otTR);
  bool tlNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTR);
  bool trNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTL);

  if (isOil(otBL) && blNeighborFire) { oBL = encodeCellWithLife(TYPE_FIRE, oBL.g * 255.0, FIRE_MAX_LIFE); otBL = TYPE_FIRE; }
  if (isOil(otBR) && brNeighborFire) { oBR = encodeCellWithLife(TYPE_FIRE, oBR.g * 255.0, FIRE_MAX_LIFE); otBR = TYPE_FIRE; }
  if (isOil(otTL) && tlNeighborFire) { oTL = encodeCellWithLife(TYPE_FIRE, oTL.g * 255.0, FIRE_MAX_LIFE); otTL = TYPE_FIRE; }
  if (isOil(otTR) && trNeighborFire) { oTR = encodeCellWithLife(TYPE_FIRE, oTR.g * 255.0, FIRE_MAX_LIFE); otTR = TYPE_FIRE; }

  // Water extinguishes fire → becomes smoke
  bool blNeighborWater = isWater(otBR) || isWater(otTL) || isWater(otTR);
  bool brNeighborWater = isWater(otBL) || isWater(otTL) || isWater(otTR);
  bool tlNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTR);
  bool trNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTL);

  if (isFire(otBL) && blNeighborWater) { oBL = encodeCell(TYPE_SMOKE, oBL.g * 255.0); otBL = TYPE_SMOKE; }
  if (isFire(otBR) && brNeighborWater) { oBR = encodeCell(TYPE_SMOKE, oBR.g * 255.0); otBR = TYPE_SMOKE; }
  if (isFire(otTL) && tlNeighborWater) { oTL = encodeCell(TYPE_SMOKE, oTL.g * 255.0); otTL = TYPE_SMOKE; }
  if (isFire(otTR) && trNeighborWater) { oTR = encodeCell(TYPE_SMOKE, oTR.g * 255.0); otTR = TYPE_SMOKE; }

  // Output
  int lx = int(local.x);
  int ly = int(local.y);

  if (lx == 0 && ly == 0)      gl_FragColor = oBL;
  else if (lx == 1 && ly == 0) gl_FragColor = oBR;
  else if (lx == 0 && ly == 1) gl_FragColor = oTL;
  else                          gl_FragColor = oTR;
}
`;
