import { AIR, type AirShape } from '../air';
import type { ElementDef } from '../elements';
import { launchGroups, movementWGSL, wgslFloat } from '../movement';
import { NO_PRESSURE } from '../element-table';
import { airReadWGSL } from './air.wgsl';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';
import { heatWGSL } from './heat.wgsl';

// The cells of a block are slots 0 to 3: bottom left, bottom right, top left, top right (slot = column + 2 * row).
const SLOTS = [0, 1, 2, 3] as const;

// Margolus CA for every element, driven by the element table. One thread per 2x2 block reads the four cells, runs all
// rules on them and writes back the fields that changed, in place: a rule reads and writes only the cells of its own
// block, so no two threads touch the same cell. Out-of-bounds reads are walls and out-of-bounds writes are skipped, so
// blocks that stick out of the grid (offset 1, odd sizes) behave like blocks at a wall.
//
// The phases: gases rise, falling cells move by velocity, gases and liquids spread sideways, lifetimes, then the optional
// rules. Ignition is decided between the lifetimes and the rules but applied after them, so a rule never sees a cell
// that ignites in the same dispatch. Then the four cells of the block exchange heat pairwise, and last a cell whose
// stored temperature has passed a threshold (and its latent heat) becomes the element beyond it. A cell faster than
// LAUNCH_SPEED waits where it is for the flyer passes, which run after the offset-1 dispatch; that dispatch also counts
// the launching cells of each workgroup (group 3).
// With `air` (the shape of the air grid) the CA also reads the air state (group 3, binding 1) once per block, at the
// block's center: powders and liquids lose `drag` of their speed relative to the air and are pushed by its pressure
// gradient, and gases and fire drift with the air after the sideways dispersion. A cell that passes an `above` threshold
// with a burst, or ignites into FIRE (phase 6) from an element whose `above` is FIRE, adds the burst to its air cell's
// entry of the burst buffer (group 3, binding 2) by an integer atomic add. Phase 8 also turns a cell into its
// `pressureAbove` target when the pressure of its air cell is above the limit. Without air none of that code exists.
// `rules` maps a rule name (`ElementDef.rule`) to its WGSL.
export const caWGSL = (
  width: number,
  height: number,
  elements: readonly ElementDef[],
  rules: Readonly<Record<string, string>>,
  maxFlyers: number,
  air?: AirShape,
): string => {
  const ruled = elements.filter((e) => e.rule !== undefined);
  for (const e of ruled) if (!(e.rule! in rules)) throw new Error(`element ${e.key}: unknown rule "${e.rule}"`);
  const ruleNames = [...new Set(ruled.map((e) => e.rule!))];
  const burns = elements.some((e) => e.flammable);
  // A pressure transition needs the air to read; without it the element never changes.
  const pressures = air !== undefined && elements.some((e) => e.pressureAbove !== undefined);
  const transitions = pressures || elements.some((e) => e.below !== undefined || e.above !== undefined);
  const groups = launchGroups(width, height);

  // For each cell of the block, whether it ignites: flammable, with a fire cell in the block (after the lifetimes).
  const ignitionDecisions = SLOTS.map((n) => {
    const others = SLOTS.filter((o) => o !== n).map((o) => `cellType(blk${o}) == EL_FIRE`).join(' || ');
    return `  let ignite_${n} = elFlammable(cellType(blk${n})) && (${others});`;
  }).join('\n');
  const ignitionApplied = SLOTS.map((n) =>
    `  if (ignite_${n} && elFlammable(cellType(blk${n}))) { ${air ? `igniteBurst(cellType(blk${n}), ox + ${n & 1}, oy + ${n >> 1}); ` : ''}blk${n} = retype(blk${n}, EL_FIRE, cellVariant(blk${n}), elLifeStart(EL_FIRE)); }`,
  ).join('\n');

  // Phase 7: the four pairs of a block, rows then columns at offset 0 and columns then rows at offset 1, so neither axis
  // always goes first. Written out per slot pair, never through a runtime slot index.
  const exchange = ([a, b]: readonly [number, number]): string =>
    `{ let t = exchangeHeat(blk${a}, blk${b}); blk${a}.temp = t.x; blk${b}.temp = t.y; }`;
  const rowPairs = [[0, 1], [2, 3]] as const;
  const columnPairs = [[0, 2], [1, 3]] as const;
  const exchanges = (pairs: readonly (readonly [number, number])[]): string => pairs.map((p) => `      ${exchange(p)}`).join('\n');
  const conduction = `    if (u.offset == 0u) {
${exchanges([...rowPairs, ...columnPairs])}
    } else {
${exchanges([...columnPairs, ...rowPairs])}
    }`;

  // A generated switch on the cell's element: only cells of an element with a rule call it.
  const ruleSwitches = SLOTS.map((i) => `  switch (cellType(block[${i}])) {
${ruled.map((e) => `    case EL_${e.key}: { rule_${e.rule}(${i}u, &block); }`).join('\n')}
    default: {}
  }`).join('\n');
  // The block lives in one private variable per slot, not in an array: indexed by a runtime slot, an array is kept
  // in per-thread memory instead of registers, which made the CA three times slower on the RTX 4080. The generated
  // `blkAt(k)` and `setBlk(k, c)` pick the variable by slot.
  const slotCase = (n: number): string => (n === 3 ? 'default' : `case ${n}u`);
  const slotVariables = (name: string, type: string, get: string, set: string): string => `${SLOTS.map((n) => `var<private> ${name}${n}: ${type};`).join('\n')}
fn ${get}(k: u32) -> ${type} {
  switch (k) {
${SLOTS.map((n) => `    ${slotCase(n)}: { return ${name}${n}; }`).join('\n')}
  }
}
fn ${set}(k: u32, v: ${type}) {
  switch (k) {
${SLOTS.map((n) => `    ${slotCase(n)}: { ${name}${n} = v; }`).join('\n')}
  }
}`;
  const loadBlock = SLOTS.map((n) => `    blk${n} = readCell(ox + ${n & 1}, oy + ${n >> 1});
    orig${n} = blk${n};
    moved${n} = false;`).join('\n');
  const storeBlock = SLOTS.map((n) => `    writeCell(ox + ${n & 1}, oy + ${n >> 1}, blk${n}, orig${n});`).join('\n');

  const ruleSection = ruled.length === 0 ? '' : `
  var block = array<Cell, 4>(blk0, blk1, blk2, blk3);
${ruleSwitches}
  blk0 = block[0]; blk1 = block[1]; blk2 = block[2]; blk3 = block[3];`;

  return /* wgsl */`
${cellWGSL('read_write', elements)}
${elementsWGSL}
${heatWGSL}
${movementWGSL(maxFlyers)}
${ruleNames.map((n) => rules[n]).join('\n')}

struct StepUniforms {
  offset: u32,
  seed: u32,
};

@group(0) @binding(0) var<uniform> u: StepUniforms;
// One launch count per workgroup of the offset-1 dispatch, then their total (the flyer passes keep the prefix after it).
@group(3) @binding(0) var<storage, read_write> launchCounts: array<atomic<u32>>;
var<workgroup> wgLaunches: atomic<u32>;
${air ? `
${airReadWGSL(air)}
// The air at the center of the block being processed (zero when the block holds nothing that moves).
var<private> around: AirAround;

const AIR_SI: i32 = ${air.cellSize};
const BURST_SCALE: f32 = ${wgslFloat(AIR.burstScale)};
// What a burst is multiplied by in an air cell of this size (\`AIR.burstCellSize\`).
const BURST_GAIN: f32 = ${wgslFloat((AIR.burstCellSize / air.cellSize) ** 2)};
// Pressure released by the CA, per array position of the air state; the air's pressure pass moves it into the pressure.
@group(3) @binding(2) var<storage, read_write> airBurst: array<atomic<i32>>;
` : ''}
const W: u32 = ${width}u;
const H: u32 = ${height}u;

// The block being processed (\`blk0\` to \`blk3\`) and the cells as they were loaded (\`orig0\` to \`orig3\`, read by
// slot number only). \`movedAt(k)\` is true when slot k holds another cell than it started the dispatch with, so a
// cell that just arrived does not also move sideways in the same step.
${slotVariables('blk', 'Cell', 'blkAt', 'setBlk')}
${slotVariables('moved', 'bool', 'movedAt', 'setMoved')}
${SLOTS.map((n) => `var<private> orig${n}: Cell;`).join('\n')}

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

// Whether the cell at (x, y) is of an inert element (empty or solid, no lifetime, no rule, no heat); out of bounds is a wall.
fn inertAt(x: i32, y: i32) -> bool {
  return !inBounds(x, y) || elInert(loadKind(u32(y) * W + u32(x)) & 0xffu);
}

fn writeCell(x: i32, y: i32, c: Cell, before: Cell) {
  if (inBounds(x, y)) { storeChanged(u32(y) * W + u32(x), c, before); }
}

// Both cells keep all their fields.
fn swapSlots(a: u32, b: u32) {
  let tmp = blkAt(a); setBlk(a, blkAt(b)); setBlk(b, tmp);
  setMoved(a, true);
  setMoved(b, true);
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
  let ov = cellVelocity(blkAt(j))[axis];
  if (v < 0.0) { return min(0.0, max(v, ov)); }
  return max(0.0, min(v, ov));
}

// A powder or liquid cell: integrate its velocity, move it one cell inside the block once the remainder reaches 1 on an
// axis (swapping with a lighter cell in the way), stop an axis that is blocked, lose sideways speed and slide
// diagonally when it rests on something.
fn velocityRule(i: u32) {
  if (movedAt(i) || !isFalling(blkAt(i))) { return; }
  let c = blkAt(i);
  var v = cellVelocity(c);
  var r = cellRemainder(c);
  // Waiting for the launch pass: frozen, an obstacle for the others.
  if (length(v) > LAUNCH_SPEED) { return; }

  let col = i32(i & 1u);
  let row = i32(i >> 1u);
  // A cell at rest starts falling only once a top-row dispatch has seen the cell below it free. Otherwise every level
  // of a resting stack banks one more gravity step than the one under it, and the top of a deep layer launches.
  if (row == 1 || v.y != 0.0) { v.y -= elGravity(cellType(c)); }
${air ? `  // The air: the cell loses \`drag\` of its speed relative to it, and its pressure gradient pushes it, lighter matter harder.
  v += elDrag(cellType(c)) * (around.velocity - v);
  v -= AIR_PUSH * around.gradient / cellDensity(c);
` : ''}  if (length(v) > MAX_FLYER_SPEED) { v *= MAX_FLYER_SPEED / length(v); }
  r += clamp(v, vec2f(-MAX_SPEED), vec2f(MAX_SPEED));
  let sx = stepOf(r.x);
  let sy = stepOf(r.y);

  var at = i;
  var didMove = false;
  if (sx != 0 && sy != 0) {
    let j = slotAt(col + sx, row + sy);
    if (j >= 0 && canDisplace(c, blkAt(u32(j)))) {
      swapSlots(i, u32(j)); at = u32(j); didMove = true;
      r -= vec2f(f32(sx), f32(sy));
    }
  }
  if (!didMove && sy != 0) {
    let j = slotAt(col, row + sy);
    if (j >= 0) {
      if (canDisplace(c, blkAt(u32(j)))) {
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
      if (canDisplace(c, blkAt(u32(j)))) {
        swapSlots(i, u32(j)); at = u32(j); didMove = true;
        r.x -= f32(sx);
      } else {
        v.x = bumped(v.x, u32(j), 0u);
        r.x = 0.0;
      }
    }
  }

  // Resting on something: stop falling, lose sideways speed, and slide to the opposite bottom corner when it is free.
  if ((at >> 1u) == 1u && !canDisplace(c, blkAt(at - 2u))) {
    if (v.y < 0.0) { v.y = bumped(v.y, at - 2u, 1u); }
    r.y = max(r.y, 0.0);
    v.x *= 1.0 - FRICTION;
    if (abs(v.x) < REST_SPEED) {
      v.x = 0.0;
      r.x = 0.0;
    }
    let corner = 1u - (at & 1u);
    if (!didMove && canDisplace(c, blkAt(corner))) {
      swapSlots(at, corner); at = corner;
      v.y = 0.0;
      r.y = 0.0;
    }
  }
  // A cell whose target lies outside the block waits a dispatch; this bounds what it banks meanwhile.
  r = clamp(r, vec2f(-2.0), vec2f(2.0));
  setBlk(at, withMotion(blkAt(at), v, r));
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
  return isLiquid(blkAt(slot)) && !movedAt(slot) && cellVelocity(blkAt(slot)).y == 0.0;
}

// A liquid cell that did not move this dispatch spreads along one row of the block, slot l left of slot r. It tries the
// direction it remembers (a fresh random pick when it has none); the other cell's side is outside the block, so
// that cell gets its turn when the offset alternates. Facing anything but empty space, and one time in TURN_ONE_IN
// facing it, it turns around instead. Side by side, two liquids never swap, so a layered body stays layered.
fn spreadRow(l: u32, r: u32, rnd: u32) {
  let turn = (rnd & (TURN_ONE_IN - 1u)) == 0u;
  if (spreads(l)) {
    var dir = cellLife(blkAt(l));
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_RIGHT) {
      if (turn || !isEmpty(blkAt(r))) { setBlk(l, withLife(blkAt(l), DIR_LEFT)); }
      else if (isEmpty(blkAt(r))) {
        setBlk(l, withLife(blkAt(l), DIR_RIGHT));
        swapSlots(l, r);
        return;
      }
    }
  }
  if (spreads(r)) {
    var dir = cellLife(blkAt(r));
    if (dir == 0u) { dir = select(DIR_LEFT, DIR_RIGHT, pickRight(rnd)); }
    if (dir == DIR_LEFT) {
      if (turn || !isEmpty(blkAt(l))) { setBlk(r, withLife(blkAt(r), DIR_RIGHT)); }
      else if (isEmpty(blkAt(l))) {
        setBlk(r, withLife(blkAt(r), DIR_LEFT));
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

${air ? `// Adds pressure to the air cell over the grid cell (x, y): \`amount\` for an air cell of \`AIR.burstCellSize\`, scaled to this
// one's area. The amount is rounded to a whole number of 1 / BURST_SCALE: integer additions commute, so the sum does not
// depend on the order the threads add in.
fn releaseBurst(x: i32, y: i32, amount: f32) {
  let fixed = i32(amount * BURST_GAIN * BURST_SCALE + 0.5);
  if (fixed != 0) { atomicAdd(&airBurst[airIndex(x / AIR_SI + 1, y / AIR_SI + 1)], fixed); }
}

// A cell of an element whose \`above\` is FIRE that ignites by touching fire releases that transition's burst.
fn igniteBurst(t: u32, x: i32, y: i32) {
  if (elAboveBecomes(t) == EL_FIRE) { releaseBurst(x, y, elAboveBurst(t)); }
}

` : ''}${pressures ? `// What an element without a pressure transition packs as its limit (\`NO_PRESSURE\`).
const NO_PRESSURE: f32 = ${wgslFloat(Math.fround(NO_PRESSURE))};

// The pressure against the cell in slot i, at grid cell (x, y): the highest of the air cell over it and the air cells over
// its two neighbors inside the block (across its column and across its row) that are open to the air, not solid. A solid
// closes its air cell's faces, so the air cell a cell inside a wall sits in may be closed off from a blast beside it; the
// open cell beside it carries the blast. A solid neighbor (a wall) is skipped: the air cell over it may be open on the
// wall's far side. \`solid\` has bit k set when slot k held a solid as phase 8 began, so a neighbor crushed in this
// dispatch does not open the way yet. The other two neighbors are inside the block on the other Margolus offset, the
// next dispatch.
fn pressureAgainst(i: u32, solid: u32, x: i32, y: i32) -> f32 {
  var p = pressureAt(x / AIR_SI + 1, y / AIR_SI + 1);
  if (((solid >> (i ^ 1u)) & 1u) == 0u) {
    p = max(p, pressureAt((x + select(1, -1, (i & 1u) == 1u)) / AIR_SI + 1, y / AIR_SI + 1));
  }
  if (((solid >> (i ^ 2u)) & 1u) == 0u) {
    p = max(p, pressureAt(x / AIR_SI + 1, (y + select(1, -1, (i >> 1u) == 1u)) / AIR_SI + 1));
  }
  return p;
}

` : ''}// Phase 8 for one cell: once its stored temperature has run past a threshold by the whole latent width, the cell becomes
// the element beyond it. It starts there at the threshold plus the overshoot scaled by the two heat capacities, so the
// heat it holds is the heat it had; it starts with the new element's life. A large overshoot can carry it through the
// next change in the same direction on the next dispatch. Cells that hold no heat have thresholds out of reach.
fn transitionCell(c: Cell, i: u32, solid: u32, x: i32, y: i32) -> Cell {
  let t = cellType(c);
  let s = cellStoredTemp(c);
  let upper = elAboveTemp(t) + elAboveWidth(t);
  let lower = elBelowTemp(t) - elBelowWidth(t);
  if (s > upper) {
    let next = elAboveBecomes(t);
${air ? '    releaseBurst(x, y, elAboveBurst(t));\n' : ''}    let start = elAboveTemp(t) + (s - upper) * elHeatCapacity(t) / elHeatCapacity(next);
    return retype(withTemp(c, start), next, cellVariant(c), elLifeStart(next));
  }
  if (s < lower) {
    let next = elBelowBecomes(t);
    let start = elBelowTemp(t) - (lower - s) * elHeatCapacity(t) / elHeatCapacity(next);
    return retype(withTemp(c, start), next, cellVariant(c), elLifeStart(next));
  }
${pressures ? `  // Then the pressure against the cell: past the element's limit it becomes its pressure target, keeping its heat (not
  // its temperature: the two elements hold different heat per degree, so the new cell starts at the temperature that
  // holds the same heat, as above). No cell outside the block is read, only the air, which does not change during a
  // dispatch. Elements without one skip the air reads.
  if (elPressureAbove(t) < NO_PRESSURE && pressureAgainst(i, solid, x, y) > elPressureAbove(t)) {
    let next = elPressureBecomes(t);
    let start = s * elHeatCapacity(t) / elHeatCapacity(next);
    return retype(withTemp(c, start), next, cellVariant(c), elLifeStart(next));
  }
` : ''}  return c;
}

${air ? `// -- Air drift --

// Whether a random word falls below a probability.
fn chance(r: u32, p: f32) -> bool { return f32(r >> 8u) * (1.0 / 16777216.0) < p; }

// A gas or fire cell drifts one cell along each axis of the air's velocity, each axis with probability twice the speed
// along it (certain from half a cell per dispatch), when the cell it drifts to is inside the block and empty. It keeps
// no state: a gas that moves one way is as likely to move the other. In air at rest nothing moves. A cell that has
// moved this dispatch (a gas that rose, which is every dispatch for a gas in open air) still drifts sideways, along its
// row, but not vertically, which would undo its move. Tries the diagonal first, then the vertical, then the horizontal move.
fn driftCell(i: u32, r: u32) {
  let s = cellState(blkAt(i));
  if (s != ST_GAS && s != ST_PLASMA) { return; }
  let free = !movedAt(i);
  let w = around.velocity;
  var dx = 0;
  var dy = 0;
  if (chance(r, 2.0 * abs(w.x))) { dx = select(-1, 1, w.x > 0.0); }
  if (free && chance(pcg(r), 2.0 * abs(w.y))) { dy = select(-1, 1, w.y > 0.0); }
  let col = i32(i & 1u);
  let row = i32(i >> 1u);
  if (dx != 0 && dy != 0) {
    let j = slotAt(col + dx, row + dy);
    if (j >= 0 && isEmpty(blkAt(u32(j)))) { swapSlots(i, u32(j)); return; }
  }
  if (dy != 0) {
    let j = slotAt(col, row + dy);
    if (j >= 0 && isEmpty(blkAt(u32(j)))) { swapSlots(i, u32(j)); return; }
  }
  if (dx != 0) {
    let j = slotAt(col + dx, row);
    if (j >= 0 && isEmpty(blkAt(u32(j)))) { swapSlots(i, u32(j)); }
  }
}

fn movesWithAir(c: Cell) -> bool {
  let s = cellState(c);
  return s == ST_POWDER || s == ST_LIQUID || s == ST_GAS || s == ST_PLASMA;
}
` : ''}
@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
) {
  let inGrid = gid.x < (W + u.offset + 1u) / 2u && gid.y < (H + u.offset + 1u) / 2u;
  let ox = i32(gid.x) * 2 - i32(u.offset);
  let oy = i32(gid.y) * 2 - i32(u.offset);
  // A block of inert cells only is a fixed point of every phase: skipped without loading its other fields. Most of a
  // screen is empty space or walls.
  let awake = inGrid && !(inertAt(ox, oy) && inertAt(ox + 1, oy) && inertAt(ox, oy + 1) && inertAt(ox + 1, oy + 1));

  if (awake) {
${loadBlock}

    var rnd = hash2(gid.x, gid.y, u.seed);
${air ? `    around = AirAround(vec2f(0.0), vec2f(0.0));
    if (movesWithAir(blk0) || movesWithAir(blk1) || movesWithAir(blk2) || movesWithAir(blk3)) {
      around = airAround(f32(ox) + 1.0, f32(oy) + 1.0);
    }
` : ''}
    // Phase 0: Gases rise
    if (isGas(blk0) && canRiseThrough(blk0, blk2)) { swapSlots(0u, 2u); }
    if (isGas(blk1) && canRiseThrough(blk1, blk3)) { swapSlots(1u, 3u); }

    // Phase 1: Powders and liquids move by velocity, a heavier one through a lighter one. The bottom row goes first, so
    // a cell moving up finds the cell it leaves free; the column order is random.
    let first = select(0u, 1u, pickRight(pcg(rnd ^ 0x85ebca6bu)));
    velocityRule(first);
    velocityRule(1u - first);
    velocityRule(2u + first);
    velocityRule(3u - first);

    // Phase 2: Gas horizontal dispersion, top row
    if (pickRight(rnd)) {
      if (isGas(blk2) && isEmpty(blk3) && !moved2) { swapSlots(2u, 3u); }
    } else {
      if (isGas(blk3) && isEmpty(blk2) && !moved3) { swapSlots(3u, 2u); }
    }

    // Bottom row: gases disperse sideways when they cannot rise
    rnd = pcg(rnd);
    if (pickRight(rnd)) {
      if (isGas(blk0) && isEmpty(blk1) && !canRiseThrough(blk0, blk2) && !moved0) { swapSlots(0u, 1u); }
    } else {
      if (isGas(blk1) && isEmpty(blk0) && !canRiseThrough(blk1, blk3) && !moved1) { swapSlots(1u, 0u); }
    }

${air ? `    // Gases and fire drift with the air; the slot to start at is random, so no corner is served first. The words come from
    // \`rnd\` without advancing it.
    let driftOrder = pcg(rnd ^ 0x3c6ef372u);
    let driftStart = driftOrder & 3u;
    driftCell(driftStart, pcg(driftOrder ^ 0x1u));
    driftCell((driftStart + 1u) & 3u, pcg(driftOrder ^ 0x2u));
    driftCell((driftStart + 2u) & 3u, pcg(driftOrder ^ 0x3u));
    driftCell((driftStart + 3u) & 3u, pcg(driftOrder ^ 0x4u));

` : ''}    // Phase 3: Liquids spread sideways
    rnd = pcg(rnd);
    spreadRow(2u, 3u, rnd);
    rnd = pcg(rnd);
    spreadRow(0u, 1u, rnd);

    // Phase 4: Lifetimes
${SLOTS.map((n) => `    blk${n} = ageCell(blk${n});`).join('\n')}
${burns ? ignitionDecisions : ''}

    // Phase 5: Element rules
${ruleSection}
${burns ? `
    // Phase 6: Ignition
${ignitionApplied}` : ''}

    // Phase 7: Heat conduction
${conduction}
${transitions ? `
    // Phase 8: Phase changes. \`solid\`: the slots that hold a solid as it begins (bit k for slot k).
    let solid = ${SLOTS.map((n) => `select(0u, ${1 << n}u, cellState(blk${n}) == ST_SOLID)`).join(' | ')};
${SLOTS.map((n) => `    blk${n} = transitionCell(blk${n}, ${n}u, solid, ox + ${n & 1}, oy + ${n >> 1});`).join('\n')}` : ''}

${storeBlock}
  }

  // Offset 1 ends the superstep's CA: count this workgroup's launching cells for the launch pass.
  if (u.offset == 1u) {
    if (awake) {
      var n = 0u;
${SLOTS.map((k) => `      if (blk${k}.velocity != 0u && inBounds(ox + ${k & 1}, oy + ${k >> 1}) && length(cellVelocity(blk${k})) > LAUNCH_SPEED) { n++; }`).join('\n')}
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
