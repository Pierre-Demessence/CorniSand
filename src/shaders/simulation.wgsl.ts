export const simulationWGSL = /* wgsl */`

struct Uniforms {
  resolution: vec2f,
  offset: f32,
  seed: f32,
  mousePos: vec2f,
  prevMousePos: vec2f,
  brushSize: f32,
  particleType: f32,
  mouseActive: f32,
  erasing: f32,
  replacing: f32,
  _pad: f32,
};

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> u: Uniforms;

const TYPE_EMPTY: f32 = 0.0;
const TYPE_SAND: f32  = 1.0;
const TYPE_WALL: f32  = 2.0;
const TYPE_WATER: f32 = 3.0;
const TYPE_SMOKE: f32 = 4.0;
const TYPE_OIL: f32   = 5.0;
const TYPE_FIRE: f32  = 6.0;

const FIRE_MAX_LIFE: f32 = 200.0;
const FIRE_DECAY: f32    = 4.0;

fn getType(cell: vec4f) -> f32 {
  return floor(cell.r * 255.0 + 0.5);
}

fn getLife(cell: vec4f) -> f32 {
  return floor(cell.b * 255.0 + 0.5);
}

fn encodeCell(pType: f32, variant: f32) -> vec4f {
  return vec4f(pType / 255.0, variant / 255.0, 0.0, 1.0);
}

fn encodeCellWithLife(pType: f32, variant: f32, life: f32) -> vec4f {
  return vec4f(pType / 255.0, variant / 255.0, life / 255.0, 1.0);
}

fn isEmpty(t: f32) -> bool { return t < 0.5; }
fn isSand(t: f32) -> bool  { return abs(t - TYPE_SAND) < 0.5; }
fn isWater(t: f32) -> bool { return abs(t - TYPE_WATER) < 0.5; }
fn isWall(t: f32) -> bool  { return abs(t - TYPE_WALL) < 0.5; }
fn isSmoke(t: f32) -> bool { return abs(t - TYPE_SMOKE) < 0.5; }
fn isOil(t: f32) -> bool   { return abs(t - TYPE_OIL) < 0.5; }
fn isFire(t: f32) -> bool  { return abs(t - TYPE_FIRE) < 0.5; }
fn isFalling(t: f32) -> bool { return isSand(t) || isWater(t) || isOil(t); }
fn isLiquid(t: f32) -> bool { return isWater(t) || isOil(t); }
fn isGas(t: f32) -> bool { return isSmoke(t); }

fn canDisplace(mover: f32, dest: f32) -> bool {
  if (isEmpty(dest)) { return true; }
  if (isSand(mover) && (isWater(dest) || isOil(dest) || isSmoke(dest))) { return true; }
  if (isWater(mover) && (isOil(dest) || isSmoke(dest))) { return true; }
  if (isOil(mover) && isSmoke(dest)) { return true; }
  return false;
}

fn canRiseThrough(dest: f32) -> bool {
  return isEmpty(dest) || isWater(dest) || isOil(dest) || isFire(dest);
}

fn hash21(p_in: vec2f) -> f32 {
  var p = fract(p_in * vec2f(233.34, 851.74));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

fn readCell(pos: vec2i) -> vec4f {
  if (pos.x < 0 || pos.x >= i32(u.resolution.x) ||
      pos.y < 0 || pos.y >= i32(u.resolution.y)) {
    return encodeCell(TYPE_WALL, 0.0);
  }
  return textureLoad(inputTex, pos, 0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (pos.x >= i32(u.resolution.x) || pos.y >= i32(u.resolution.y)) { return; }

  var current = readCell(pos);

  // --- Mouse input: paint or erase ---
  if (u.mouseActive > 0.5) {
    let ab = u.mousePos - u.prevMousePos;
    let segLen2 = dot(ab, ab);
    var t_param: f32 = 0.0;
    if (segLen2 > 0.001) {
      t_param = clamp(dot(vec2f(f32(pos.x), f32(pos.y)) - u.prevMousePos, ab) / segLen2, 0.0, 1.0);
    }
    let closest = u.prevMousePos + t_param * ab;
    let dist = length(vec2f(f32(pos.x), f32(pos.y)) - closest);
    if (dist <= u.brushSize) {
      if (u.erasing > 0.5) {
        let ct = getType(current);
        if (!isEmpty(ct)) {
          textureStore(outputTex, pos, encodeCell(TYPE_EMPTY, 0.0));
          return;
        }
      } else {
        let ct = getType(current);
        if (isEmpty(ct) || (u.replacing > 0.5 && !isWall(ct))) {
          let variant = floor(hash21(vec2f(f32(pos.x), f32(pos.y)) * 0.97 + vec2f(u.seed * 7.13, 0.0)) * 256.0);
          if (isFire(u.particleType)) {
            textureStore(outputTex, pos, encodeCellWithLife(TYPE_FIRE, variant, FIRE_MAX_LIFE));
          } else {
            textureStore(outputTex, pos, encodeCell(u.particleType, variant));
          }
          return;
        }
      }
    }
  }

  // --- Margolus neighborhood cellular automaton ---
  let offset = u.offset;
  let blockOrigin = floor((vec2f(f32(pos.x), f32(pos.y)) - offset) / 2.0) * 2.0 + offset;
  let local = vec2f(f32(pos.x), f32(pos.y)) - blockOrigin;
  let bo = vec2i(i32(blockOrigin.x), i32(blockOrigin.y));

  var vBL = readCell(bo);
  var vBR = readCell(vec2i(bo.x + 1, bo.y));
  var vTL = readCell(vec2i(bo.x, bo.y + 1));
  var vTR = readCell(vec2i(bo.x + 1, bo.y + 1));

  let tBL = getType(vBL); let tBR = getType(vBR);
  let tTL = getType(vTL); let tTR = getType(vTR);

  var oBL = vBL; var oBR = vBR; var oTL = vTL; var oTR = vTR;
  var otBL = tBL; var otBR = tBR; var otTL = tTL; var otTR = tTR;

  // Phase 0: Smoke rises
  if (isGas(otBL) && canRiseThrough(otTL)) {
    let tmp = oBL; oBL = oTL; oTL = tmp;
    let tt = otBL; otBL = otTL; otTL = tt;
  }
  if (isGas(otBR) && canRiseThrough(otTR)) {
    let tmp = oBR; oBR = oTR; oTR = tmp;
    let tt = otBR; otBR = otTR; otTR = tt;
  }

  // Phase 1: Vertical fall (gravity + density)
  if (isFalling(otTL) && canDisplace(otTL, otBL)) {
    let tmp = oTL; oTL = oBL; oBL = tmp;
    let tt = otTL; otTL = otBL; otBL = tt;
  }
  if (isFalling(otTR) && canDisplace(otTR, otBR)) {
    let tmp = oTR; oTR = oBR; oBR = tmp;
    let tt = otTR; otTR = otBR; otBR = tt;
  }

  // Phase 2: Diagonal slide (randomized)
  let rnd = hash21(blockOrigin * 0.731 + vec2f(u.seed, 0.0));

  if (rnd > 0.5) {
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      let tmp = oTL; oTL = oBR; oBR = tmp;
      let tt = otTL; otTL = otBR; otBR = tt;
    }
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      let tmp = oTR; oTR = oBL; oBL = tmp;
      let tt = otTR; otTR = otBL; otBL = tt;
    }
  } else {
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      let tmp = oTR; oTR = oBL; oBL = tmp;
      let tt = otTR; otTR = otBL; otBL = tt;
    }
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      let tmp = oTL; oTL = oBR; oBR = tmp;
      let tt = otTL; otTL = otBR; otBR = tt;
    }
  }

  // Phase 3: Horizontal liquid flow
  let rnd2 = hash21(blockOrigin * 1.37 + vec2f(u.seed + 7.0, 0.0));
  let blWasLiquid = isLiquid(tBL);
  let brWasLiquid = isLiquid(tBR);

  if (rnd2 > 0.5) {
    if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      let tmp = oBL; oBL = oBR; oBR = tmp;
      let tt = otBL; otBL = otBR; otBR = tt;
    } else if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      let tmp = oBR; oBR = oBL; oBL = tmp;
      let tt = otBR; otBR = otBL; otBL = tt;
    }
  } else {
    if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      let tmp = oBR; oBR = oBL; oBL = tmp;
      let tt = otBR; otBR = otBL; otBL = tt;
    } else if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      let tmp = oBL; oBL = oBR; oBR = tmp;
      let tt = otBL; otBL = otBR; otBR = tt;
    }
  }

  // Top row: liquid flows if blocked below
  if (isLiquid(otTL) && isEmpty(otTR) && !canDisplace(otTL, otBL)) {
    let tmp = oTL; oTL = oTR; oTR = tmp;
    let tt = otTL; otTL = otTR; otTR = tt;
  } else if (isLiquid(otTR) && isEmpty(otTL) && !canDisplace(otTR, otBR)) {
    let tmp = oTR; oTR = oTL; oTL = tmp;
    let tt = otTR; otTR = otTL; otTL = tt;
  }

  // Phase 4: Smoke horizontal dispersion
  let rnd3 = hash21(blockOrigin * 2.13 + vec2f(u.seed + 13.0, 0.0));
  let tlWasGas = isGas(tTL);
  let trWasGas = isGas(tTR);

  if (rnd3 > 0.5) {
    if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      let tmp = oTL; oTL = oTR; oTR = tmp;
      let tt = otTL; otTL = otTR; otTR = tt;
    } else if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      let tmp = oTR; oTR = oTL; oTL = tmp;
      let tt = otTR; otTR = otTL; otTL = tt;
    }
  } else {
    if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      let tmp = oTR; oTR = oTL; oTL = tmp;
      let tt = otTR; otTR = otTL; otTL = tt;
    } else if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      let tmp = oTL; oTL = oTR; oTR = tmp;
      let tt = otTL; otTL = otTR; otTR = tt;
    }
  }

  // Bottom row: smoke disperses sideways
  let blWasGas = isGas(tBL);
  let brWasGas = isGas(tBR);

  if (rnd3 > 0.5) {
    if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      let tmp = oBL; oBL = oBR; oBR = tmp;
      let tt = otBL; otBL = otBR; otBR = tt;
    } else if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      let tmp = oBR; oBR = oBL; oBL = tmp;
      let tt = otBR; otBR = otBL; otBL = tt;
    }
  } else {
    if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      let tmp = oBR; oBR = oBL; oBL = tmp;
      let tt = otBR; otBR = otBL; otBL = tt;
    } else if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      let tmp = oBL; oBL = oBR; oBR = tmp;
      let tt = otBL; otBL = otBR; otBR = tt;
    }
  }

  // Phase 5: Fire reactions
  if (isFire(otBL)) {
    let life = getLife(oBL) - FIRE_DECAY;
    if (life <= 0.0) { oBL = encodeCell(TYPE_SMOKE, oBL.g * 255.0); otBL = TYPE_SMOKE; }
    else { oBL = vec4f(oBL.r, oBL.g, life / 255.0, oBL.a); }
  }
  if (isFire(otBR)) {
    let life = getLife(oBR) - FIRE_DECAY;
    if (life <= 0.0) { oBR = encodeCell(TYPE_SMOKE, oBR.g * 255.0); otBR = TYPE_SMOKE; }
    else { oBR = vec4f(oBR.r, oBR.g, life / 255.0, oBR.a); }
  }
  if (isFire(otTL)) {
    let life = getLife(oTL) - FIRE_DECAY;
    if (life <= 0.0) { oTL = encodeCell(TYPE_SMOKE, oTL.g * 255.0); otTL = TYPE_SMOKE; }
    else { oTL = vec4f(oTL.r, oTL.g, life / 255.0, oTL.a); }
  }
  if (isFire(otTR)) {
    let life = getLife(oTR) - FIRE_DECAY;
    if (life <= 0.0) { oTR = encodeCell(TYPE_SMOKE, oTR.g * 255.0); otTR = TYPE_SMOKE; }
    else { oTR = vec4f(oTR.r, oTR.g, life / 255.0, oTR.a); }
  }

  // Oil ignition
  let blNeighborFire = isFire(otBR) || isFire(otTL) || isFire(otTR);
  let brNeighborFire = isFire(otBL) || isFire(otTL) || isFire(otTR);
  let tlNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTR);
  let trNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTL);

  if (isOil(otBL) && blNeighborFire) { oBL = encodeCellWithLife(TYPE_FIRE, oBL.g * 255.0, FIRE_MAX_LIFE); otBL = TYPE_FIRE; }
  if (isOil(otBR) && brNeighborFire) { oBR = encodeCellWithLife(TYPE_FIRE, oBR.g * 255.0, FIRE_MAX_LIFE); otBR = TYPE_FIRE; }
  if (isOil(otTL) && tlNeighborFire) { oTL = encodeCellWithLife(TYPE_FIRE, oTL.g * 255.0, FIRE_MAX_LIFE); otTL = TYPE_FIRE; }
  if (isOil(otTR) && trNeighborFire) { oTR = encodeCellWithLife(TYPE_FIRE, oTR.g * 255.0, FIRE_MAX_LIFE); otTR = TYPE_FIRE; }

  // Water extinguishes fire
  let blNeighborWater = isWater(otBR) || isWater(otTL) || isWater(otTR);
  let brNeighborWater = isWater(otBL) || isWater(otTL) || isWater(otTR);
  let tlNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTR);
  let trNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTL);

  if (isFire(otBL) && blNeighborWater) { oBL = encodeCell(TYPE_SMOKE, oBL.g * 255.0); otBL = TYPE_SMOKE; }
  if (isFire(otBR) && brNeighborWater) { oBR = encodeCell(TYPE_SMOKE, oBR.g * 255.0); otBR = TYPE_SMOKE; }
  if (isFire(otTL) && tlNeighborWater) { oTL = encodeCell(TYPE_SMOKE, oTL.g * 255.0); otTL = TYPE_SMOKE; }
  if (isFire(otTR) && trNeighborWater) { oTR = encodeCell(TYPE_SMOKE, oTR.g * 255.0); otTR = TYPE_SMOKE; }

  // Output based on local position within Margolus block
  let lx = i32(local.x);
  let ly = i32(local.y);

  var result: vec4f;
  if (lx == 0 && ly == 0)      { result = oBL; }
  else if (lx == 1 && ly == 0) { result = oBR; }
  else if (lx == 0 && ly == 1) { result = oTL; }
  else                          { result = oTR; }

  textureStore(outputTex, pos, result);
}
`;
