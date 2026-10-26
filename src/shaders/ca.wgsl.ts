import type { ElementDef } from '../elements';
import { launchGroups, movementWGSL } from '../movement';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// The cells of a block are slots 0 to 3: bottom left, bottom right, top left, top right (slot = column + 2 * row).
const SLOTS = [0, 1, 2, 3] as const;

// Margolus CA for every element, driven by the element table. One thread per 2x2 block reads the four cells, runs all
// rules on them and writes back the fields that changed, in place: a rule reads and writes only the cells of its own
// block, so no two threads touch the same cell. Out-of-bounds reads are walls and out-of-bounds writes are skipped, so
// blocks that stick out of the grid (offset 1, odd sizes) behave like blocks at a wall.
//
// The phases: gases rise, falling cells move by velocity, gases and liquids spread sideways, lifetimes, then the optional
// rules. Ignition is decided between the lifetimes and the rules but applied after them, so a rule never sees a cell
// that ignites in the same dispatch. A cell faster than LAUNCH_SPEED waits where it is for the flyer passes, which run
// after the offset-1 dispatch; that dispatch also counts the launching cells of each workgroup (group 3).
// `rules` maps a rule name (`ElementDef.rule`) to its WGSL.
export const caWGSL = (
  width: number,
  height: number,
  elements: readonly ElementDef[],
  rules: Readonly<Record<string, string>>,
  maxFlyers: number,
): string => {
  const ruled = elements.filter((e) => e.rule !== undefined);
  for (const e of ruled) if (!(e.rule! in rules)) throw new Error(`element ${e.key}: unknown rule "${e.rule}"`);
  const ruleNames = [...new Set(ruled.map((e) => e.rule!))];
  const burns = elements.some((e) => e.flammable);
  const groups = launchGroups(width, height);

  // For each cell of the block, whether it ignites: flammable, with a fire cell in the block (after the lifetimes).
  const ignitionDecisions = SLOTS.map((n) => {
    const others = SLOTS.filter((o) => o !== n).map((o) => `cellType(blk[${o}]) == EL_FIRE`).join(' || ');
    return `  let ignite_${n} = elFlammable(cellType(blk[${n}])) && (${others});`;
  }).join('\n');
  const ignitionApplied = SLOTS.map((n) =>
    `  if (ignite_${n} && elFlammable(cellType(blk[${n}]))) { blk[${n}] = retype(blk[${n}], EL_FIRE, cellVariant(blk[${n}]), elLifeStart(EL_FIRE)); }`,
  ).join('\n');

  // A generated switch on the cell's element: only cells of an element with a rule call it.
  const ruleSwitches = SLOTS.map((i) => `  switch (cellType(block[${i}])) {
${ruled.map((e) => `    case EL_${e.key}: { rule_${e.rule}(${i}u, &block); }`).join('\n')}
    default: {}
  }`).join('\n');
  const ruleSection = ruled.length === 0 ? '' : `
  var block = array<Cell, 4>(blk[0], blk[1], blk[2], blk[3]);
${ruleSwitches}
  blk[0] = block[0]; blk[1] = block[1]; blk[2] = block[2]; blk[3] = block[3];`;

  return /* wgsl */`
${cellWGSL('read_write', elements)}
${elementsWGSL}
${movementWGSL(maxFlyers)}
${ruleNames.map((n) => rules[n]).join('\n')}

struct StepUniforms {
  offset: u32,
  seed: u32,
};

@group(0) @binding(0) var<uniform> u: StepUniforms;
// One launch count per workgroup of the offset-1 dispatch, then their total in the last word.
@group(3) @binding(0) var<storage, read_write> launchCounts: array<atomic<u32>>;
var<workgroup> wgLaunches: atomic<u32>;

const W: u32 = ${width}u;
const H: u32 = ${height}u;

// The block being processed and the cells as they were loaded. \`moved[k]\` is set when slot k holds another cell than
// it started the dispatch with, so a cell that just arrived does not also move sideways in the same step.
var<private> blk: array<Cell, 4>;
var<private> orig: array<Cell, 4>;
var<private> moved: array<bool, 4>;

fn cellState(c: Cell) -> u32 { return elState(cellType(c)); }
fn cellDensity(c: Cell) -> f32 { return elDensity(cellType(c)); }

fn isEmpty(c: Cell) -> bool { return cellState(c) == ST_EMPTY; }
fn isLiquid(c: Cell) -> bool { return cellState(c) == ST_LIQUID; }
fn isGas(c: Cell) -> bool { return cellState(c) == ST_GAS; }
fn isFalling(c: Cell) -> bool { return cellState(c) == ST_POWDER || isLiquid(c); }

// A falling cell moves into empty space, or into a gas or another falling cell that is lighter; never into a cell of
// its own density, a solid or fire.
fn canDisplace(mover: Cell, dest: Cell) -> bool {
  let s = cellState(dest);
  if (s == ST_EMPTY) { return true; }
  if (s == ST_GAS || s == ST_POWDER || s == ST_LIQUID) { return cellDensity(dest) < cellDensity(mover); }
  return false;
}

// A gas rises into empty space, through fire, or through a liquid heavier than itself.
fn canRiseThrough(mover: Cell, dest: Cell) -> bool {
  let s = cellState(dest);
  if (s == ST_EMPTY || s == ST_PLASMA) { return true; }
  return s == ST_LIQUID && cellDensity(dest) > cellDensity(mover);
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && x < i32(W) && y >= 0 && y < i32(H);
}

fn readCell(x: i32, y: i32) -> Cell {
  if (!inBounds(x, y)) { return makeCell(EL_WALL, 0u, 0u); }
  return loadCell(u32(y) * W + u32(x));
}

fn writeCell(x: i32, y: i32, c: Cell, before: Cell) {
  if (inBounds(x, y)) { storeChanged(u32(y) * W + u32(x), c, before); }
}

// Both cells keep all their fields.
fn swapSlots(a: u32, b: u32) {
  let tmp = blk[a]; blk[a] = blk[b]; blk[b] = tmp;
  moved[a] = true;
  moved[b] = true;
}

// One bit of a random word, used to pick a direction.
fn pickRight(r: u32) -> bool { return (r >> 31u) == 1u; }

// The cell as another element: every field but the element, variant and life is kept, except that only a falling
// element keeps its motion.
fn retype(c: Cell, t: u32, variant: u32, life: u32) -> Cell {
  var r = withType(c, t, variant, life);
  let s = elState(t);
  if (s != ST_POWDER && s != ST_LIQUID) {
    r.velocity = 0u;
    r.remainder = 0u;
  }
  return r;
}

// -- Falling cells --

fn stepOf(r: f32) -> i32 {
  if (r >= 1.0) { return 1; }
  if (r <= -1.0) { return -1; }
  return 0;
}

// -1 when (col, row) is outside the block.
fn slotAt(col: i32, row: i32) -> i32 {
  if (col < 0 || col > 1 || row < 0 || row > 1) { return -1; }
  return col + 2 * row;
}

// Speed left on one axis after bumping into the cell in slot j: that cell's speed if it moves the same way more
// slowly, else 0. A cell falling onto a falling cell follows it instead of stopping.
fn bumped(v: f32, j: u32, axis: u32) -> f32 {
  let ov = cellVelocity(blk[j])[axis];
  if (v < 0.0) { return min(0.0, max(v, ov)); }
  return max(0.0, min(v, ov));
}

// A powder or liquid cell: integrate its velocity, move it one cell inside the block once the remainder reaches 1 on an
// axis (swapping with a lighter cell in the way), stop an axis that is blocked, lose sideways speed and slide
// diagonally when it rests on something.
fn velocityRule(i: u32) {
  if (moved[i] || !isFalling(blk[i])) { return; }
  let c = blk[i];
  var v = cellVelocity(c);
  var r = cellRemainder(c);
  // Waiting for the launch pass: frozen, an obstacle for the others.
  if (length(v) > LAUNCH_SPEED) { return; }

  let col = i32(i & 1u);
  let row = i32(i >> 1u);
  // A cell at rest starts falling only once a top-row dispatch has seen the cell below it free. Otherwise every level
  // of a resting stack banks one more gravity step than the one under it, and the top of a deep layer launches.
  if (row == 1 || v.y != 0.0) { v.y -= elGravity(cellType(c)); }
  if (length(v) > MAX_FLYER_SPEED) { v *= MAX_FLYER_SPEED / length(v); }
  r += clamp(v, vec2f(-MAX_SPEED), vec2f(MAX_SPEED));
  let sx = stepOf(r.x);
  let sy = stepOf(r.y);

  var at = i;
  var didMove = false;
  if (sx != 0 && sy != 0) {
    let j = slotAt(col + sx, row + sy);
    if (j >= 0 && canDisplace(c, blk[u32(j)])) {
      swapSlots(i, u32(j)); at = u32(j); didMove = true;
      r -= vec2f(f32(sx), f32(sy));
    }
  }
  if (!didMove && sy != 0) {
    let j = slotAt(col, row + sy);
    if (j >= 0) {
      if (canDisplace(c, blk[u32(j)])) {
        swapSlots(i, u32(j)); at = u32(j); didMove = true;
        r.y -= f32(sy);
      } else {
        v.y = bumped(v.y, u32(j), 1u);
        r.y = 0.0;
      }
    }
  }
  if (!didMove && sx != 0) {
    let j = slotAt(col + sx, row);
    if (j >= 0) {
      if (canDisplace(c, blk[u32(j)])) {
        swapSlots(i, u32(j)); at = u32(j); didMove = true;
        r.x -= f32(sx);
      } else {
        v.x = bumped(v.x, u32(j), 0u);
        r.x = 0.0;
      }
    }
  }

  // Resting on something: stop falling, lose sideways speed, and slide to the opposite bottom corner when it is free.
  if ((at >> 1u) == 1u && !canDisplace(c, blk[at - 2u])) {
    if (v.y < 0.0) { v.y = bumped(v.y, at - 2u, 1u); }
    r.y = max(r.y, 0.0);
    v.x *= 1.0 - FRICTION;
    if (abs(v.x) < REST_SPEED) {
      v.x = 0.0;
      r.x = 0.0;
    }
    let corner = 1u - (at & 1u);
    if (!didMove && canDisplace(c, blk[corner])) {
      swapSlots(at, corner); at = corner;
      v.y = 0.0;
      r.y = 0.0;
    }
  }
  // A cell whose target lies outside the block waits a dispatch; this bounds what it banks meanwhile.
  r = clamp(r, vec2f(-2.0), vec2f(2.0));
  blk[at] = withMotion(blk[at], v, r);
}

// -- Liquids --

// A liquid cell remembers the sideways direction it last moved in, in its life field (0: none yet), so a stream
// keeps flowing instead of diffusing: a screen-wide pool levels in a few hundred dispatches, not tens of thousands.
const DIR_LEFT: u32 = 1u;
const DIR_RIGHT: u32 = 2u;
// A liquid that could move sideways turns around instead one time in this many (a mean free path of 64 cells).
const TURN_ONE_IN: u32 = 64u;

// A liquid that is not falling spreads sideways.
fn spreads(slot: u32) -> bool {
  return isLiquid(blk[slot]) && !moved[slot] && cellVelocity(blk[slot]).y == 0.0;
}

// A liquid cell that did not move this dispatch spreads along one row of the block, slot l left of slot r. It tries the
// direction it remembers (a fresh random pick when it has none); the other cell's side is outside the block, so
// that cell gets its turn when the offset alternates. Facing anything but empty space, and one time in TURN_ONE_IN
// facing it, it turns around instead. Side by side, two liquids never swap, so a layered body stays layered.
fn spreadRow(l: u32, r: u32, rnd: u32) {
  let turn = (rnd & (TURN_ONE_IN - 1u)) == 0u;
  if (spreads(l)) {
    var dir = cellLife(blk[l]);
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_RIGHT) {
      if (turn || !isEmpty(blk[r])) { blk[l] = withLife(blk[l], DIR_LEFT); }
      else if (isEmpty(blk[r])) {
        blk[l] = withLife(blk[l], DIR_RIGHT);
        swapSlots(l, r);
        return;
      }
    }
  }
  if (spreads(r)) {
    var dir = cellLife(blk[r]);
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_LEFT) {
      if (turn || !isEmpty(blk[l])) { blk[r] = withLife(blk[r], DIR_RIGHT); }
      else if (isEmpty(blk[l])) {
        blk[r] = withLife(blk[r], DIR_LEFT);
        swapSlots(l, r);
      }
    }
  }
}

// An element with a lifetime counts down by its decay and becomes its successor when it runs out.
fn ageCell(c: Cell) -> Cell {
  let t = cellType(c);
  let decay = elLifeDecay(t);
  if (decay == 0u) { return c; }
  let life = cellLife(c);
  if (life <= decay) {
    let next = elBecomes(t);
    return retype(c, next, cellVariant(c), elLifeStart(next));
  }
  return withLife(c, life - decay);
}

@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
) {
  let inGrid = gid.x < (W + u.offset + 1u) / 2u && gid.y < (H + u.offset + 1u) / 2u;
  let ox = i32(gid.x) * 2 - i32(u.offset);
  let oy = i32(gid.y) * 2 - i32(u.offset);

  if (inGrid) {
    for (var j = 0u; j < 4u; j++) {
      blk[j] = readCell(ox + i32(j & 1u), oy + i32(j >> 1u));
      orig[j] = blk[j];
      moved[j] = false;
    }

    var rnd = hash2(gid.x, gid.y, u.seed);

    // Phase 0: Gases rise
    if (isGas(blk[0]) && canRiseThrough(blk[0], blk[2])) { swapSlots(0u, 2u); }
    if (isGas(blk[1]) && canRiseThrough(blk[1], blk[3])) { swapSlots(1u, 3u); }

    // Phase 1: Powders and liquids move by velocity, a heavier one through a lighter one. The bottom row goes first, so
    // a cell moving up finds the cell it leaves free; the column order is random.
    let first = select(0u, 1u, pickRight(pcg(rnd ^ 0x85ebca6bu)));
    velocityRule(first);
    velocityRule(1u - first);
    velocityRule(2u + first);
    velocityRule(3u - first);

    // Phase 2: Gas horizontal dispersion, top row
    if (pickRight(rnd)) {
      if (isGas(blk[2]) && isEmpty(blk[3]) && !moved[2]) { swapSlots(2u, 3u); }
    } else {
      if (isGas(blk[3]) && isEmpty(blk[2]) && !moved[3]) { swapSlots(3u, 2u); }
    }

    // Bottom row: gases disperse sideways when they cannot rise
    rnd = pcg(rnd);
    if (pickRight(rnd)) {
      if (isGas(blk[0]) && isEmpty(blk[1]) && !canRiseThrough(blk[0], blk[2]) && !moved[0]) { swapSlots(0u, 1u); }
    } else {
      if (isGas(blk[1]) && isEmpty(blk[0]) && !canRiseThrough(blk[1], blk[3]) && !moved[1]) { swapSlots(1u, 0u); }
    }

    // Phase 3: Liquids spread sideways
    rnd = pcg(rnd);
    spreadRow(2u, 3u, rnd);
    rnd = pcg(rnd);
    spreadRow(0u, 1u, rnd);

    // Phase 4: Lifetimes
    for (var j = 0u; j < 4u; j++) { blk[j] = ageCell(blk[j]); }
${burns ? ignitionDecisions : ''}

    // Phase 5: Element rules
${ruleSection}
${burns ? `
    // Phase 6: Ignition
${ignitionApplied}` : ''}

    for (var j = 0u; j < 4u; j++) {
      writeCell(ox + i32(j & 1u), oy + i32(j >> 1u), blk[j], orig[j]);
    }
  }

  // Offset 1 ends the superstep's CA: count this workgroup's launching cells for the launch pass.
  if (u.offset == 1u) {
    if (inGrid) {
      var n = 0u;
      for (var j = 0u; j < 4u; j++) {
        if (blk[j].velocity != 0u && inBounds(ox + i32(j & 1u), oy + i32(j >> 1u)) && length(cellVelocity(blk[j])) > LAUNCH_SPEED) { n++; }
      }
      if (n > 0u) { atomicAdd(&wgLaunches, n); }
    }
    workgroupBarrier();
    if (li == 0u) {
      let n = atomicLoad(&wgLaunches);
      atomicStore(&launchCounts[wid.y * ${groups.x}u + wid.x], n);
      if (n > 0u) { atomicAdd(&launchCounts[${groups.x * groups.y}u], n); }
    }
  }
}
`;
};
