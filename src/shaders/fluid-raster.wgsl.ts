import { FLUID } from '../fluid-params';
import { cellWGSL } from './cell.wgsl';
import { fluidCommonWGSL, GRID_WORKGROUP } from './fluid-common.wgsl';

// Binding numbers are shared by all entry points; each pass's bind group layout lists only the ones it uses.
export const RASTER_BINDINGS = {
  cells: 0,
  counts: 1,
  oilCounts: 2,
  keys: 3,
  oilKeys: 4,
  source: 5,
  histogram: 6,
  select: 7,
  state: 8,
} as const;

/** Words of the `SelectState` struct, in this order; the index of a name is its word offset in the `selectState` buffer. */
export const SELECT_FIELDS = [
  // Rank of the key to find (the number of cells to choose), set by `setWanted`.
  'wanted',
  // Radix round of the running selection, 0 to 3; the pick pass of the last round resets it.
  'round',
  // How many of the keys under the chosen prefix are still to be chosen.
  'remaining',
  // The high bytes of the wanted key found so far.
  'prefix',
  // 1 when nothing is chosen (`wanted` is 0).
  'none',
  // Cells wanted that no candidate could take, and its running maximum since load.
  'shortfall',
  'maxShortfall',
  // Cells chosen by the last selection.
  'chosen',
  // The second selection: how many of the chosen cells become oil.
  'oilWanted',
  // Chosen cells are the ones with a key at or above this.
  'threshold',
  'oilThreshold',
  'oilNone',
] as const;
export type SelectField = typeof SELECT_FIELDS[number];

export const SELECT_WORDS = SELECT_FIELDS.length;

const BYTE_ROUNDS = 4;

// Rasterization: the particles' cells ranked by an integer key, the best `wanted` of them become liquid.
//   clearCounts -> (rasterCount, in fluid-particles) -> setWanted -> keys -> padRing x paddingRings
//   -> (histogram -> pick) x 4 -> oilKeys -> (histogram -> pick) x 4 -> writeCells
// The selection is a radix select: four rounds of a 256-bin histogram over the next byte of the keys that still match
// the bytes found so far. The key formulas are `rasterQuality`, `rasterKey` and `oilKey` of fluid-params.ts, restated
// here as integer math; tests/fluid-raster.test.ts checks that they agree.
export const fluidRasterWGSL = (width: number, height: number, capacity: number): string => /* wgsl */`
${cellWGSL}
${fluidCommonWGSL(width, height, capacity)}

struct SelectState {
${SELECT_FIELDS.map((name) => `  ${name}: u32,`).join('\n')}
};

@group(0) @binding(${RASTER_BINDINGS.cells}) var<storage, read_write> cells: array<u32>;
@group(0) @binding(${RASTER_BINDINGS.counts}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${RASTER_BINDINGS.oilCounts}) var<storage, read_write> oilCounts: array<atomic<u32>>;
// 0 = not a candidate. Atomic so the padding rings, which read neighbors while others write, do not race.
@group(0) @binding(${RASTER_BINDINGS.keys}) var<storage, read_write> keyBuf: array<atomic<u32>>;
@group(0) @binding(${RASTER_BINDINGS.oilKeys}) var<storage, read_write> oilKeyBuf: array<u32>;
// The keys a histogram pass reads: the cell keys or the oil keys, whichever selection is running.
@group(0) @binding(${RASTER_BINDINGS.source}) var<storage, read> source: array<u32>;
@group(0) @binding(${RASTER_BINDINGS.histogram}) var<storage, read_write> histogram: array<atomic<u32>, 256>;
@group(0) @binding(${RASTER_BINDINGS.select}) var<storage, read_write> sel: SelectState;
@group(0) @binding(${RASTER_BINDINGS.state}) var<storage, read_write> state: FluidState;

const WEIGHT_COUNT: u32 = ${FLUID.weightCount}u;
const WEIGHT_SIDE: u32 = ${FLUID.weightSide}u;
const WEIGHT_LIQUID: u32 = ${FLUID.weightLiquid}u;
// Quality of ring r of the padding is PADDING_BASE - r: nearer rings rank higher, and all stay below WEIGHT_COUNT.
const PADDING_BASE: u32 = ${FLUID.weightPadding + FLUID.paddingRings}u;
const KEY_SHIFT: u32 = 16777216u;
const MAX_INDEX: u32 = 16777215u;

// Which ring a padding pass adds; one pipeline per ring from one entry point.
override RING: u32 = 1u;
// Whether a pick pass settles the oil selection instead of the cell selection.
override OIL: u32 = 0u;

fn isOpen(t: u32) -> bool { return t == TYPE_EMPTY || t == TYPE_WATER || t == TYPE_OIL; }
fn isBlocking(t: u32) -> bool { return t == TYPE_WALL || t == TYPE_SAND; }

fn chosen(key: u32) -> bool { return key != 0u && sel.none == 0u && key >= sel.threshold; }

@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn clearCounts(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < W && gid.y < H) {
    atomicStore(&counts[cellIndex(gid.x, gid.y)], 0u);
    atomicStore(&oilCounts[cellIndex(gid.x, gid.y)], 0u);
  }
  if (gid.x == 0u && gid.y == 0u) {
    atomicStore(&state.water, 0u);
    atomicStore(&state.oil, 0u);
  }
}

// One liquid cell per PER_CELL particles, rounded down, and the oiliest of them are oil.
@compute @workgroup_size(1)
fn setWanted() {
  let water = atomicLoad(&state.water);
  let oil = atomicLoad(&state.oil);
  sel.wanted = (water + oil) / PER_CELL;
  sel.oilWanted = oil / PER_CELL;
}

// Rank of every cell that holds a particle (see rasterQuality in fluid-params.ts); other open cells get a key from
// the padding rings. Wall, sand, smoke and fire are never candidates.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn keys(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  let t = cellType(cells[c]);
  let n = atomicLoad(&counts[c]);
  var value = 0u;
  if (isOpen(t) && n > 0u) {
    let own = min(n, COUNT_CLAMP);
    // A side that is wall, sand or outside the grid counts as the cell's own count.
    var left = own;
    var right = own;
    if (gid.x > 0u && !isBlocking(cellType(cells[c - 1u]))) { left = min(atomicLoad(&counts[c - 1u]), COUNT_CLAMP); }
    if (gid.x + 1u < W && !isBlocking(cellType(cells[c + 1u]))) { right = min(atomicLoad(&counts[c + 1u]), COUNT_CLAMP); }
    let quality = WEIGHT_COUNT * own + WEIGHT_SIDE * (left + right) + select(0u, WEIGHT_LIQUID, t != TYPE_EMPTY);
    value = quality * KEY_SHIFT + (MAX_INDEX - c);
  }
  atomicStore(&keyBuf[c], value);
}

// Ring RING of the padding: an open cell without a key next to a cell of the previous ring (ring 0 is the particle
// cells, whose quality is above every ring's) takes the ring's quality. Rings are told apart by quality, so cells
// written during this pass are never mistaken for the previous ring.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn padRing(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  if (atomicLoad(&keyBuf[c]) != 0u || !isOpen(cellType(cells[c]))) { return; }
  let previous = PADDING_BASE - (RING - 1u);
  var near = false;
  var neighbors = array<u32, 4>(c, c, c, c);
  var count = 0u;
  if (gid.x > 0u) { neighbors[count] = c - 1u; count++; }
  if (gid.x + 1u < W) { neighbors[count] = c + 1u; count++; }
  if (gid.y > 0u) { neighbors[count] = c - W; count++; }
  if (gid.y + 1u < H) { neighbors[count] = c + W; count++; }
  for (var i = 0u; i < count; i++) {
    let quality = atomicLoad(&keyBuf[neighbors[i]]) / KEY_SHIFT;
    if (quality != 0u && (select(quality == previous, quality > previous, RING == 1u))) { near = true; }
  }
  if (near) { atomicStore(&keyBuf[c], (PADDING_BASE - RING) * KEY_SHIFT + (MAX_INDEX - c)); }
}

// Histogram of the byte of round \`sel.round\` over the non-zero keys that start with the bytes found so far. Each
// workgroup counts in its own 256 bins and flushes them once, so the global bins see one add per workgroup, not per cell.
var<workgroup> groupBins: array<atomic<u32>, 256>;

@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn histogramPass(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  for (var b = li; b < 256u; b += ${GRID_WORKGROUP * GRID_WORKGROUP}u) { atomicStore(&groupBins[b], 0u); }
  workgroupBarrier();
  if (gid.x < W && gid.y < H) {
    let key = source[cellIndex(gid.x, gid.y)];
    let round = sel.round;
    if (key != 0u && (round == 0u || (key >> (32u - 8u * round)) == sel.prefix)) {
      atomicAdd(&groupBins[(key >> (24u - 8u * round)) & 255u], 1u);
    }
  }
  workgroupBarrier();
  for (var b = li; b < 256u; b += ${GRID_WORKGROUP * GRID_WORKGROUP}u) {
    let n = atomicLoad(&groupBins[b]);
    if (n > 0u) { atomicAdd(&histogram[b], n); }
  }
}

fn clearHistogram() {
  for (var b = 0u; b < 256u; b++) { atomicStore(&histogram[b], 0u); }
}

// Reads the histogram of a round and fixes the next byte of the wanted key: the highest bin where the running total
// from the top reaches the number of keys still wanted. Round 0 also settles the trivial cases (nothing wanted, or
// no more candidates than wanted: every candidate is chosen and the gap is the shortfall). The last round leaves the
// wanted key in the threshold and resets the round, so the next selection starts clean without a host write.
@compute @workgroup_size(1)
fn pick() {
  let oil = OIL == 1u;
  let want = select(sel.wanted, sel.oilWanted, oil);
  let round = sel.round;
  if (round == 0u) {
    var total = 0u;
    for (var b = 0u; b < 256u; b++) { total += atomicLoad(&histogram[b]); }
    sel.remaining = want;
    sel.prefix = 0u;
    if (want == 0u || total <= want) {
      let taken = min(total, want);
      if (oil) {
        sel.oilNone = select(0u, 1u, want == 0u);
        sel.oilThreshold = 1u;
      } else {
        sel.none = select(0u, 1u, want == 0u);
        sel.threshold = 1u;
        sel.chosen = taken;
        sel.shortfall = want - taken;
        sel.maxShortfall = max(sel.maxShortfall, sel.shortfall);
      }
      clearHistogram();
      return;
    }
  }

  var above = 0u;
  var bin = 0u;
  for (var b = 255; b >= 0; b--) {
    let n = atomicLoad(&histogram[u32(b)]);
    if (above + n >= sel.remaining) {
      bin = u32(b);
      break;
    }
    above += n;
  }
  sel.remaining -= above;
  sel.prefix = (sel.prefix << 8u) | bin;
  clearHistogram();

  if (round + 1u < ${BYTE_ROUNDS}u) {
    sel.round = round + 1u;
    return;
  }
  sel.round = 0u;
  if (oil) {
    sel.oilNone = 0u;
    sel.oilThreshold = sel.prefix;
  } else {
    sel.none = 0u;
    sel.threshold = sel.prefix;
    sel.chosen = want;
    sel.shortfall = 0u;
  }
}

// Key of the chosen cells for the oil selection: the oiliest first (share of oil particles, 0 to 255), and among equal
// shares the higher index, so oil settles on top. Padding cells hold no particles and have share 0.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn oilKeys(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  var value = 0u;
  if (chosen(atomicLoad(&keyBuf[c]))) {
    let n = atomicLoad(&counts[c]);
    let share = select(0u, (255u * atomicLoad(&oilCounts[c])) / n, n > 0u);
    value = share * KEY_SHIFT + (c + 1u);
  }
  oilKeyBuf[c] = value;
}

// Chosen cells become water or oil (variant 0, life 0), the other water and oil cells become empty, and every other
// cell is left alone: wall, sand, smoke and fire are never candidates. Each thread edits only its own cell.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn writeCells(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  if (chosen(atomicLoad(&keyBuf[c]))) {
    let oilKey = oilKeyBuf[c];
    let isOil = oilKey != 0u && sel.oilNone == 0u && oilKey >= sel.oilThreshold;
    cells[c] = makeCell(select(TYPE_WATER, TYPE_OIL, isOil), 0u, 0u);
    return;
  }
  let t = cellType(cells[c]);
  if (t == TYPE_WATER || t == TYPE_OIL) { cells[c] = makeCell(TYPE_EMPTY, 0u, 0u); }
}
`;
