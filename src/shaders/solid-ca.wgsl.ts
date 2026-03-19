// Full Margolus CA: handles all particles (sand, water, oil, smoke, fire).
// Liquid flow is biased by pressure gradient for wave propagation.
// When sand displaces fluid, velocity impulse is stored.
export const solidCaWGSL = /* wgsl */`

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

@group(0) @binding(0) var<storage, read> inputCells: array<Cell>;
@group(0) @binding(1) var<storage, read_write> outputCells: array<Cell>;
@group(0) @binding(2) var<uniform> u: Uniforms;

const TYPE_EMPTY: u32 = 0u;
const TYPE_SAND: u32  = 1u;
const TYPE_WALL: u32  = 2u;
const TYPE_WATER: u32 = 3u;
const TYPE_SMOKE: u32 = 4u;
const TYPE_OIL: u32   = 5u;
const TYPE_FIRE: u32  = 6u;

const FIRE_MAX_LIFE: f32 = 200.0;
const FIRE_DECAY: f32    = 4.0;
const SPLASH_IMPULSE: f32 = 3.0;
const PRESSURE_FROM_FALL: f32 = 1.5;

fn cellIdx(x: i32, y: i32) -> u32 {
  return u32(y) * u32(u.resolution.x) + u32(x);
}

fn makeCell(t: u32, v: f32) -> Cell {
  return Cell(t, v, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
}

fn makeCellWithLife(t: u32, v: f32, life: f32) -> Cell {
  return Cell(t, v, life, 0.0, 0.0, 0.0, 0.0, 0.0);
}

fn isEmpty(t: u32) -> bool { return t == TYPE_EMPTY; }
fn isSand(t: u32) -> bool  { return t == TYPE_SAND; }
fn isWater(t: u32) -> bool { return t == TYPE_WATER; }
fn isWall(t: u32) -> bool  { return t == TYPE_WALL; }
fn isSmoke(t: u32) -> bool { return t == TYPE_SMOKE; }
fn isOil(t: u32) -> bool   { return t == TYPE_OIL; }
fn isFire(t: u32) -> bool  { return t == TYPE_FIRE; }
fn isFalling(t: u32) -> bool { return t == TYPE_SAND || t == TYPE_WATER || t == TYPE_OIL; }
fn isLiquid(t: u32) -> bool { return t == TYPE_WATER || t == TYPE_OIL; }
fn isGas(t: u32) -> bool { return t == TYPE_SMOKE; }

fn canDisplace(mover: u32, dest: u32) -> bool {
  if (isEmpty(dest)) { return true; }
  if (isSand(mover) && (isWater(dest) || isOil(dest) || isSmoke(dest))) { return true; }
  if (isWater(mover) && (isOil(dest) || isSmoke(dest))) { return true; }
  if (isOil(mover) && isSmoke(dest)) { return true; }
  return false;
}

fn canRiseThrough(dest: u32) -> bool {
  return isEmpty(dest) || isWater(dest) || isOil(dest) || isFire(dest);
}

fn hash21(p_in: vec2f) -> f32 {
  var p = fract(p_in * vec2f(233.34, 851.74));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

fn readCell(x: i32, y: i32) -> Cell {
  if (x < 0 || x >= i32(u.resolution.x) || y < 0 || y >= i32(u.resolution.y)) {
    return makeCell(TYPE_WALL, 0.0);
  }
  return inputCells[cellIdx(x, y)];
}

// Swap two cells, preserving pressure/velocity
fn swapCells(a: ptr<function, Cell>, b: ptr<function, Cell>,
             ta: ptr<function, u32>, tb: ptr<function, u32>) {
  let tmpC = *a; *a = *b; *b = tmpC;
  let tmpT = *ta; *ta = *tb; *tb = tmpT;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  let w = i32(u.resolution.x);
  let h = i32(u.resolution.y);
  if (pos.x >= w || pos.y >= h) { return; }

  var current = readCell(pos.x, pos.y);
  let outIdx = cellIdx(pos.x, pos.y);

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
        if (!isEmpty(current.pType)) {
          outputCells[outIdx] = makeCell(TYPE_EMPTY, 0.0);
          return;
        }
      } else {
        let ct = current.pType;
        let pType = u32(u.particleType);
        if (isEmpty(ct) || (u.replacing > 0.5 && !isWall(ct))) {
          let variant = floor(hash21(vec2f(f32(pos.x), f32(pos.y)) * 0.97 + vec2f(u.seed * 7.13, 0.0)) * 256.0);
          if (isFire(pType)) {
            outputCells[outIdx] = makeCellWithLife(TYPE_FIRE, variant, FIRE_MAX_LIFE);
          } else {
            outputCells[outIdx] = makeCell(pType, variant);
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

  var vBL = readCell(bo.x, bo.y);
  var vBR = readCell(bo.x + 1, bo.y);
  var vTL = readCell(bo.x, bo.y + 1);
  var vTR = readCell(bo.x + 1, bo.y + 1);

  var tBL = vBL.pType; var tBR = vBR.pType;
  var tTL = vTL.pType; var tTR = vTR.pType;

  var oBL = vBL; var oBR = vBR; var oTL = vTL; var oTR = vTR;
  var otBL = tBL; var otBR = tBR; var otTL = tTL; var otTR = tTR;

  // Phase 0: Smoke rises
  if (isGas(otBL) && canRiseThrough(otTL)) {
    swapCells(&oBL, &oTL, &otBL, &otTL);
  }
  if (isGas(otBR) && canRiseThrough(otTR)) {
    swapCells(&oBR, &oTR, &otBR, &otTR);
  }

  // Phase 1: Vertical fall (gravity + density)
  if (isFalling(otTL) && canDisplace(otTL, otBL)) {
    // Sand into fluid: create pressure impulse
    if (isSand(otTL) && isLiquid(otBL)) {
      oTL.pressure += PRESSURE_FROM_FALL;
      oBL.velocityY += SPLASH_IMPULSE;
    }
    // Liquid falling into liquid: accumulate pressure
    if (isLiquid(otTL) && isLiquid(otBL)) {
      oBL.pressure += abs(oTL.velocityY) * 0.3;
    }
    swapCells(&oTL, &oBL, &otTL, &otBL);
  }
  if (isFalling(otTR) && canDisplace(otTR, otBR)) {
    if (isSand(otTR) && isLiquid(otBR)) {
      oTR.pressure += PRESSURE_FROM_FALL;
      oBR.velocityY += SPLASH_IMPULSE;
    }
    if (isLiquid(otTR) && isLiquid(otBR)) {
      oBR.pressure += abs(oTR.velocityY) * 0.3;
    }
    swapCells(&oTR, &oBR, &otTR, &otBR);
  }

  // Phase 2: Diagonal slide (randomized)
  let rnd = hash21(blockOrigin * 0.731 + vec2f(u.seed, 0.0));

  if (rnd > 0.5) {
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      swapCells(&oTL, &oBR, &otTL, &otBR);
    }
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      swapCells(&oTR, &oBL, &otTR, &otBL);
    }
  } else {
    if (isSand(otTR) && !canDisplace(otTR, otBR) && canDisplace(otTR, otBL)) {
      swapCells(&oTR, &oBL, &otTR, &otBL);
    }
    if (isSand(otTL) && !canDisplace(otTL, otBL) && canDisplace(otTL, otBR)) {
      swapCells(&oTL, &oBR, &otTL, &otBR);
    }
  }

  // Phase 3: Horizontal liquid flow — biased by pressure gradient
  let rnd2 = hash21(blockOrigin * 1.37 + vec2f(u.seed + 7.0, 0.0));
  let blWasLiquid = isLiquid(tBL);
  let brWasLiquid = isLiquid(tBR);

  // Pressure-biased flow direction: liquid flows toward lower pressure
  let pressureL = oBL.pressure + oBL.velocityX * -1.0;
  let pressureR = oBR.pressure + oBR.velocityX;
  let pressureBias = (pressureL - pressureR) * 0.3;
  let flowThreshold = 0.5 + pressureBias;

  if (rnd2 > flowThreshold) {
    if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      oBL.velocityX += 0.5;
      swapCells(&oBL, &oBR, &otBL, &otBR);
    } else if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      oBR.velocityX -= 0.5;
      swapCells(&oBR, &oBL, &otBR, &otBL);
    }
  } else {
    if (isLiquid(otBR) && isEmpty(otBL) && brWasLiquid) {
      oBR.velocityX -= 0.5;
      swapCells(&oBR, &oBL, &otBR, &otBL);
    } else if (isLiquid(otBL) && isEmpty(otBR) && blWasLiquid) {
      oBL.velocityX += 0.5;
      swapCells(&oBL, &oBR, &otBL, &otBR);
    }
  }

  // Top row: liquid flows if blocked below
  let pressureTL = oTL.pressure + oTL.velocityX * -1.0;
  let pressureTR = oTR.pressure + oTR.velocityX;
  let topBias = (pressureTL - pressureTR) * 0.3;
  let topThreshold = 0.5 + topBias;

  if (rnd2 > topThreshold) {
    if (isLiquid(otTL) && isEmpty(otTR) && !canDisplace(otTL, otBL)) {
      oTL.velocityX += 0.5;
      swapCells(&oTL, &oTR, &otTL, &otTR);
    } else if (isLiquid(otTR) && isEmpty(otTL) && !canDisplace(otTR, otBR)) {
      oTR.velocityX -= 0.5;
      swapCells(&oTR, &oTL, &otTR, &otTL);
    }
  } else {
    if (isLiquid(otTR) && isEmpty(otTL) && !canDisplace(otTR, otBR)) {
      oTR.velocityX -= 0.5;
      swapCells(&oTR, &oTL, &otTR, &otTL);
    } else if (isLiquid(otTL) && isEmpty(otTR) && !canDisplace(otTL, otBL)) {
      oTL.velocityX += 0.5;
      swapCells(&oTL, &oTR, &otTL, &otTR);
    }
  }

  // Phase 4: Smoke horizontal dispersion
  let rnd3 = hash21(blockOrigin * 2.13 + vec2f(u.seed + 13.0, 0.0));
  let tlWasGas = isGas(tTL);
  let trWasGas = isGas(tTR);

  if (rnd3 > 0.5) {
    if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      swapCells(&oTL, &oTR, &otTL, &otTR);
    } else if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      swapCells(&oTR, &oTL, &otTR, &otTL);
    }
  } else {
    if (isGas(otTR) && isEmpty(otTL) && trWasGas) {
      swapCells(&oTR, &oTL, &otTR, &otTL);
    } else if (isGas(otTL) && isEmpty(otTR) && tlWasGas) {
      swapCells(&oTL, &oTR, &otTL, &otTR);
    }
  }

  // Bottom row: smoke disperses sideways
  let blWasGas = isGas(tBL);
  let brWasGas = isGas(tBR);

  if (rnd3 > 0.5) {
    if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      swapCells(&oBL, &oBR, &otBL, &otBR);
    } else if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      swapCells(&oBR, &oBL, &otBR, &otBL);
    }
  } else {
    if (isGas(otBR) && isEmpty(otBL) && !canRiseThrough(otTR) && brWasGas) {
      swapCells(&oBR, &oBL, &otBR, &otBL);
    } else if (isGas(otBL) && isEmpty(otBR) && !canRiseThrough(otTL) && blWasGas) {
      swapCells(&oBL, &oBR, &otBL, &otBR);
    }
  }

  // Phase 5: Fire reactions
  if (isFire(otBL)) {
    let life = oBL.lifetime - FIRE_DECAY;
    if (life <= 0.0) { oBL = makeCell(TYPE_SMOKE, oBL.variant); otBL = TYPE_SMOKE; }
    else { oBL.lifetime = life; }
  }
  if (isFire(otBR)) {
    let life = oBR.lifetime - FIRE_DECAY;
    if (life <= 0.0) { oBR = makeCell(TYPE_SMOKE, oBR.variant); otBR = TYPE_SMOKE; }
    else { oBR.lifetime = life; }
  }
  if (isFire(otTL)) {
    let life = oTL.lifetime - FIRE_DECAY;
    if (life <= 0.0) { oTL = makeCell(TYPE_SMOKE, oTL.variant); otTL = TYPE_SMOKE; }
    else { oTL.lifetime = life; }
  }
  if (isFire(otTR)) {
    let life = oTR.lifetime - FIRE_DECAY;
    if (life <= 0.0) { oTR = makeCell(TYPE_SMOKE, oTR.variant); otTR = TYPE_SMOKE; }
    else { oTR.lifetime = life; }
  }

  // Oil ignition by neighboring fire
  let blNeighborFire = isFire(otBR) || isFire(otTL) || isFire(otTR);
  let brNeighborFire = isFire(otBL) || isFire(otTL) || isFire(otTR);
  let tlNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTR);
  let trNeighborFire = isFire(otBL) || isFire(otBR) || isFire(otTL);

  if (isOil(otBL) && blNeighborFire) { oBL = makeCellWithLife(TYPE_FIRE, oBL.variant, FIRE_MAX_LIFE); otBL = TYPE_FIRE; }
  if (isOil(otBR) && brNeighborFire) { oBR = makeCellWithLife(TYPE_FIRE, oBR.variant, FIRE_MAX_LIFE); otBR = TYPE_FIRE; }
  if (isOil(otTL) && tlNeighborFire) { oTL = makeCellWithLife(TYPE_FIRE, oTL.variant, FIRE_MAX_LIFE); otTL = TYPE_FIRE; }
  if (isOil(otTR) && trNeighborFire) { oTR = makeCellWithLife(TYPE_FIRE, oTR.variant, FIRE_MAX_LIFE); otTR = TYPE_FIRE; }

  // Water extinguishes fire
  let blNeighborWater = isWater(otBR) || isWater(otTL) || isWater(otTR);
  let brNeighborWater = isWater(otBL) || isWater(otTL) || isWater(otTR);
  let tlNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTR);
  let trNeighborWater = isWater(otBL) || isWater(otBR) || isWater(otTL);

  if (isFire(otBL) && blNeighborWater) { oBL = makeCell(TYPE_SMOKE, oBL.variant); otBL = TYPE_SMOKE; }
  if (isFire(otBR) && brNeighborWater) { oBR = makeCell(TYPE_SMOKE, oBR.variant); otBR = TYPE_SMOKE; }
  if (isFire(otTL) && tlNeighborWater) { oTL = makeCell(TYPE_SMOKE, oTL.variant); otTL = TYPE_SMOKE; }
  if (isFire(otTR) && trNeighborWater) { oTR = makeCell(TYPE_SMOKE, oTR.variant); otTR = TYPE_SMOKE; }

  // Dampen velocity over time
  oBL.velocityX *= 0.95; oBL.velocityY *= 0.95;
  oBR.velocityX *= 0.95; oBR.velocityY *= 0.95;
  oTL.velocityX *= 0.95; oTL.velocityY *= 0.95;
  oTR.velocityX *= 0.95; oTR.velocityY *= 0.95;

  // Output based on local position within Margolus block
  let lx = i32(local.x);
  let ly = i32(local.y);

  var result: Cell;
  if (lx == 0 && ly == 0)      { result = oBL; }
  else if (lx == 1 && ly == 0) { result = oBR; }
  else if (lx == 0 && ly == 1) { result = oTL; }
  else                          { result = oTR; }

  outputCells[outIdx] = result;
}
`;
