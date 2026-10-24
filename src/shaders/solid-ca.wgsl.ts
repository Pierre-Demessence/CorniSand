import { cellWGSL } from './cell.wgsl';

// Margolus CA for every particle type. One thread per 2x2 block reads the four
// cells, runs all rules on them and writes the four results. Out-of-bounds
// reads are walls and out-of-bounds writes are skipped, so blocks that stick
// out of the grid (offset 1, odd sizes) behave like blocks at a wall.
export const solidCaWGSL = (width: number, height: number): string => /* wgsl */`
${cellWGSL}

struct StepUniforms {
  offset: u32,
  seed: u32,
};

@group(0) @binding(0) var<storage, read> inputCells: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputCells: array<u32>;
@group(0) @binding(2) var<uniform> u: StepUniforms;

const W: u32 = ${width}u;
const H: u32 = ${height}u;

const FIRE_DECAY: u32 = 4u;

fn isEmpty(c: u32) -> bool { return cellType(c) == TYPE_EMPTY; }
fn isSand(c: u32) -> bool  { return cellType(c) == TYPE_SAND; }
fn isWater(c: u32) -> bool { return cellType(c) == TYPE_WATER; }
fn isSmoke(c: u32) -> bool { return cellType(c) == TYPE_SMOKE; }
fn isOil(c: u32) -> bool   { return cellType(c) == TYPE_OIL; }
fn isFire(c: u32) -> bool  { return cellType(c) == TYPE_FIRE; }
fn isFalling(c: u32) -> bool {
  let t = cellType(c);
  return t == TYPE_SAND || t == TYPE_WATER || t == TYPE_OIL;
}
fn isLiquid(c: u32) -> bool {
  let t = cellType(c);
  return t == TYPE_WATER || t == TYPE_OIL;
}
fn isGas(c: u32) -> bool { return cellType(c) == TYPE_SMOKE; }

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

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && x < i32(W) && y >= 0 && y < i32(H);
}

fn readCell(x: i32, y: i32) -> u32 {
  if (!inBounds(x, y)) { return makeCell(TYPE_WALL, 0u, 0u); }
  return inputCells[u32(y) * W + u32(x)];
}

fn writeCell(x: i32, y: i32, c: u32) {
  if (inBounds(x, y)) { outputCells[u32(y) * W + u32(x)] = c; }
}

fn swapCells(a: ptr<function, u32>, b: ptr<function, u32>) {
  let tmp = *a; *a = *b; *b = tmp;
}

// One bit of a random word, used to pick a direction.
fn pickRight(r: u32) -> bool { return (r >> 31u) == 1u; }

// A burnt-out or extinguished fire cell becomes smoke.
fn toSmoke(c: u32) -> u32 { return makeCell(TYPE_SMOKE, cellVariant(c), 0u); }

fn burn(c: u32) -> u32 {
  let life = cellLife(c);
  if (life <= FIRE_DECAY) { return toSmoke(c); }
  return makeCell(TYPE_FIRE, cellVariant(c), life - FIRE_DECAY);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= (W + u.offset + 1u) / 2u || gid.y >= (H + u.offset + 1u) / 2u) { return; }

  let ox = i32(gid.x) * 2 - i32(u.offset);
  let oy = i32(gid.y) * 2 - i32(u.offset);

  var bl = readCell(ox, oy);
  var br = readCell(ox + 1, oy);
  var tl = readCell(ox, oy + 1);
  var tr = readCell(ox + 1, oy + 1);

  // Types before any rule ran: "was liquid/gas" keeps a particle that just
  // arrived in a cell from also moving sideways in the same step.
  let blWasLiquid = isLiquid(bl);
  let brWasLiquid = isLiquid(br);
  let blWasGas = isGas(bl);
  let brWasGas = isGas(br);
  let tlWasGas = isGas(tl);
  let trWasGas = isGas(tr);

  var rnd = hash2(gid.x, gid.y, u.seed);

  // Phase 0: Smoke rises
  if (isGas(bl) && canRiseThrough(tl)) { swapCells(&bl, &tl); }
  if (isGas(br) && canRiseThrough(tr)) { swapCells(&br, &tr); }

  // Phase 1: Vertical fall (gravity + density)
  if (isFalling(tl) && canDisplace(tl, bl)) { swapCells(&tl, &bl); }
  if (isFalling(tr) && canDisplace(tr, br)) { swapCells(&tr, &br); }

  // Phase 2: Sand slides diagonally into the bottom corner opposite its column.
  // The two slides are mutually exclusive, so their order never matters.
  if (isSand(tl) && !canDisplace(tl, bl) && canDisplace(tl, br)) { swapCells(&tl, &br); }
  if (isSand(tr) && !canDisplace(tr, br) && canDisplace(tr, bl)) { swapCells(&tr, &bl); }

  // Phase 3: Horizontal liquid flow. Each row picks one direction and tries
  // only that move.
  if (pickRight(rnd)) {
    if (isLiquid(bl) && isEmpty(br) && blWasLiquid) { swapCells(&bl, &br); }
  } else {
    if (isLiquid(br) && isEmpty(bl) && brWasLiquid) { swapCells(&br, &bl); }
  }

  // Top row: liquid flows if blocked below
  rnd = pcg(rnd);
  if (pickRight(rnd)) {
    if (isLiquid(tl) && isEmpty(tr) && !canDisplace(tl, bl)) { swapCells(&tl, &tr); }
  } else {
    if (isLiquid(tr) && isEmpty(tl) && !canDisplace(tr, br)) { swapCells(&tr, &tl); }
  }

  // Phase 4: Smoke horizontal dispersion, top row
  rnd = pcg(rnd);
  if (pickRight(rnd)) {
    if (isGas(tl) && isEmpty(tr) && tlWasGas) { swapCells(&tl, &tr); }
  } else {
    if (isGas(tr) && isEmpty(tl) && trWasGas) { swapCells(&tr, &tl); }
  }

  // Bottom row: smoke disperses sideways when it cannot rise
  rnd = pcg(rnd);
  if (pickRight(rnd)) {
    if (isGas(bl) && isEmpty(br) && !canRiseThrough(tl) && blWasGas) { swapCells(&bl, &br); }
  } else {
    if (isGas(br) && isEmpty(bl) && !canRiseThrough(tr) && brWasGas) { swapCells(&br, &bl); }
  }

  // Phase 5: Fire reactions
  if (isFire(bl)) { bl = burn(bl); }
  if (isFire(br)) { br = burn(br); }
  if (isFire(tl)) { tl = burn(tl); }
  if (isFire(tr)) { tr = burn(tr); }

  // Oil ignition by neighboring fire
  let blNeighborFire = isFire(br) || isFire(tl) || isFire(tr);
  let brNeighborFire = isFire(bl) || isFire(tl) || isFire(tr);
  let tlNeighborFire = isFire(bl) || isFire(br) || isFire(tr);
  let trNeighborFire = isFire(bl) || isFire(br) || isFire(tl);

  if (isOil(bl) && blNeighborFire) { bl = makeCell(TYPE_FIRE, cellVariant(bl), FIRE_MAX_LIFE); }
  if (isOil(br) && brNeighborFire) { br = makeCell(TYPE_FIRE, cellVariant(br), FIRE_MAX_LIFE); }
  if (isOil(tl) && tlNeighborFire) { tl = makeCell(TYPE_FIRE, cellVariant(tl), FIRE_MAX_LIFE); }
  if (isOil(tr) && trNeighborFire) { tr = makeCell(TYPE_FIRE, cellVariant(tr), FIRE_MAX_LIFE); }

  // Water extinguishes fire
  let blNeighborWater = isWater(br) || isWater(tl) || isWater(tr);
  let brNeighborWater = isWater(bl) || isWater(tl) || isWater(tr);
  let tlNeighborWater = isWater(bl) || isWater(br) || isWater(tr);
  let trNeighborWater = isWater(bl) || isWater(br) || isWater(tl);

  if (isFire(bl) && blNeighborWater) { bl = toSmoke(bl); }
  if (isFire(br) && brNeighborWater) { br = toSmoke(br); }
  if (isFire(tl) && tlNeighborWater) { tl = toSmoke(tl); }
  if (isFire(tr) && trNeighborWater) { tr = toSmoke(tr); }

  writeCell(ox, oy, bl);
  writeCell(ox + 1, oy, br);
  writeCell(ox, oy + 1, tl);
  writeCell(ox + 1, oy + 1, tr);
}
`;
