import { ELEMENTS } from '../elements';
import { commonWGSL } from '../shaders/cell.wgsl';
import { elementConstantsWGSL } from '../shaders/elements.wgsl';
import { BLAST_MARK, PROTO, type MovementModel } from './params';

// WGSL of the M4.1 movement prototype: the CA of the three models (baseline, A, C), the blast and source passes, the
// flyer passes of C, and the display. Cells are one packed `u32` (`PACKED_CELL_WGSL`, not the engine's cell fields)
// and the motion one `vec4f` per cell (vx, vy, remainder x, remainder y), both updated in place: a CA thread reads and
// writes only its own block.

export interface ShaderConstants {
  width: number;
  height: number;
  gravity: number;
  friction: number;
  flyerDrag: number;
  launchSpeed: number;
  maxFlyers: number;
}

// Workgroups of the offset-1 CA dispatch, where C counts the launches: one launch count per workgroup.
export function launchGroups(width: number, height: number): { x: number; y: number } {
  return { x: Math.ceil(Math.ceil((width + 1) / 2) / 8), y: Math.ceil(Math.ceil((height + 1) / 2) / 8) };
}

// Words of the shared state buffer.
export const STATE = {
  live: 0, // flyers in the air after the last compaction, in [0, live) of the current flyer buffer
  count: 1, // flyers in the buffer after the last launch, landed ones included until compaction
  launched: 2,
  jammed: 3, // flyers whose landing failed `jamRetries` times
  landed: 4,
  emitted: 5, // grains the source created
  capped: 6, // launches refused because the flyer list was full
  maxRetries: 7,
} as const;
export const STATE_WORDS = 8;

// Words of the indirect-arguments buffer: a dispatch over the flyers (`count`), and a point draw of the live flyers.
export const ARGS_DISPATCH = 0;
export const ARGS_DRAW = 3;
export const ARGS_WORDS = 7;

// 10 words (40 bytes, the struct's size at its 8-byte alignment): position, velocity, cell word, stop cell, claim key,
// failed landings, status.
export const FLYER_WORDS = 10;
export const FLYER_STATUS = { flying: 0, landing: 1, landed: 2, retry: 3 } as const;

const f = (x: number): string => {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
};

// The prototype keeps the engine's former cell word: bits 0-7 type, 8-15 variant, 16-31 life.
const PACKED_CELL_WGSL = /* wgsl */`
${commonWGSL}
${elementConstantsWGSL(ELEMENTS)}

fn cellType(c: u32) -> u32 { return c & 0xffu; }
fn cellVariant(c: u32) -> u32 { return (c >> 8u) & 0xffu; }
fn cellLife(c: u32) -> u32 { return c >> 16u; }

fn makeCell(t: u32, variant: u32, life: u32) -> u32 {
  return t | (variant << 8u) | (life << 16u);
}
`;

function common(k: ShaderConstants): string {
  return /* wgsl */`
${PACKED_CELL_WGSL}

const W: u32 = ${k.width}u;
const H: u32 = ${k.height}u;
const GRAVITY: f32 = ${f(k.gravity)};
const FRICTION: f32 = ${f(k.friction)};
const FLYER_DRAG: f32 = ${f(k.flyerDrag)};
const LAUNCH_SPEED: f32 = ${f(k.launchSpeed)};
const MAX_SPEED: f32 = ${f(PROTO.maxSpeed)};
const MAX_FLYER_SPEED: f32 = ${f(PROTO.maxFlyerSpeed)};
const MAX_FLYERS: u32 = ${k.maxFlyers}u;
const JAM_RETRIES: u32 = ${PROTO.jamRetries}u;
const NONE: u32 = 0xffffffffu;
const EMPTY_CELL: u32 = 0u;

const FLYING: u32 = ${FLYER_STATUS.flying}u;
const LANDING: u32 = ${FLYER_STATUS.landing}u;
const LANDED: u32 = ${FLYER_STATUS.landed}u;
const RETRY: u32 = ${FLYER_STATUS.retry}u;

struct Flyer {
  pos: vec2f,
  vel: vec2f,
  cell: u32,
  stop: u32,
  key: u32,
  retries: u32,
  status: u32,
};

struct FrameUniforms {
  wind: vec2f,
  sourceOn: u32,
  sourceX0: u32,
  sourceX1: u32,
  sourceY: u32,
  _pad: vec2u,
};

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && x < i32(W) && y >= 0 && y < i32(H);
}

fn cellIndex(x: i32, y: i32) -> u32 { return u32(y) * W + u32(x); }
`;
}

// One CA dispatch over the 2x2 blocks of one Margolus offset.
export function caWGSL(model: MovementModel, k: ShaderConstants): string {
  const groups = launchGroups(k.width, k.height);
  const isC = model === 'c';
  return /* wgsl */`
${common(k)}

struct StepUniforms {
  offset: u32,
  seed: u32,
};

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(2) var<uniform> step: StepUniforms;
@group(0) @binding(3) var<uniform> frame: FrameUniforms;
${isC ? `// One count per workgroup, then the total, which lets the launch scan skip a superstep without launches.
@group(0) @binding(4) var<storage, read_write> launchCounts: array<atomic<u32>>;
var<workgroup> wgLaunches: atomic<u32>;` : ''}

// The block, in the order bottom-left, bottom-right, top-left, top-right: slot = column + 2 * row.
var<private> cl: array<u32, 4>;
var<private> mo: array<vec4f, 4>;
var<private> done: array<bool, 4>;

fn isSandAt(j: u32) -> bool { return cellType(cl[j]) == EL_SAND; }
fn isEmptyAt(j: u32) -> bool { return cellType(cl[j]) == EL_EMPTY; }

fn slotAt(col: i32, row: i32) -> i32 {
  if (col < 0 || col > 1 || row < 0 || row > 1) { return -1; }
  return col + 2 * row;
}

fn moveTo(i: u32, j: u32) {
  cl[j] = cl[i];
  mo[j] = mo[i];
  cl[i] = EMPTY_CELL;
  mo[i] = vec4f(0.0);
  done[j] = true;
}

// Speed left on one axis after bumping into the cell in slot j: the obstacle's speed if it moves the same way more
// slowly, else 0. A grain falling onto a falling grain follows it instead of stopping.
fn bumped(v: f32, j: u32, axis: u32) -> f32 {
  var ov = 0.0;
  if (isSandAt(j)) { ov = mo[j][axis]; }
  if (v < 0.0) { return min(0.0, max(v, ov)); }
  return max(0.0, min(v, ov));
}

fn stepOf(r: f32) -> i32 {
  if (r >= 1.0) { return 1; }
  if (r <= -1.0) { return -1; }
  return 0;
}

// Baseline: today's sand rules (fall, slide), velocity ignored.
fn baselineRules() {
  if (isSandAt(2u) && isEmptyAt(0u)) { moveTo(2u, 0u); }
  if (isSandAt(3u) && isEmptyAt(1u)) { moveTo(3u, 1u); }
  if (isSandAt(2u) && !isEmptyAt(0u) && isEmptyAt(1u)) { moveTo(2u, 1u); }
  if (isSandAt(3u) && !isEmptyAt(1u) && isEmptyAt(0u)) { moveTo(3u, 0u); }
}

// A (and C below the launch speed): integrate the velocity, move one cell inside the block once the remainder
// reaches 1 on an axis, stop an axis that is blocked, slide diagonally when resting.
fn velocityRule(i: u32) {
  if (done[i] || !isSandAt(i)) { return; }
  var v = mo[i].xy;
  var r = mo[i].zw;
  ${isC ? '// Waiting for the launch pass: frozen, an obstacle for the others.\n  if (length(v) > LAUNCH_SPEED) { return; }' : ''}
  let col = i32(i & 1u);
  let row = i32(i >> 1u);
  // A grain at rest starts falling only once a top-row dispatch has seen the cell below it free. Otherwise every
  // level of a resting stack banks one more gravity step than the one under it, and the top of a deep layer launches.
  if (row == 1 || v.y != 0.0) { v.y -= GRAVITY; }
  // Wind reaches grains with an empty cell above; a cell is in the bottom row every other dispatch, hence twice.
  if (row == 0 && isEmptyAt(i + 2u)) { v += 2.0 * frame.wind; }
  ${isC
    ? 'if (length(v) > MAX_FLYER_SPEED) { v *= MAX_FLYER_SPEED / length(v); }'
    : 'v = clamp(v, vec2f(-MAX_SPEED), vec2f(MAX_SPEED));'}
  r += clamp(v, vec2f(-MAX_SPEED), vec2f(MAX_SPEED));
  let sx = stepOf(r.x);
  let sy = stepOf(r.y);

  var at = i;
  var moved = false;
  if (sx != 0 && sy != 0) {
    let j = slotAt(col + sx, row + sy);
    if (j >= 0 && isEmptyAt(u32(j))) {
      moveTo(i, u32(j)); at = u32(j); moved = true;
      r -= vec2f(f32(sx), f32(sy));
    }
  }
  if (!moved && sy != 0) {
    let j = slotAt(col, row + sy);
    if (j >= 0) {
      if (isEmptyAt(u32(j))) {
        moveTo(i, u32(j)); at = u32(j); moved = true;
        r.y -= f32(sy);
      } else {
        v.y = bumped(v.y, u32(j), 1u);
        r.y = 0.0;
      }
    }
  }
  if (!moved && sx != 0) {
    let j = slotAt(col + sx, row);
    if (j >= 0) {
      if (isEmptyAt(u32(j))) {
        moveTo(i, u32(j)); at = u32(j); moved = true;
        r.x -= f32(sx);
      } else {
        v.x = bumped(v.x, u32(j), 0u);
        r.x = 0.0;
      }
    }
  }

  // Resting on something: stop falling, lose sideways speed, and slide to the opposite bottom corner when it is free.
  if ((at >> 1u) == 1u && !isEmptyAt(at - 2u)) {
    if (v.y < 0.0) { v.y = bumped(v.y, at - 2u, 1u); }
    r.y = max(r.y, 0.0);
    v.x *= 1.0 - FRICTION;
    let corner = 1u - (at & 1u);
    if (!moved && isEmptyAt(corner)) {
      moveTo(at, corner); at = corner;
      v.y = 0.0;
      r.y = 0.0;
    }
  }
  // A grain whose target lies outside the block waits a dispatch; this bounds what it banks meanwhile.
  r = clamp(r, vec2f(-2.0), vec2f(2.0));
  mo[at] = vec4f(v, r);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u${isC ? ', @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32' : ''}) {
  let inGrid = gid.x < (W + step.offset + 1u) / 2u && gid.y < (H + step.offset + 1u) / 2u;
  let ox = i32(gid.x) * 2 - i32(step.offset);
  let oy = i32(gid.y) * 2 - i32(step.offset);

  var orig: array<u32, 4>;
  var origMotion: array<vec4f, 4>;
  if (inGrid) {
    for (var j = 0u; j < 4u; j++) {
      let x = ox + i32(j & 1u);
      let y = oy + i32(j >> 1u);
      var c = makeCell(EL_WALL, 0u, 0u);
      var m = vec4f(0.0);
      if (inBounds(x, y)) {
        c = cells[cellIndex(x, y)];
        ${model === 'baseline' ? '' : 'if (cellType(c) == EL_SAND) { m = motion[cellIndex(x, y)]; }'}
      }
      cl[j] = c;
      mo[j] = m;
      orig[j] = c;
      origMotion[j] = m;
    }

    ${model === 'baseline'
      ? 'baselineRules();'
      : `// A block with no empty cell and no motion is a fixed point of the rules: nothing can move into it, gravity
    // cancels against the grain below, wind needs an empty cell above. Skipping it is most of the cost of a pile.
    var still = true;
    for (var j = 0u; j < 4u; j++) { still = still && !isEmptyAt(j) && all(mo[j] == vec4f(0.0)); }
    if (!still) {
      // Bottom row first, so a grain moving up finds the cell it leaves free; the column order is random.
      let first = select(0u, 1u, (hash2(gid.x, gid.y, step.seed) >> 31u) == 1u);
      velocityRule(first);
      velocityRule(1u - first);
      velocityRule(2u + first);
      velocityRule(3u - first);
    }`}

    for (var j = 0u; j < 4u; j++) {
      let x = ox + i32(j & 1u);
      let y = oy + i32(j >> 1u);
      if (!inBounds(x, y)) { continue; }
      if (cl[j] != orig[j]) { cells[cellIndex(x, y)] = cl[j]; }
      ${model === 'baseline' ? '' : 'if (any(mo[j] != origMotion[j])) { motion[cellIndex(x, y)] = mo[j]; }'}
    }
  }
  ${isC ? `
  // Offset 1 ends the superstep's CA: count this workgroup's launches for the launch pass.
  if (step.offset == 1u) {
    if (inGrid) {
      var n = 0u;
      for (var j = 0u; j < 4u; j++) {
        if (inBounds(ox + i32(j & 1u), oy + i32(j >> 1u)) && isSandAt(j) && length(mo[j].xy) > LAUNCH_SPEED) { n++; }
      }
      if (n > 0u) { atomicAdd(&wgLaunches, n); }
    }
    workgroupBarrier();
    if (li == 0u) {
      let n = atomicLoad(&wgLaunches);
      atomicStore(&launchCounts[wid.y * ${groups.x}u + wid.x], n);
      if (n > 0u) { atomicAdd(&launchCounts[${groups.x * groups.y}u], n); }
    }
  }` : ''}
}
`;
}

// Sets the outward velocity of every grain in a disc and marks it (BLAST_MARK in the variant byte).
export function blastWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

struct Blast {
  center: vec2f,
  radius: f32,
  speed: f32,
  origin: vec2i,
};

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(2) var<uniform> blast: Blast;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = blast.origin.x + i32(gid.x);
  let y = blast.origin.y + i32(gid.y);
  if (!inBounds(x, y)) { return; }
  let i = cellIndex(x, y);
  let c = cells[i];
  if (cellType(c) != EL_SAND) { return; }
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - blast.center;
  let dist = length(d);
  if (dist >= blast.radius) { return; }
  var dir = vec2f(0.0, 1.0);
  if (dist > 0.0) { dir = d / dist; }
  motion[i] = vec4f(dir * blast.speed * (1.0 - dist / blast.radius), 0.0, 0.0);
  cells[i] = makeCell(EL_SAND, cellVariant(c) | ${BLAST_MARK}u, cellLife(c));
}
`;
}

// Puts a resting grain in every empty cell of the source row.
export function sourceWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

struct State {
  words: array<atomic<u32>, ${STATE_WORDS}>,
};

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> state: State;
@group(0) @binding(3) var<uniform> frame: FrameUniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(frame.sourceX0 + gid.x);
  let y = i32(frame.sourceY);
  if (frame.sourceOn == 0u || u32(x) >= frame.sourceX1 || !inBounds(x, y)) { return; }
  let i = cellIndex(x, y);
  if (cellType(cells[i]) != EL_EMPTY) { return; }
  cells[i] = makeCell(EL_SAND, 0u, 0u);
  motion[i] = vec4f(0.0);
  atomicAdd(&state.words[${STATE.emitted}], 1u);
}
`;
}

// Exclusive prefix sum of `n` counts by one workgroup of 256 threads; leaves the total in sums[255].
function workgroupScan(input: string, output: string, n: string): string {
  return /* wgsl */`
  let chunk = (${n} + 255u) / 256u;
  let start = min(li * chunk, ${n});
  let end = min(start + chunk, ${n});
  var own = 0u;
  for (var k = start; k < end; k++) { own += ${input}[k]; }
  sums[li] = own;
  workgroupBarrier();
  for (var d = 1u; d < 256u; d *= 2u) {
    var t = 0u;
    if (li >= d) { t = sums[li - d]; }
    workgroupBarrier();
    sums[li] += t;
    workgroupBarrier();
  }
  var running = sums[li] - own;
  for (var k = start; k < end; k++) {
    let c = ${input}[k];
    ${output}[k] = running;
    running += c;
  }`;
}

// C, launch 1/2: one workgroup turns the launch counts into slots after the live flyers and sizes the flyer passes.
export function launchScanWGSL(k: ShaderConstants): string {
  const groups = launchGroups(k.width, k.height);
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read_write> launchCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> launchPrefix: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<u32, ${STATE_WORDS}>;
@group(0) @binding(3) var<storage, read_write> args: array<u32, ${ARGS_WORDS}>;

var<workgroup> sums: array<u32, 256>;
var<workgroup> launchTotal: u32;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) { launchTotal = launchCounts[${groups.x * groups.y}u]; }
  let total = workgroupUniformLoad(&launchTotal);
  // Without launches every count is 0 and the scatter pass skips every workgroup, so the prefix is not read.
  if (total > 0u) {
    ${workgroupScan('launchCounts', 'launchPrefix', `${groups.x * groups.y}u`)}
  }
  if (li == 255u) {
    launchCounts[${groups.x * groups.y}u] = 0u;
    let live = state[${STATE.live}];
    let accepted = min(total, MAX_FLYERS - live);
    let count = live + accepted;
    state[${STATE.count}] = count;
    state[${STATE.launched}] += accepted;
    state[${STATE.capped}] += total - accepted;
    args[${ARGS_DISPATCH}] = (count + 63u) / 64u;
    args[${ARGS_DISPATCH + 1}] = 1u;
    args[${ARGS_DISPATCH + 2}] = 1u;
  }
}
`;
}

// C, launch 2/2: each launching grain leaves the grid for its slot, in a fixed order (workgroup, thread, cell);
// past the cap it stays, clamped to the CA's top speed. Runs over the offset-1 CA's workgroups.
export function launchScatterWGSL(k: ShaderConstants): string {
  const groups = launchGroups(k.width, k.height);
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> flyers: array<Flyer>;
@group(0) @binding(3) var<storage, read> launchCounts: array<u32>;
@group(0) @binding(4) var<storage, read> launchPrefix: array<u32>;
@group(0) @binding(5) var<storage, read> state: array<u32, ${STATE_WORDS}>;

var<workgroup> wgCount: u32;
var<workgroup> ranks: array<u32, 64>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let group = wid.y * ${groups.x}u + wid.x;
  if (li == 0u) { wgCount = launchCounts[group]; }
  if (workgroupUniformLoad(&wgCount) == 0u) { return; }

  let ox = i32(gid.x) * 2 - 1;
  let oy = i32(gid.y) * 2 - 1;
  let inGrid = gid.x < (W + 2u) / 2u && gid.y < (H + 2u) / 2u;
  var launching: array<bool, 4>;
  var n = 0u;
  for (var j = 0u; j < 4u; j++) {
    let x = ox + i32(j & 1u);
    let y = oy + i32(j >> 1u);
    launching[j] = false;
    if (inGrid && inBounds(x, y)) {
      let i = cellIndex(x, y);
      if (cellType(cells[i]) == EL_SAND && length(motion[i].xy) > LAUNCH_SPEED) {
        launching[j] = true;
        n++;
      }
    }
  }
  ranks[li] = n;
  workgroupBarrier();
  if (li == 0u) {
    var running = 0u;
    for (var t = 0u; t < 64u; t++) {
      let c = ranks[t];
      ranks[t] = running;
      running += c;
    }
  }
  workgroupBarrier();

  var slot = state[${STATE.live}] + launchPrefix[group] + ranks[li];
  for (var j = 0u; j < 4u; j++) {
    if (!launching[j]) { continue; }
    let x = ox + i32(j & 1u);
    let y = oy + i32(j >> 1u);
    let i = cellIndex(x, y);
    let m = motion[i];
    if (slot < MAX_FLYERS) {
      var fl: Flyer;
      fl.pos = vec2f(f32(x) + 0.5, f32(y) + 0.5) + clamp(m.zw, vec2f(-0.49), vec2f(0.49));
      fl.vel = m.xy;
      fl.cell = cells[i];
      fl.stop = NONE;
      fl.retries = 0u;
      fl.status = FLYING;
      flyers[slot] = fl;
      cells[i] = EMPTY_CELL;
      motion[i] = vec4f(0.0);
    } else {
      motion[i] = vec4f(clamp(m.xy, vec2f(-MAX_SPEED), vec2f(MAX_SPEED)), m.zw);
    }
    slot++;
  }
}
`;
}

// State, grid access and the nearby-cell search shared by the flight, retry and landing passes.
function flyerCommon(k: ShaderConstants, cellsAccess: 'read' | 'read_write'): string {
  return /* wgsl */`
${common(k)}

struct State {
  live: u32,
  count: u32,
  launched: u32,
  jammed: atomic<u32>,
  landed: atomic<u32>,
  emitted: u32,
  capped: u32,
  maxRetries: atomic<u32>,
};

@group(0) @binding(0) var<storage, ${cellsAccess}> cells: array<u32>;
@group(0) @binding(1) var<storage, read_write> flyers: array<Flyer>;
@group(0) @binding(2) var<storage, read_write> claim: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> state: State;

fn isFree(x: i32, y: i32) -> bool {
  return inBounds(x, y) && cellType(cells[cellIndex(x, y)]) == EL_EMPTY;
}

fn failLanding(fl: ptr<function, Flyer>) {
  (*fl).retries++;
  if ((*fl).retries == JAM_RETRIES) { atomicAdd(&state.jammed, 1u); }
  atomicMax(&state.maxRetries, (*fl).retries);
}

// A claim is (priority << 18) | slot and the lowest wins: the flyer that walked the fewest cells to its stop cell, then
// the lowest slot. A grain that hits something at once lands back in its own cell before one passing through takes it.
fn claimKey(priority: u32, slot: u32) -> u32 { return (min(priority, 127u) << 18u) | slot; }

fn tryClaim(fl: ptr<function, Flyer>, stop: u32, priority: u32, slot: u32) {
  (*fl).status = LANDING;
  (*fl).stop = stop;
  (*fl).key = claimKey(priority, slot);
  atomicMin(&claim[stop], (*fl).key);
}

const SEARCH_RADIUS = 3;
const BURIED_SEARCH = 64;

fn countFree(center: vec2i) -> u32 {
  var free = 0u;
  for (var dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (var dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      if (isFree(center.x + dx, center.y + dy)) { free++; }
    }
  }
  return free;
}

// Claims a free cell picked at random among those within SEARCH_RADIUS of the flyer's cell, which another grain took.
// Picking at random rather than the nearest spreads flyers that wanted the same cell over the free cells around it,
// instead of sending them all to the same neighbor. A flyer buried with no free cell around (the sand closed over it)
// searches around the first free cell above it, as a buried grain is pushed up. Returns false when none is found.
fn claimNearby(fl: ptr<function, Flyer>, slot: u32, salt: u32) -> bool {
  var center = vec2i(floor((*fl).pos));
  var free = countFree(center);
  if (free == 0u) {
    var y = center.y + SEARCH_RADIUS + 1;
    for (; y < center.y + BURIED_SEARCH && !isFree(center.x, y); y++) {}
    if (!isFree(center.x, y)) { return false; }
    center = vec2i(center.x, y);
    free = countFree(center);
  }
  var pick = pcg(slot ^ ((*fl).retries << 24u) ^ salt) % free;
  for (var dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (var dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      let c = center + vec2i(dx, dy);
      if (!isFree(c.x, c.y)) { continue; }
      if (pick == 0u) {
        (*fl).pos = vec2f(c) + 0.5;
        tryClaim(fl, cellIndex(c.x, c.y), 64u + u32(max(abs(dx), abs(dy))), slot);
        return true;
      }
      pick--;
    }
  }
  return false;
}
`;
}

// C, flight: two dispatches of gravity, wind and drag per flyer, walking the cells it crosses (read-only). A flyer that
// hits something, or slowed below the launch speed, claims the cell it stopped in.
export function flightWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${flyerCommon(k, 'read')}

@group(0) @binding(4) var<uniform> frame: FrameUniforms;

// Walks the grid cells from p0 to p1, 4-connected, so a path cannot slip between two diagonal cells. Returns
// (x, y, hit, cells walked): the last free cell before the first occupied one, or the cell of p1 when nothing is hit.
fn walk(p0: vec2f, p1: vec2f) -> vec4i {
  var c = vec2i(floor(p0));
  let end = vec2i(floor(p1));
  let d = p1 - p0;
  let stepDir = vec2i(sign(d));
  var tMax = vec2f(1e30);
  var tDelta = vec2f(1e30);
  if (d.x != 0.0) {
    tDelta.x = abs(1.0 / d.x);
    tMax.x = (f32(c.x + select(0, 1, d.x > 0.0)) - p0.x) / d.x;
  }
  if (d.y != 0.0) {
    tDelta.y = abs(1.0 / d.y);
    tMax.y = (f32(c.y + select(0, 1, d.y > 0.0)) - p0.y) / d.y;
  }
  var n = 0;
  for (; n < ${2 * PROTO.maxFlyerSpeed + 4}; n++) {
    if (all(c == end)) { break; }
    var next = c;
    if (tMax.x < tMax.y) { next.x += stepDir.x; tMax.x += tDelta.x; } else { next.y += stepDir.y; tMax.y += tDelta.y; }
    if (!isFree(next.x, next.y)) { return vec4i(c, 1, n); }
    c = next;
  }
  return vec4i(c, 0, n);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= state.count) { return; }
  var fl = flyers[i];
  fl.status = FLYING;
  let start = vec2i(floor(fl.pos));

  if (!isFree(start.x, start.y)) {
    // The CA filled the cell this flyer waited in.
    if (!claimNearby(&fl, i, 0u)) { failLanding(&fl); }
  } else {
    var walked = 0u;
    var hit = false;
    for (var s = 0; s < 2 && !hit; s++) {
      fl.vel.y -= GRAVITY;
      fl.vel += frame.wind;
      fl.vel *= 1.0 - FLYER_DRAG;
      if (length(fl.vel) > MAX_FLYER_SPEED) { fl.vel *= MAX_FLYER_SPEED / length(fl.vel); }
      let to = fl.pos + fl.vel;
      let w = walk(fl.pos, to);
      walked += u32(w.w);
      if (w.z == 1) {
        fl.pos = vec2f(w.xy) + 0.5;
        hit = true;
      } else {
        fl.pos = to;
      }
    }
    if (hit || length(fl.vel) < LAUNCH_SPEED) {
      let c = vec2i(floor(fl.pos));
      tryClaim(&fl, cellIndex(c.x, c.y), walked, i);
    }
  }
  flyers[i] = fl;
}
`;
}

// C, landing retry: a flyer that lost its claim in the first landing round claims a free cell nearby for the second.
export function retryWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${flyerCommon(k, 'read')}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= state.count) { return; }
  var fl = flyers[i];
  if (fl.status != RETRY) { return; }
  claimNearby(&fl, i, 0x9e3779b9u);
  flyers[i] = fl;
}
`;
}

// C, landing, two rounds per superstep: each claim's winner enters the grid with its velocity clamped to the CA's top
// speed and frees the claim. After round 1 the losers look for a free cell nearby (retryWGSL); after round 2 they
// count a failed landing and stay in the air. Also counts each workgroup's survivors for compaction.
export function landWGSL(k: ShaderConstants, round: 1 | 2): string {
  return /* wgsl */`
${flyerCommon(k, 'read_write')}

@group(0) @binding(4) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> survivorCounts: array<u32>;

var<workgroup> wgSurvivors: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  if (i < state.count) {
    var fl = flyers[i];
    if (fl.status == LANDING) {
      if (atomicLoad(&claim[fl.stop]) == fl.key) {
        cells[fl.stop] = fl.cell;
        motion[fl.stop] = vec4f(clamp(fl.vel, vec2f(-MAX_SPEED), vec2f(MAX_SPEED)), 0.0, 0.0);
        atomicStore(&claim[fl.stop], NONE);
        fl.status = LANDED;
        atomicAdd(&state.landed, 1u);
      } else {
        ${round === 1 ? 'fl.status = RETRY;' : 'failLanding(&fl);\n        fl.status = FLYING;'}
      }
      flyers[i] = fl;
    }${round === 2 ? REMAINING_RETRY : ''}
    if (fl.status != LANDED) { atomicAdd(&wgSurvivors, 1u); }
  }
  workgroupBarrier();
  if (li == 0u) { survivorCounts[wid.x] = atomicLoad(&wgSurvivors); }
}
`;
}

// Round 2: a flyer that found no free cell in the retry pass failed this superstep's landing.
const REMAINING_RETRY = /* wgsl */` else if (fl.status == RETRY) {
      failLanding(&fl);
      fl.status = FLYING;
      flyers[i] = fl;
    }`;

// C, compaction 1/2: survivor slots, the new live count and the draw of the live flyers.
export function compactScanWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read> survivorCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> survivorPrefix: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: array<u32, ${STATE_WORDS}>;
@group(0) @binding(3) var<storage, read_write> args: array<u32, ${ARGS_WORDS}>;

var<workgroup> sums: array<u32, 256>;
var<workgroup> groupCount: u32;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupCount = (state[${STATE.count}] + 63u) / 64u; }
  let groups = workgroupUniformLoad(&groupCount);
  ${workgroupScan('survivorCounts', 'survivorPrefix', 'groups')}
  if (li == 255u) {
    let live = sums[255];
    state[${STATE.live}] = live;
    args[${ARGS_DRAW}] = live;
    args[${ARGS_DRAW + 1}] = 1u;
    args[${ARGS_DRAW + 2}] = 0u;
    args[${ARGS_DRAW + 3}] = 0u;
  }
}
`;
}

// C, compaction 2/2: the survivors move to the other flyer buffer in their order.
export function compactScatterWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read> fromFlyers: array<Flyer>;
@group(0) @binding(1) var<storage, read_write> toFlyers: array<Flyer>;
@group(0) @binding(2) var<storage, read> survivorPrefix: array<u32>;
@group(0) @binding(3) var<storage, read> state: array<u32, ${STATE_WORDS}>;

var<workgroup> ranks: array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  var alive = false;
  var fl: Flyer;
  if (i < state[${STATE.count}]) {
    fl = fromFlyers[i];
    alive = fl.status != LANDED;
  }
  ranks[li] = select(0u, 1u, alive);
  workgroupBarrier();
  for (var d = 1u; d < 64u; d *= 2u) {
    var t = 0u;
    if (li >= d) { t = ranks[li - d]; }
    workgroupBarrier();
    ranks[li] += t;
    workgroupBarrier();
  }
  if (alive) {
    fl.status = FLYING;
    toFlyers[survivorPrefix[wid.x] + ranks[li] - 1u] = fl;
  }
}
`;
}

// Display: the cells as a fullscreen triangle, then the flyers as points on top.
export function displayWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read> cells: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

const SAND_COLOR = vec3f(0.80, 0.70, 0.48);

@vertex
fn vsCells(@builtin(vertex_index) v: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VertexOutput;
  out.position = vec4f(pos[v], 0.0, 1.0);
  out.uv = (pos[v] + 1.0) * 0.5;
  return out;
}

@fragment
fn fsCells(in: VertexOutput) -> @location(0) vec4f {
  let x = min(u32(in.uv.x * f32(W)), W - 1u);
  let y = min(u32(in.uv.y * f32(H)), H - 1u);
  let t = cellType(cells[y * W + x]);
  var color = vec3f(0.07, 0.07, 0.09);
  if (t == EL_SAND) { color = SAND_COLOR; }
  if (t == EL_WALL) { color = vec3f(0.43, 0.45, 0.47); }
  return vec4f(color, 1.0);
}
`;
}

export function flyerDisplayWGSL(k: ShaderConstants): string {
  return /* wgsl */`
${common(k)}

@group(0) @binding(0) var<storage, read> flyers: array<Flyer>;

@vertex
fn vsFlyers(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  let p = flyers[v].pos / vec2f(f32(W), f32(H)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

@fragment
fn fsFlyers() -> @location(0) vec4f {
  return vec4f(0.80, 0.70, 0.48, 1.0);
}
`;
}
