import { cellWGSL } from './cell.wgsl';

// Margolus CA for sand, water, oil, smoke and fire. One thread per 2x2 block reads the four cells, runs all rules on
// them and writes the four results. Out-of-bounds reads are walls and out-of-bounds writes are skipped, so blocks
// that stick out of the grid (offset 1, odd sizes) behave like blocks at a wall.
export const caWGSL = (width: number, height: number): string => /* wgsl */`
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
fn isLiquid(c: u32) -> bool { return isWater(c) || isOil(c); }
fn isFalling(c: u32) -> bool { return isSand(c) || isLiquid(c); }
fn isGas(c: u32) -> bool { return cellType(c) == TYPE_SMOKE; }

// Density order of the falling cells: oil floats on water, sand sinks through both. 0 is not a falling cell.
fn fallRank(c: u32) -> u32 {
  if (isOil(c)) { return 1u; }
  if (isWater(c)) { return 2u; }
  if (isSand(c)) { return 3u; }
  return 0u;
}

// A falling cell moves into empty space, a gas, or a lighter falling cell; never into a cell of its own density.
fn canDisplace(mover: u32, dest: u32) -> bool {
  if (isEmpty(dest) || isGas(dest)) { return true; }
  return fallRank(dest) > 0u && fallRank(mover) > fallRank(dest);
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

// A liquid cell remembers the sideways direction it last moved in, in its life field (0: none yet), so a stream
// keeps flowing instead of diffusing: a screen-wide pool levels in a few hundred dispatches, not tens of thousands.
const DIR_LEFT: u32 = 1u;
const DIR_RIGHT: u32 = 2u;
// A liquid that could move sideways turns around instead one time in this many (a mean free path of 64 cells).
const TURN_ONE_IN: u32 = 64u;

fn withDir(c: u32, dir: u32) -> u32 { return makeCell(cellType(c), cellVariant(c), dir); }

// A liquid cell that did not move this dispatch spreads along one row of the block, l left of r. It tries the
// direction it remembers (a fresh random pick when it has none); the other cell's side is outside the block, so
// that cell gets its turn when the offset alternates. Facing anything but empty space, and one time in TURN_ONE_IN
// facing it, it turns around instead. Side by side, two liquids never swap, so a layered body stays layered.
fn spreadRow(l: ptr<function, u32>, r: ptr<function, u32>, l0: u32, r0: u32, rnd: u32) {
  let turn = (rnd & (TURN_ONE_IN - 1u)) == 0u;
  if (isLiquid(*l) && *l == l0) {
    var dir = cellLife(*l);
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_RIGHT) {
      if (turn || !isEmpty(*r)) { *l = withDir(*l, DIR_LEFT); }
      else if (isEmpty(*r)) {
        *l = withDir(*l, DIR_RIGHT);
        swapCells(l, r);
        return;
      }
    }
  }
  if (isLiquid(*r) && *r == r0) {
    var dir = cellLife(*r);
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_LEFT) {
      if (turn || !isEmpty(*l)) { *r = withDir(*r, DIR_RIGHT); }
      else if (isEmpty(*l)) {
        *r = withDir(*r, DIR_LEFT);
        swapCells(l, r);
      }
    }
  }
}

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

  // Cells before any rule ran: a cell that differs from its original no longer sits where it started this dispatch,
  // so a particle that just arrived does not also move sideways in the same step.
  let bl0 = bl;
  let br0 = br;
  let tl0 = tl;
  let tr0 = tr;

  var rnd = hash2(gid.x, gid.y, u.seed);

  // Phase 0: Smoke rises
  if (isGas(bl) && canRiseThrough(tl)) { swapCells(&bl, &tl); }
  if (isGas(br) && canRiseThrough(tr)) { swapCells(&br, &tr); }

  // Phase 1: Sand and liquids fall, a heavier one through a lighter one
  if (isFalling(tl) && canDisplace(tl, bl)) { swapCells(&tl, &bl); }
  if (isFalling(tr) && canDisplace(tr, br)) { swapCells(&tr, &br); }

  // Phase 2: Blocked from below, sand and liquids slide diagonally into the bottom corner opposite their column.
  if (isFalling(tl) && !canDisplace(tl, bl) && canDisplace(tl, br)) { swapCells(&tl, &br); }
  if (isFalling(tr) && !canDisplace(tr, br) && canDisplace(tr, bl)) { swapCells(&tr, &bl); }

  // Phase 3: Smoke horizontal dispersion, top row
  if (pickRight(rnd)) {
    if (isGas(tl) && isEmpty(tr) && tl == tl0) { swapCells(&tl, &tr); }
  } else {
    if (isGas(tr) && isEmpty(tl) && tr == tr0) { swapCells(&tr, &tl); }
  }

  // Bottom row: smoke disperses sideways when it cannot rise
  rnd = pcg(rnd);
  if (pickRight(rnd)) {
    if (isGas(bl) && isEmpty(br) && !canRiseThrough(tl) && bl == bl0) { swapCells(&bl, &br); }
  } else {
    if (isGas(br) && isEmpty(bl) && !canRiseThrough(tr) && br == br0) { swapCells(&br, &bl); }
  }

  // Phase 3b: Liquids spread sideways
  rnd = pcg(rnd);
  spreadRow(&tl, &tr, tl0, tr0, rnd);
  rnd = pcg(rnd);
  spreadRow(&bl, &br, bl0, br0, rnd);

  // Phase 4: Fire reactions
  if (isFire(bl)) { bl = burn(bl); }
  if (isFire(br)) { br = burn(br); }
  if (isFire(tl)) { tl = burn(tl); }
  if (isFire(tr)) { tr = burn(tr); }

  // Which cells were fire before oil ignites: only those can be put out by water in this dispatch. Oil that
  // ignites next to water would otherwise turn to smoke at once.
  let blWasFire = isFire(bl);
  let brWasFire = isFire(br);
  let tlWasFire = isFire(tl);
  let trWasFire = isFire(tr);

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

  if (blWasFire && blNeighborWater) { bl = toSmoke(bl); }
  if (brWasFire && brNeighborWater) { br = toSmoke(br); }
  if (tlWasFire && tlNeighborWater) { tl = toSmoke(tl); }
  if (trWasFire && trNeighborWater) { tr = toSmoke(tr); }

  writeCell(ox, oy, bl);
  writeCell(ox + 1, oy, br);
  writeCell(ox, oy + 1, tl);
  writeCell(ox + 1, oy + 1, tr);
}
`;
