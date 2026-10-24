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
} as const;

// The particle passes of the frame start, one entry point each:
//   kill -> (cell brush) -> compactArgs -> compact -> finalize
// The brush appends after the `count` live particles of the current buffer; compaction then copies the live ones of
// [0, spawnCursor) into the other buffer, and finalize publishes the new count and the indirect arguments.
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
`;
