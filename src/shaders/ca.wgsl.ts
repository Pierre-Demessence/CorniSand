import type { ElementDef } from '../elements';
import { cellWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// The cells of a block in the order the rules see them: bottom left, bottom right, top left, top right.
const BLOCK = ['bl', 'br', 'tl', 'tr'] as const;

// Margolus CA for every element, driven by the element table. One thread per 2x2 block reads the four cells, runs all
// rules on them and writes back the fields that changed, in place: a rule reads and writes only the cells of its own
// block, so no two threads touch the same cell. Out-of-bounds reads are walls and out-of-bounds writes are skipped, so
// blocks that stick out of the grid (offset 1, odd sizes) behave like blocks at a wall.
//
// The phases: movement by state and density, lifetimes, then the optional rules. Ignition is decided between the
// lifetimes and the rules but applied after them, so a rule never sees a cell that ignites in the same dispatch.
// `rules` maps a rule name (`ElementDef.rule`) to its WGSL.
export const caWGSL = (
  width: number,
  height: number,
  elements: readonly ElementDef[],
  rules: Readonly<Record<string, string>>,
): string => {
  const ruled = elements.filter((e) => e.rule !== undefined);
  for (const e of ruled) if (!(e.rule! in rules)) throw new Error(`element ${e.key}: unknown rule "${e.rule}"`);
  const ruleNames = [...new Set(ruled.map((e) => e.rule!))];
  const burns = elements.some((e) => e.flammable);

  // For each cell of the block, whether it ignites: flammable, with a fire cell in the block (after the lifetimes).
  const ignitionDecisions = BLOCK.map((n) => {
    const others = BLOCK.filter((o) => o !== n).map((o) => `cellType(${o}) == EL_FIRE`).join(' || ');
    return `  let ignite_${n} = elFlammable(cellType(${n})) && (${others});`;
  }).join('\n');
  const ignitionApplied = BLOCK.map((n) =>
    `  if (ignite_${n} && elFlammable(cellType(${n}))) { ${n} = makeCell(EL_FIRE, cellVariant(${n}), elLifeStart(EL_FIRE)); }`,
  ).join('\n');

  // A generated switch on the cell's element: only cells of an element with a rule call it.
  const ruleSwitches = BLOCK.map((_, i) => `  switch (cellType(block[${i}])) {
${ruled.map((e) => `    case EL_${e.key}: { rule_${e.rule}(${i}u, &block); }`).join('\n')}
    default: {}
  }`).join('\n');
  const ruleSection = ruled.length === 0 ? '' : `
  var block = array<Cell, 4>(bl, br, tl, tr);
${ruleSwitches}
  bl = block[0]; br = block[1]; tl = block[2]; tr = block[3];`;

  return /* wgsl */`
${cellWGSL('read_write', elements)}
${elementsWGSL}
${ruleNames.map((n) => rules[n]).join('\n')}

struct StepUniforms {
  offset: u32,
  seed: u32,
};

@group(0) @binding(0) var<uniform> u: StepUniforms;

const W: u32 = ${width}u;
const H: u32 = ${height}u;

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

fn swapCells(a: ptr<function, Cell>, b: ptr<function, Cell>) {
  let tmp = *a; *a = *b; *b = tmp;
}

// One bit of a random word, used to pick a direction.
fn pickRight(r: u32) -> bool { return (r >> 31u) == 1u; }

// A liquid cell remembers the sideways direction it last moved in, in its life field (0: none yet), so a stream
// keeps flowing instead of diffusing: a screen-wide pool levels in a few hundred dispatches, not tens of thousands.
const DIR_LEFT: u32 = 1u;
const DIR_RIGHT: u32 = 2u;
// A liquid that could move sideways turns around instead one time in this many (a mean free path of 64 cells).
const TURN_ONE_IN: u32 = 64u;

fn withDir(c: Cell, dir: u32) -> Cell { return makeCell(cellType(c), cellVariant(c), dir); }

// A liquid cell that did not move this dispatch spreads along one row of the block, l left of r. It tries the
// direction it remembers (a fresh random pick when it has none); the other cell's side is outside the block, so
// that cell gets its turn when the offset alternates. Facing anything but empty space, and one time in TURN_ONE_IN
// facing it, it turns around instead. Side by side, two liquids never swap, so a layered body stays layered.
fn spreadRow(l: ptr<function, Cell>, r: ptr<function, Cell>, l0: Cell, r0: Cell, rnd: u32) {
  let turn = (rnd & (TURN_ONE_IN - 1u)) == 0u;
  if (isLiquid(*l) && cellEq(*l, l0)) {
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
  if (isLiquid(*r) && cellEq(*r, r0)) {
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

// An element with a lifetime counts down by its decay and becomes its successor when it runs out.
fn ageCell(c: Cell) -> Cell {
  let t = cellType(c);
  let decay = elLifeDecay(t);
  if (decay == 0u) { return c; }
  let life = cellLife(c);
  if (life <= decay) {
    let next = elBecomes(t);
    return makeCell(next, cellVariant(c), elLifeStart(next));
  }
  return makeCell(t, cellVariant(c), life - decay);
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

  // Phase 0: Gases rise
  if (isGas(bl) && canRiseThrough(bl, tl)) { swapCells(&bl, &tl); }
  if (isGas(br) && canRiseThrough(br, tr)) { swapCells(&br, &tr); }

  // Phase 1: Powders and liquids fall, a heavier one through a lighter one
  if (isFalling(tl) && canDisplace(tl, bl)) { swapCells(&tl, &bl); }
  if (isFalling(tr) && canDisplace(tr, br)) { swapCells(&tr, &br); }

  // Phase 2: Blocked from below, powders and liquids slide diagonally into the bottom corner opposite their column.
  if (isFalling(tl) && !canDisplace(tl, bl) && canDisplace(tl, br)) { swapCells(&tl, &br); }
  if (isFalling(tr) && !canDisplace(tr, br) && canDisplace(tr, bl)) { swapCells(&tr, &bl); }

  // Phase 3: Gas horizontal dispersion, top row
  if (pickRight(rnd)) {
    if (isGas(tl) && isEmpty(tr) && cellEq(tl, tl0)) { swapCells(&tl, &tr); }
  } else {
    if (isGas(tr) && isEmpty(tl) && cellEq(tr, tr0)) { swapCells(&tr, &tl); }
  }

  // Bottom row: gases disperse sideways when they cannot rise
  rnd = pcg(rnd);
  if (pickRight(rnd)) {
    if (isGas(bl) && isEmpty(br) && !canRiseThrough(bl, tl) && cellEq(bl, bl0)) { swapCells(&bl, &br); }
  } else {
    if (isGas(br) && isEmpty(bl) && !canRiseThrough(br, tr) && cellEq(br, br0)) { swapCells(&br, &bl); }
  }

  // Phase 4: Liquids spread sideways
  rnd = pcg(rnd);
  spreadRow(&tl, &tr, tl0, tr0, rnd);
  rnd = pcg(rnd);
  spreadRow(&bl, &br, bl0, br0, rnd);

  // Phase 5: Lifetimes
  bl = ageCell(bl);
  br = ageCell(br);
  tl = ageCell(tl);
  tr = ageCell(tr);
${burns ? ignitionDecisions : ''}

  // Phase 6: Element rules
${ruleSection}
${burns ? `
  // Phase 7: Ignition
${ignitionApplied}` : ''}

  writeCell(ox, oy, bl, bl0);
  writeCell(ox + 1, oy, br, br0);
  writeCell(ox, oy + 1, tl, tl0);
  writeCell(ox + 1, oy + 1, tr, tr0);
}
`;
};
