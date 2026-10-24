import { cellWGSL } from './cell.wgsl';
import { brushShapeWGSL } from './brush.wgsl';
import { fluidCommonWGSL, PARTICLE_WORKGROUP } from './fluid-common.wgsl';

// Binding numbers are shared by all entry points; each pass's bind group layout lists only the ones it uses.
export const PARTICLE_BINDINGS = {
  state: 0,
  particles: 1,
  compacted: 2,
  cells: 3,
  brush: 4,
  particleArgs: 5,
  gridArgs: 6,
  counts: 7,
  oilCounts: 8,
  uAcc: 9,
  vAcc: 10,
} as const;

// The particle passes, one entry point each. Frame start:
//   kill -> (cell brush) -> compactArgs -> compact -> finalize
// The brush appends after the `count` live particles of the current buffer; compaction then copies the live ones of
// [0, spawnCursor) into the other buffer, and finalize publishes the new count and the indirect arguments.
// Per step: resolve -> countParticles -> (classify, in fluid-grid) -> particlesToGrid.
export const fluidParticlesWGSL = (width: number, height: number, capacity: number): string => /* wgsl */`
${cellWGSL}
${fluidCommonWGSL(width, height, capacity)}
${brushShapeWGSL}

@group(0) @binding(${PARTICLE_BINDINGS.state}) var<storage, read_write> state: FluidState;
@group(0) @binding(${PARTICLE_BINDINGS.particles}) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(${PARTICLE_BINDINGS.compacted}) var<storage, read_write> compacted: array<Particle>;
@group(0) @binding(${PARTICLE_BINDINGS.cells}) var<storage, read> cells: array<u32>;
@group(0) @binding(${PARTICLE_BINDINGS.brush}) var<uniform> brush: BrushUniforms;
@group(0) @binding(${PARTICLE_BINDINGS.particleArgs}) var<storage, read_write> particleArgs: array<u32, 3>;
@group(0) @binding(${PARTICLE_BINDINGS.gridArgs}) var<storage, read_write> gridArgs: array<u32, 3>;
@group(0) @binding(${PARTICLE_BINDINGS.counts}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${PARTICLE_BINDINGS.oilCounts}) var<storage, read_write> oilCounts: array<atomic<u32>>;
// (sum of weight * velocity, sum of weight) per face, in fixed point.
@group(0) @binding(${PARTICLE_BINDINGS.uAcc}) var<storage, read_write> uAcc: array<atomic<i32>>;
@group(0) @binding(${PARTICLE_BINDINGS.vAcc}) var<storage, read_write> vAcc: array<atomic<i32>>;

// Particles to process, read from the state once per workgroup: an atomic load per thread would serialize them all.
var<workgroup> groupLimit: u32;

fn groupsFor(n: u32) -> u32 { return (n + ${PARTICLE_WORKGROUP - 1}u) / ${PARTICLE_WORKGROUP}u; }

// Particles inside the stroke die when it erases, or replaces a cell that is not a wall. Runs before the cell brush
// so it sees the old cell types. Dispatched indirectly over the live particles.
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn kill(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupLimit = atomicLoad(&state.count); }
  workgroupBarrier();
  let i = gid.x;
  if (i >= groupLimit) { return; }
  let p = particles[i];
  if (p.kind == KIND_DEAD) { return; }
  let cell = cellOf(p.px, p.py);
  if (!brushReaches(brush, vec2f(cell))) { return; }
  if (brush.erasing == 1u || (brush.replacing == 1u && cellType(cells[cellIndex(cell.x, cell.y)]) != TYPE_WALL)) {
    particles[i].kind = KIND_DEAD;
  }
}

// Resets the running compaction and sizes its dispatch over [0, spawnCursor). The dispatch that consumes
// particleArgs as indirect arguments binds neither argument buffer, so this write and that read never share a dispatch.
@compute @workgroup_size(1)
fn compactArgs() {
  atomicStore(&state.compactCursor, 0u);
  atomicStore(&state.water, 0u);
  atomicStore(&state.oil, 0u);
  particleArgs[0] = groupsFor(min(atomicLoad(&state.spawnCursor), CAPACITY));
  particleArgs[1] = 1u;
  particleArgs[2] = 1u;
}

var<workgroup> groupLive: atomic<u32>;
var<workgroup> groupWater: atomic<u32>;
var<workgroup> groupOil: atomic<u32>;
var<workgroup> groupBase: u32;

// Copies the live particles of the current buffer to the other one, in no particular order. Each workgroup counts
// its live particles with workgroup atomics and reserves one contiguous range with a single global atomicAdd, so
// millions of particles do not queue on one counter (they cost milliseconds at 3.4M particles); the per-kind
// totals are summed the same way, and the limit is read once per workgroup for the same reason.
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn compact(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    atomicStore(&groupLive, 0u);
    atomicStore(&groupWater, 0u);
    atomicStore(&groupOil, 0u);
    groupLimit = min(atomicLoad(&state.spawnCursor), CAPACITY);
  }
  workgroupBarrier();

  var p: Particle;
  var slot = 0u;
  var live = false;
  if (gid.x < groupLimit) {
    p = particles[gid.x];
    live = p.kind != KIND_DEAD;
  }
  if (live) {
    slot = atomicAdd(&groupLive, 1u);
    if (p.kind == KIND_OIL) { atomicAdd(&groupOil, 1u); } else { atomicAdd(&groupWater, 1u); }
  }
  workgroupBarrier();

  if (li == 0u) {
    groupBase = atomicAdd(&state.compactCursor, atomicLoad(&groupLive));
    atomicAdd(&state.water, atomicLoad(&groupWater));
    atomicAdd(&state.oil, atomicLoad(&groupOil));
  }
  workgroupBarrier();

  if (live) { compacted[groupBase + slot] = p; }
}

// Publishes the compaction: the live count, the append position for the next brush, and the arguments of the
// particle passes (one thread per particle) and of the cell and face passes (none when no particle is alive, so a
// world without liquid pays nothing for the fluid).
@compute @workgroup_size(1)
fn finalize() {
  let count = atomicLoad(&state.compactCursor);
  atomicStore(&state.count, count);
  atomicStore(&state.spawnCursor, count);
  particleArgs[0] = groupsFor(count);
  particleArgs[1] = 1u;
  particleArgs[2] = 1u;
  let live = select(0u, 1u, count > 0u);
  gridArgs[0] = GRID_GROUPS_X * live;
  gridArgs[1] = GRID_GROUPS_Y * live;
  gridArgs[2] = live;
}

fn blocks(t: u32) -> bool { return t == TYPE_WALL || t == TYPE_SAND; }

// Oil in a fire cell burns away. A particle inside a wall or sand cell (sand fell on it) moves up to just above the
// first free cell over it, at rest; with none above it stays.
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn resolve(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupLimit = atomicLoad(&state.count); }
  workgroupBarrier();
  let i = gid.x;
  if (i >= groupLimit) { return; }
  let p = particles[i];
  if (p.kind == KIND_DEAD) { return; }
  let cell = cellOf(p.px, p.py);
  let here = cellType(cells[cellIndex(cell.x, cell.y)]);
  if (p.kind == KIND_OIL && here == TYPE_FIRE) {
    particles[i].kind = KIND_DEAD;
    return;
  }
  if (!blocks(here)) { return; }
  var free = cell.y + 1u;
  while (free < H && blocks(cellType(cells[cellIndex(cell.x, free)]))) { free++; }
  if (free < H) {
    particles[i].py = f32(free) + RESOLVE_LIFT;
    particles[i].vy = 0.0;
  }
}

// Particles per cell, and how many of them are oil.
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn countParticles(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupLimit = atomicLoad(&state.count); }
  workgroupBarrier();
  let i = gid.x;
  if (i >= groupLimit) { return; }
  let p = particles[i];
  if (p.kind == KIND_DEAD) { return; }
  let cell = cellOf(p.px, p.py);
  atomicAdd(&counts[cellIndex(cell.x, cell.y)], 1u);
  if (p.kind == KIND_OIL) { atomicAdd(&oilCounts[cellIndex(cell.x, cell.y)], 1u); }
}

// Particle velocities to the u and v faces with bilinear weights. u faces sit on the left edge of a cell at the
// middle of its height, v faces on the bottom edge at the middle of its width. The sums are fixed point because
// WebGPU has no float atomics; integer addition is exact, so they do not depend on the order of the particles.
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn particlesToGrid(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { groupLimit = atomicLoad(&state.count); }
  workgroupBarrier();
  let i = gid.x;
  if (i >= groupLimit) { return; }
  let p = particles[i];
  if (p.kind == KIND_DEAD) { return; }

  var f = vec2f(p.px, p.py - 0.5);
  var base = floor(f);
  var t = f - base;
  for (var dj = 0; dj < 2; dj++) {
    let j = i32(base.y) + dj;
    if (j < 0 || j >= i32(H)) { continue; }
    for (var di = 0; di < 2; di++) {
      let x = i32(base.x) + di;
      if (x < 0 || x > i32(W)) { continue; }
      let w = select(1.0 - t.x, t.x, di == 1) * select(1.0 - t.y, t.y, dj == 1);
      let face = 2u * (u32(j) * (W + 1u) + u32(x));
      atomicAdd(&uAcc[face], i32(round(w * p.vx * FIXED_SCALE)));
      atomicAdd(&uAcc[face + 1u], i32(round(w * FIXED_SCALE)));
    }
  }

  f = vec2f(p.px - 0.5, p.py);
  base = floor(f);
  t = f - base;
  for (var dj = 0; dj < 2; dj++) {
    let j = i32(base.y) + dj;
    if (j < 0 || j > i32(H)) { continue; }
    for (var di = 0; di < 2; di++) {
      let x = i32(base.x) + di;
      if (x < 0 || x >= i32(W)) { continue; }
      let w = select(1.0 - t.x, t.x, di == 1) * select(1.0 - t.y, t.y, dj == 1);
      let face = 2u * (u32(j) * W + u32(x));
      atomicAdd(&vAcc[face], i32(round(w * p.vy * FIXED_SCALE)));
      atomicAdd(&vAcc[face + 1u], i32(round(w * FIXED_SCALE)));
    }
  }
}
`;
