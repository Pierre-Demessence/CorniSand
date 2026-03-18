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

float getType(vec4 cell) {
  return floor(cell.r * 255.0 + 0.5);
}

vec4 encodeCell(float pType, float variant) {
  return vec4(pType / 255.0, variant / 255.0, 0.0, 1.0);
}

bool isFalling(float t) {
  return t > 0.5 && t < 1.5;
}

bool isEmpty(float t) {
  return t < 0.5;
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
  // Distance to line segment between prev and current mouse pos
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

  // Read the 4 cells of this 2x2 block
  // Layout:  [TL TR]   TL=(0,1) TR=(1,1)
  //          [BL BR]   BL=(0,0) BR=(1,0)
  vec4 vBL = readCell(blockOrigin);
  vec4 vBR = readCell(blockOrigin + vec2(1.0, 0.0));
  vec4 vTL = readCell(blockOrigin + vec2(0.0, 1.0));
  vec4 vTR = readCell(blockOrigin + vec2(1.0, 1.0));

  float tBL = getType(vBL);
  float tBR = getType(vBR);
  float tTL = getType(vTL);
  float tTR = getType(vTR);

  // Working copies
  vec4 oBL = vBL, oBR = vBR, oTL = vTL, oTR = vTR;
  float otBL = tBL, otBR = tBR, otTL = tTL, otTR = tTR;

  // Phase 1: Vertical fall (gravity)
  if (isFalling(otTL) && isEmpty(otBL)) {
    vec4 tmp = oTL; oTL = oBL; oBL = tmp;
    float tt = otTL; otTL = otBL; otBL = tt;
  }
  if (isFalling(otTR) && isEmpty(otBR)) {
    vec4 tmp = oTR; oTR = oBR; oBR = tmp;
    float tt = otTR; otTR = otBR; otBR = tt;
  }

  // Phase 2: Diagonal slide (randomized direction to prevent bias)
  float rnd = hash21(blockOrigin * 0.731 + vec2(u_seed));

  if (rnd > 0.5) {
    if (isFalling(otTL) && !isEmpty(otBL) && isEmpty(otBR)) {
      oBR = oTL; oTL = encodeCell(TYPE_EMPTY, 0.0);
      otBR = otTL; otTL = TYPE_EMPTY;
    }
    if (isFalling(otTR) && !isEmpty(otBR) && isEmpty(otBL)) {
      oBL = oTR; oTR = encodeCell(TYPE_EMPTY, 0.0);
      otBL = otTR; otTR = TYPE_EMPTY;
    }
  } else {
    if (isFalling(otTR) && !isEmpty(otBR) && isEmpty(otBL)) {
      oBL = oTR; oTR = encodeCell(TYPE_EMPTY, 0.0);
      otBL = otTR; otTR = TYPE_EMPTY;
    }
    if (isFalling(otTL) && !isEmpty(otBL) && isEmpty(otBR)) {
      oBR = oTL; oTL = encodeCell(TYPE_EMPTY, 0.0);
      otBR = otTL; otTL = TYPE_EMPTY;
    }
  }

  // Output the cell matching this fragment's position in the block
  int lx = int(local.x);
  int ly = int(local.y);

  if (lx == 0 && ly == 0)      gl_FragColor = oBL;
  else if (lx == 1 && ly == 0) gl_FragColor = oBR;
  else if (lx == 0 && ly == 1) gl_FragColor = oTL;
  else                          gl_FragColor = oTR;
}
`;
