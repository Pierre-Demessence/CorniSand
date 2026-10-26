import { CELL_FIELDS } from '../cell-fields';
import type { ElementDef } from '../elements';
import { MOVEMENT, launchGroups, movementWGSL } from '../movement';
import { BRUSH_COMMON_WGSL } from './brush.wgsl';
import { cellBindingsWGSL, cellTypesWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// WGSL of the flyer passes. A cell faster than LAUNCH_SPEED leaves the grid and flies as a free particle with a float
// position until it lands (docs/decisions.md "Cells move by velocity; fast cells fly as particles"). Once per superstep,
// after the offset-1 CA dispatch:
//   1. launch: a prefix sum over the launching cells, in cell order, gives each a slot after the live flyers
//   2. flight: two dispatches of gravity and drag, walking the cells crossed (read-only); a flyer that hits something
//      or slows down claims the free cell it stopped in
//   3. landing, two rounds: the lowest claim of each cell enters the grid; the losers look for a free cell nearby
//   4. compaction: a stable prefix sum drops the landed flyers
// Every slot comes from a prefix sum in a fixed order and every conflict is resolved by the slot index, so nothing
// depends on thread scheduling and reruns are bit-identical. Flyers do not collide with each other in flight.

// Words of the shared state buffer's header; the per-workgroup survivor counts follow it.
export const FLYER_STATE = {
  live: 0, // flyers in the air after the last compaction, in [0, live) of the current flyer buffer
  count: 1, // flyers in the buffer after the last launch, landed ones included until compaction
  launched: 2,
  jammed: 3, // flyers whose landing failed `jamRetries` times
  landed: 4,
  capped: 5, // launches refused because the flyer list was full
  maxRetries: 6,
} as const;
export const FLYER_STATE_WORDS = 8;

// Words of the indirect-arguments buffer: a dispatch over the flyers (`count`).
export const ARGS_DISPATCH = 0;
export const ARGS_WORDS = 3;

export const FLYER_STATUS = { flying: 0, landing: 1, landed: 2, retry: 3 } as const;

// The flyer struct in memory: position (2 words), velocity (2), the carried cell (one word per field), then stop cell,
// claim key, failed landings and status, padded to its 8-byte alignment. Read back by `Flyers.read`.
export const FLYER_WORDS = (8 + CELL_FIELDS.length + 1) & ~1;
export const FLYER_OFFSET = { pos: 0, vel: 2, cell: 4, stop: 4 + CELL_FIELDS.length, key: 5 + CELL_FIELDS.length, retries: 6 + CELL_FIELDS.length, status: 7 + CELL_FIELDS.length } as const;

const flyerCommon = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${cellTypesWGSL(elements)}
${movementWGSL(maxFlyers)}

const W: u32 = ${width}u;
const H: u32 = ${height}u;
const NONE: u32 = 0xffffffffu;

const FLYING: u32 = ${FLYER_STATUS.flying}u;
const LANDING: u32 = ${FLYER_STATUS.landing}u;
const LANDED: u32 = ${FLYER_STATUS.landed}u;
const RETRY: u32 = ${FLYER_STATUS.retry}u;

struct Flyer {
  pos: vec2f,
  vel: vec2f,
  cell: Cell,
  stop: u32,
  key: u32,
  retries: u32,
  status: u32,
};

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && x < i32(W) && y >= 0 && y < i32(H);
}

fn cellIndex(x: i32, y: i32) -> u32 { return u32(y) * W + u32(x); }
`;

// The state buffer: the header counters and the survivor counts of compaction, one per workgroup of 64 flyers. The
// passes that count with atomics see the counters as atomics.
const stateWGSL = (atomics: boolean): string => /* wgsl */`
struct State {
  live: u32,
  count: u32,
  launched: u32,
  jammed: ${atomics ? 'atomic<u32>' : 'u32'},
  landed: ${atomics ? 'atomic<u32>' : 'u32'},
  capped: u32,
  maxRetries: ${atomics ? 'atomic<u32>' : 'u32'},
  unused: u32,
  survivors: array<u32>,
};
`;

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

// Launch 1/2: one workgroup turns the launch counts into slots after the live flyers and sizes the flyer passes.
export const launchScanWGSL = (width: number, height: number, maxFlyers: number): string => {
  const groups = launchGroups(width, height);
  return /* wgsl */`
${movementWGSL(maxFlyers)}
${stateWGSL(false)}

@group(0) @binding(0) var<storage, read_write> launchCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> launchPrefix: array<u32>;
@group(0) @binding(2) var<storage, read_write> state: State;
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
    let live = state.live;
    let accepted = min(total, MAX_FLYERS - live);
    let count = live + accepted;
    state.count = count;
    state.launched += accepted;
    state.capped += total - accepted;
    args[${ARGS_DISPATCH}] = (count + 63u) / 64u;
    args[${ARGS_DISPATCH + 1}] = 1u;
    args[${ARGS_DISPATCH + 2}] = 1u;
  }
}
`;
};

// Launch 2/2: each launching cell leaves the grid for its slot, in a fixed order (workgroup, thread, cell); past the
// cap it stays, clamped to the CA's top speed. Runs over the offset-1 CA's workgroups.
export const launchScatterWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => {
  const groups = launchGroups(width, height);
  return /* wgsl */`
${flyerCommon(elements, width, height, maxFlyers)}
${cellBindingsWGSL('read_write')}
${stateWGSL(false)}

@group(0) @binding(0) var<storage, read_write> flyers: array<Flyer>;
@group(0) @binding(1) var<storage, read> launchCounts: array<u32>;
@group(0) @binding(2) var<storage, read> launchPrefix: array<u32>;
@group(0) @binding(3) var<storage, read> state: State;

var<workgroup> wgCount: u32;
var<workgroup> ranks: array<u32, 64>;

fn launches(i: u32) -> bool {
  return field_velocity[i] != 0u && length(unpack2x16float(field_velocity[i])) > LAUNCH_SPEED;
}

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
    launching[j] = inGrid && inBounds(x, y) && launches(cellIndex(x, y));
    if (launching[j]) { n++; }
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

  var slot = state.live + launchPrefix[group] + ranks[li];
  for (var j = 0u; j < 4u; j++) {
    if (!launching[j]) { continue; }
    let x = ox + i32(j & 1u);
    let y = oy + i32(j >> 1u);
    let i = cellIndex(x, y);
    let c = loadCell(i);
    let v = cellVelocity(c);
    if (slot < MAX_FLYERS) {
      var fl: Flyer;
      fl.pos = vec2f(f32(x) + 0.5, f32(y) + 0.5) + clamp(cellRemainder(c), vec2f(-0.49), vec2f(0.49));
      fl.vel = v;
      fl.cell = c;
      fl.stop = NONE;
      fl.retries = 0u;
      fl.status = FLYING;
      flyers[slot] = fl;
      storeCell(i, makeCell(EL_EMPTY, 0u, 0u));
    } else {
      field_velocity[i] = pack2x16float(clamp(v, vec2f(-MAX_SPEED), vec2f(MAX_SPEED)));
    }
    slot++;
  }
}
`;
};

// State, grid access and the nearby-cell search shared by the flight, retry and landing passes.
const landingCommon = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number, access: 'read' | 'read_write'): string => /* wgsl */`
${flyerCommon(elements, width, height, maxFlyers)}
${cellBindingsWGSL(access)}
${stateWGSL(true)}

@group(0) @binding(0) var<storage, read_write> flyers: array<Flyer>;
@group(0) @binding(1) var<storage, read_write> claim: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> state: State;

fn isFree(x: i32, y: i32) -> bool {
  return inBounds(x, y) && (field_kind[cellIndex(x, y)] & 0xffu) == EL_EMPTY;
}

fn failLanding(fl: ptr<function, Flyer>) {
  (*fl).retries++;
  if ((*fl).retries == JAM_RETRIES) { atomicAdd(&state.jammed, 1u); }
  atomicMax(&state.maxRetries, (*fl).retries);
}

// A claim is (priority << 18) | slot and the lowest wins: the flyer that walked the fewest cells to its stop cell, then
// the lowest slot. A cell that hits something at once lands back in its own cell before one passing through takes it.
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

// Claims a free cell picked at random among those within SEARCH_RADIUS of the flyer's cell, which another cell took.
// Picking at random rather than the nearest spreads flyers that wanted the same cell over the free cells around it,
// instead of sending them all to the same neighbor. A flyer buried with no free cell around (the grid closed over it)
// searches around the first free cell above it, as a buried cell is pushed up. Returns false when none is found.
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

// Flight: two dispatches of gravity and drag per flyer, walking the cells it crosses (read-only). A flyer that hits
// something, or slowed below the launch speed, claims the cell it stopped in. Flyers the brush removed are skipped.
export const flightWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${landingCommon(elements, width, height, maxFlyers, 'read')}
${elementsWGSL}

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
  for (; n < ${2 * MOVEMENT.maxFlyerSpeed + 4}; n++) {
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
  if (fl.status == LANDED) { return; }
  fl.status = FLYING;
  let start = vec2i(floor(fl.pos));

  if (!isFree(start.x, start.y)) {
    // The CA filled the cell this flyer waited in.
    if (!claimNearby(&fl, i, 0u)) { failLanding(&fl); }
  } else {
    let t = cellType(fl.cell);
    let gravity = elGravity(t);
    let drag = elDrag(t);
    var walked = 0u;
    var hit = false;
    for (var s = 0; s < 2 && !hit; s++) {
      fl.vel.y -= gravity;
      fl.vel *= 1.0 - drag;
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

// Landing retry: a flyer that lost its claim in the first landing round claims a free cell nearby for the second.
export const retryWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${landingCommon(elements, width, height, maxFlyers, 'read')}

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

// Landing, two rounds per superstep: each claim's winner enters the grid with its velocity clamped to the CA's top
// speed and frees the claim. After round 1 the losers look for a free cell nearby (retryWGSL); after round 2 they
// count a failed landing and stay in the air. Also counts each workgroup's survivors for compaction.
export const landWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number, round: 1 | 2): string => /* wgsl */`
${landingCommon(elements, width, height, maxFlyers, 'read_write')}

var<workgroup> wgSurvivors: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  if (i < state.count) {
    var fl = flyers[i];
    if (fl.status == LANDING) {
      if (atomicLoad(&claim[fl.stop]) == fl.key) {
        storeCell(fl.stop, withMotion(fl.cell, clamp(fl.vel, vec2f(-MAX_SPEED), vec2f(MAX_SPEED)), vec2f(0.0)));
        atomicStore(&claim[fl.stop], NONE);
        fl.status = LANDED;
        atomicAdd(&state.landed, 1u);
      } else {
        ${round === 1 ? 'fl.status = RETRY;' : 'failLanding(&fl);\n        fl.status = FLYING;'}
      }
      flyers[i] = fl;
    }${round === 2 ? /* wgsl */` else if (fl.status == RETRY) {
      failLanding(&fl);
      fl.status = FLYING;
      flyers[i] = fl;
    }` : ''}
    if (fl.status != LANDED) { atomicAdd(&wgSurvivors, 1u); }
  }
  workgroupBarrier();
  if (li == 0u) { state.survivors[wid.x] = atomicLoad(&wgSurvivors); }
}
`;

// Compaction 1/2: survivor slots, the new live count.
export const compactScanWGSL = (): string => /* wgsl */`
${stateWGSL(false)}

@group(0) @binding(0) var<storage, read_write> survivorPrefix: array<u32>;
@group(0) @binding(1) var<storage, read_write> state: State;

var<workgroup> sums: array<u32, 256>;
var<workgroup> groupCount: u32;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupCount = (state.count + 63u) / 64u; }
  let groups = workgroupUniformLoad(&groupCount);
  ${workgroupScan('state.survivors', 'survivorPrefix', 'groups')}
  if (li == 255u) { state.live = sums[255]; }
}
`;

// Compaction 2/2: the survivors move to the other flyer buffer in their order.
export const compactScatterWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${flyerCommon(elements, width, height, maxFlyers)}
${stateWGSL(false)}

@group(0) @binding(0) var<storage, read> fromFlyers: array<Flyer>;
@group(0) @binding(1) var<storage, read_write> toFlyers: array<Flyer>;
@group(0) @binding(2) var<storage, read> survivorPrefix: array<u32>;
@group(0) @binding(3) var<storage, read> state: State;

var<workgroup> ranks: array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  var alive = false;
  var fl: Flyer;
  if (i < state.count) {
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

// The brush removes the flyers inside an erase or replace stroke. They are marked landed and the next compaction
// drops them. Runs over the flyers of the last compaction, [0, live).
export const flyerBrushWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${flyerCommon(elements, width, height, maxFlyers)}
${BRUSH_COMMON_WGSL}
${stateWGSL(false)}

@group(0) @binding(1) var<storage, read_write> flyers: array<Flyer>;
@group(0) @binding(2) var<storage, read> state: State;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= state.live || (b.erasing == 0u && b.replacing == 0u)) { return; }
  if (brushReaches(floor(flyers[i].pos))) { flyers[i].status = LANDED; }
}
`;

// The overlay: the kind word of the flyer in each cell, for the display (cleared before every frame's scatter).
export const overlayWGSL = (elements: readonly ElementDef[], width: number, height: number, maxFlyers: number): string => /* wgsl */`
${flyerCommon(elements, width, height, maxFlyers)}
${stateWGSL(false)}

@group(0) @binding(0) var<storage, read> flyers: array<Flyer>;
@group(0) @binding(1) var<storage, read> state: State;
@group(0) @binding(2) var<storage, read_write> overlay: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= state.live) { return; }
  let fl = flyers[i];
  let p = vec2i(floor(fl.pos));
  if (fl.status != LANDED && inBounds(p.x, p.y)) { overlay[cellIndex(p.x, p.y)] = fl.cell.kind; }
}
`;
