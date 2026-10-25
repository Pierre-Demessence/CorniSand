import { cellWGSL } from './cell.wgsl';
import { fluidCommonWGSL, GRID_WORKGROUP, tilesWGSL } from './fluid-common.wgsl';

// Binding numbers are shared by all entry points; each pass's bind group layout lists only the ones it uses.
export const GRID_BINDINGS = {
  cells: 0,
  counts: 1,
  oilCounts: 2,
  flags: 3,
  density: 4,
  uAcc: 5,
  vAcc: 6,
  u: 7,
  v: 8,
  uPrev: 9,
  vPrev: 10,
  uValid: 11,
  vValid: 12,
  p: 13,
  weights: 14,
  diagDiv: 15,
  residualMax: 16,
  divergence: 17,
  seeds: 18,
  tileFlags: 19,
  tiles: 20,
  activeList: 21,
  clearList: 22,
  listArgs: 23,
  partials: 24,
} as const;

const G = GRID_BINDINGS;

// The cell and face passes of a step, one entry point each. Cell passes cover x < W, y < H; face passes cover the
// (W + 1) x (H + 1) lattice, where a thread owns the u face (x, y) when y < H and the v face (x, y) when x < W.
// Grid indices: u[y * (W + 1) + x], v[y * W + x], cells y * W + x; outside the domain counts as solid.
//
// Active tiles: the passes with a 'tileCell' line run over a list of 8 x 8 tiles (the 'tileList' binding) instead of the
// whole grid. A step's active set A is every tile within one tile of a tile that holds a particle or a liquid cell
// ('classify' marks those in 'seeds', 'tileFlags' dilates them, 'tileCompact' lists them), so the 3 x 3 tiles around a
// tile of liquid cover everything a step reads or writes near it: a particle moves at most one cell, the extrapolation
// reaches two faces, a padding ring six cells. The clear set C is A plus the tiles that were active in the previous step;
// the passes that write "no liquid" state (the face and diagonal initialization, the keys) run over C, so a tile that
// leaves A is wiped once and outside C every buffer read near the active set already holds its empty value.
export const fluidGridWGSL = (width: number, height: number, capacity: number): string => /* wgsl */`
${cellWGSL}
${fluidCommonWGSL(width, height, capacity)}

@group(0) @binding(${G.cells}) var<storage, read> cells: array<u32>;
@group(0) @binding(${G.counts}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${G.oilCounts}) var<storage, read_write> oilCounts: array<atomic<u32>>;
@group(0) @binding(${G.flags}) var<storage, read_write> flags: array<u32>;
@group(0) @binding(${G.density}) var<storage, read_write> density: array<f32>;
// (sum of weight * velocity, sum of weight) per face, in fixed point.
@group(0) @binding(${G.uAcc}) var<storage, read_write> uAcc: array<atomic<i32>>;
@group(0) @binding(${G.vAcc}) var<storage, read_write> vAcc: array<atomic<i32>>;
@group(0) @binding(${G.u}) var<storage, read_write> u: array<f32>;
@group(0) @binding(${G.v}) var<storage, read_write> v: array<f32>;
@group(0) @binding(${G.uPrev}) var<storage, read_write> uPrev: array<f32>;
@group(0) @binding(${G.vPrev}) var<storage, read_write> vPrev: array<f32>;
// Two copies of the validity flags, the extrapolation reads one and writes the other.
@group(0) @binding(${G.uValid}) var<storage, read_write> uValid: array<u32>;
@group(0) @binding(${G.vValid}) var<storage, read_write> vValid: array<u32>;
@group(0) @binding(${G.p}) var<storage, read_write> p: array<f32>;
// Face weights (left, right, bottom, top) of a liquid cell, and the diagonal (the multigrid solve keeps its working
// vectors in the second component and in the coarse levels behind these, see fluid-multigrid.wgsl.ts).
@group(0) @binding(${G.weights}) var<storage, read_write> weights: array<vec4f>;
@group(0) @binding(${G.diagDiv}) var<storage, read_write> diagDiv: array<vec2f>;
// The divergence of a liquid cell minus the outflow the density correction asks for.
@group(0) @binding(${G.divergence}) var<storage, read_write> divergence: array<f32>;
@group(0) @binding(${G.residualMax}) var<storage, read_write> residualMax: atomic<u32>;
// One word per tile: 1 when 'classify' found a particle or a liquid cell in it, cleared by 'tileCompact'.
@group(0) @binding(${G.seeds}) var<storage, read_write> seeds: array<atomic<u32>>;
// One word per tile: bit 0 active in this step, bit 1 in the clear set (active now or in the previous step).
@group(0) @binding(${G.tileFlags}) var<storage, read_write> tileFlagBits: array<u32>;
// The compacted lists, [count, tile ids...], and their indirect dispatch arguments (active at word 0, clear at word 3).
@group(0) @binding(${G.activeList}) var<storage, read_write> activeList: array<u32>;
@group(0) @binding(${G.clearList}) var<storage, read_write> clearList: array<u32>;
@group(0) @binding(${G.listArgs}) var<storage, read_write> listArgs: array<u32>;
// The conjugate-gradient partial sums, one slot per tile.
@group(0) @binding(${G.partials}) var<storage, read_write> partials: array<f32>;
${tilesWGSL(G.tiles)}

const U_FACES: u32 = (W + 1u) * H;
const V_FACES: u32 = W * (H + 1u);
const TILE_COUNT: u32 = GRID_GROUPS_X * GRID_GROUPS_Y;

// Whether the swept color of a red-black sweep (0 or 1) and which validity copy the extrapolation reads (0 or 1):
// two pipelines from one entry point each, so no pass needs a uniform that changes between dispatches.
override COLOR: u32 = 0u;
override READ: u32 = 0u;
// Every tile active, whatever the seeds say: the reference the tests compare the tiled run with, and the bench baseline.
override ALL_TILES: u32 = 0u;

fn uIndex(x: u32, y: u32) -> u32 { return y * (W + 1u) + x; }
fn vIndex(x: u32, y: u32) -> u32 { return y * W + x; }

fn flagAt(x: i32, y: i32) -> u32 {
  if (x < 0 || y < 0 || x >= i32(W) || y >= i32(H)) { return FLAG_SOLID; }
  return flags[cellIndex(u32(x), u32(y))];
}

// The u face (x, y) sits between cells (x - 1, y) and (x, y); the v face (x, y) between (x, y - 1) and (x, y).
fn uFaceSolid(x: i32, y: i32) -> bool { return flagAt(x - 1, y) == FLAG_SOLID || flagAt(x, y) == FLAG_SOLID; }
fn vFaceSolid(x: i32, y: i32) -> bool { return flagAt(x, y - 1) == FLAG_SOLID || flagAt(x, y) == FLAG_SOLID; }
fn uFaceWet(x: i32, y: i32) -> bool { return flagAt(x - 1, y) == FLAG_LIQUID || flagAt(x, y) == FLAG_LIQUID; }
fn vFaceWet(x: i32, y: i32) -> bool { return flagAt(x, y - 1) == FLAG_LIQUID || flagAt(x, y) == FLAG_LIQUID; }

@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn clearGrid(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  if (x < W && y < H) {
    atomicStore(&counts[cellIndex(x, y)], 0u);
    atomicStore(&oilCounts[cellIndex(x, y)], 0u);
  }
  if (x <= W && y < H) {
    let a = 2u * uIndex(x, y);
    atomicStore(&uAcc[a], 0);
    atomicStore(&uAcc[a + 1u], 0);
  }
  if (x < W && y <= H) {
    let a = 2u * vIndex(x, y);
    atomicStore(&vAcc[a], 0);
    atomicStore(&vAcc[a + 1u], 0);
  }
}

var<workgroup> tileLive: atomic<u32>;

// Solid from the cell type, liquid wherever a particle sits (a cell rasterized as water without particles is air to
// the solver), density from the mix of kinds. The pressure is zero outside liquid. The excess particle count of a liquid
// cell goes to 'divergence' for 'prepare', and a tile holding a particle or a water or oil cell is marked in 'seeds'.
// Runs over the whole grid, so the flags are right everywhere: the walls and the sand far from the liquid too.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn classify(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) li: u32,
) {
  if (li == 0u) { atomicStore(&tileLive, 0u); }
  workgroupBarrier();
  if (gid.x < W && gid.y < H) {
    let c = cellIndex(gid.x, gid.y);
    let t = cellType(cells[c]);
    let n = atomicLoad(&counts[c]);
    // A particle stuck in a wall or sand cell (nothing free above it) still seeds its tile: its count is cleared by the
    // next step only if the tile is in the active set.
    if (n > 0u) { atomicStore(&tileLive, 1u); }
    if (t == TYPE_WALL || t == TYPE_SAND) {
      flags[c] = FLAG_SOLID;
      density[c] = 0.0;
      p[c] = 0.0;
    } else {
      if (t == TYPE_WATER || t == TYPE_OIL) { atomicStore(&tileLive, 1u); }
      if (n == 0u) {
        flags[c] = FLAG_AIR;
        density[c] = 0.0;
        p[c] = 0.0;
      } else {
        let oil = atomicLoad(&oilCounts[c]);
        flags[c] = FLAG_LIQUID;
        density[c] = (f32(n - oil) + f32(oil) * OIL_DENSITY) / f32(n);
        divergence[c] = f32(n) / f32(PER_CELL) - 1.0;
      }
    }
  }
  workgroupBarrier();
  if (li == 0u && atomicLoad(&tileLive) != 0u) { atomicStore(&seeds[wid.y * GRID_GROUPS_X + wid.x], 1u); }
}

// Active set of this step: a tile is active when it or one of its 8 neighbors was seeded. The clear set adds the tiles
// that were active in the previous step. Tiles outside the active set have no conjugate-gradient partial sum.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn tileFlags(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GRID_GROUPS_X || gid.y >= GRID_GROUPS_Y) { return; }
  let tile = gid.y * GRID_GROUPS_X + gid.x;
  var inSet = ALL_TILES == 1u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let x = i32(gid.x) + dx;
      let y = i32(gid.y) + dy;
      if (x >= 0 && y >= 0 && x < i32(GRID_GROUPS_X) && y < i32(GRID_GROUPS_Y)
          && atomicLoad(&seeds[u32(y) * GRID_GROUPS_X + u32(x)]) != 0u) {
        inSet = true;
      }
    }
  }
  let before = (tileFlagBits[tile] & 1u) != 0u;
  tileFlagBits[tile] = select(0u, 1u, inSet) | select(0u, 2u, inSet || before);
  if (!inSet) { partials[tile] = 0.0; }
}

const COMPACT_THREADS: u32 = 256u;
const TILES_PER_THREAD: u32 = (TILE_COUNT + COMPACT_THREADS - 1u) / COMPACT_THREADS;
var<workgroup> scanActive: array<u32, COMPACT_THREADS>;
var<workgroup> scanClear: array<u32, COMPACT_THREADS>;

fn listArgsFor(n: u32) -> vec3u { return vec3u(min(n, LIST_ROW), max(1u, (n + LIST_ROW - 1u) / LIST_ROW), 1u); }

// Turns the tile flags into the two lists, in tile order (so the sums over tiles are reproducible), and their dispatch
// arguments; one workgroup, each thread takes a run of tiles. Clears the seeds.
@compute @workgroup_size(256)
fn tileCompact(@builtin(local_invocation_index) lid: u32) {
  let begin = min(lid * TILES_PER_THREAD, TILE_COUNT);
  let end = min(begin + TILES_PER_THREAD, TILE_COUNT);
  var activeCount = 0u;
  var clearCount = 0u;
  for (var t = begin; t < end; t++) {
    let bits = tileFlagBits[t];
    activeCount += bits & 1u;
    clearCount += (bits >> 1u) & 1u;
  }
  scanActive[lid] = activeCount;
  scanClear[lid] = clearCount;
  workgroupBarrier();
  for (var offset = 1u; offset < COMPACT_THREADS; offset <<= 1u) {
    var nextActive = scanActive[lid];
    var nextClear = scanClear[lid];
    if (lid >= offset) {
      nextActive += scanActive[lid - offset];
      nextClear += scanClear[lid - offset];
    }
    workgroupBarrier();
    scanActive[lid] = nextActive;
    scanClear[lid] = nextClear;
    workgroupBarrier();
  }
  var activeAt = scanActive[lid] - activeCount;
  var clearAt = scanClear[lid] - clearCount;
  for (var t = begin; t < end; t++) {
    let bits = tileFlagBits[t];
    if ((bits & 1u) != 0u) { activeList[1u + activeAt] = t; activeAt++; }
    if ((bits & 2u) != 0u) { clearList[1u + clearAt] = t; clearAt++; }
    atomicStore(&seeds[t], 0u);
  }
  if (lid == COMPACT_THREADS - 1u) {
    let nActive = scanActive[lid];
    let nClear = scanClear[lid];
    activeList[0] = nActive;
    clearList[0] = nClear;
    let a = listArgsFor(nActive);
    let c = listArgsFor(nClear);
    listArgs[0] = a.x; listArgs[1] = a.y; listArgs[2] = a.z;
    listArgs[3] = c.x; listArgs[4] = c.y; listArgs[5] = c.z;
  }
}

// Accumulated sums to velocities, then the start of the extrapolation: solid faces carry nothing, faces touching a
// liquid cell are valid, every other face is cleared (the scatter writes faces of rows beside the liquid that touch none).
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn normalizeFaces(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  let i = i32(x);
  let j = i32(y);
  if (x <= W && y < H) {
    let a = 2u * uIndex(x, y);
    let weight = atomicLoad(&uAcc[a + 1u]);
    var value = 0.0;
    if (f32(weight) > MIN_WEIGHT) { value = f32(atomicLoad(&uAcc[a])) / f32(weight); }
    let wet = uFaceWet(i, j);
    if (uFaceSolid(i, j) || !wet) { value = 0.0; }
    u[uIndex(x, y)] = value;
    uValid[uIndex(x, y)] = select(0u, 1u, wet);
  }
  if (x < W && y <= H) {
    let a = 2u * vIndex(x, y);
    let weight = atomicLoad(&vAcc[a + 1u]);
    var value = 0.0;
    if (f32(weight) > MIN_WEIGHT) { value = f32(atomicLoad(&vAcc[a])) / f32(weight); }
    let wet = vFaceWet(i, j);
    if (vFaceSolid(i, j) || !wet) { value = 0.0; }
    v[vIndex(x, y)] = value;
    vValid[vIndex(x, y)] = select(0u, 1u, wet);
  }
}

// Start of the extrapolation after the projection: the same validity and clearing as normalizeFaces.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn extrapolateInit(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  let i = i32(x);
  let j = i32(y);
  if (x <= W && y < H) {
    let wet = uFaceWet(i, j);
    if (!wet) { u[uIndex(x, y)] = 0.0; }
    uValid[uIndex(x, y)] = select(0u, 1u, wet);
  }
  if (x < W && y <= H) {
    let wet = vFaceWet(i, j);
    if (!wet) { v[vIndex(x, y)] = 0.0; }
    vValid[vIndex(x, y)] = select(0u, 1u, wet);
  }
}

// One ring of the extrapolation: an invalid face next to valid ones takes their mean and becomes valid. Values are
// updated in place, which is safe because a pass only writes faces that were invalid and only reads faces that were
// valid; validity goes from copy READ to the other copy. Faces touching a solid stay invalid.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn extrapolate(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  let i = i32(x);
  let j = i32(y);
  if (x <= W && y < H) {
    let idx = uIndex(x, y);
    let src = READ * U_FACES + idx;
    let dst = (1u - READ) * U_FACES + idx;
    if (uValid[src] == 1u) {
      uValid[dst] = 1u;
    } else if (uFaceSolid(i, j)) {
      uValid[dst] = 0u;
    } else {
      var sum = 0.0;
      var n = 0u;
      if (x > 0u && uValid[src - 1u] == 1u) { sum += u[idx - 1u]; n++; }
      if (x < W && uValid[src + 1u] == 1u) { sum += u[idx + 1u]; n++; }
      if (y > 0u && uValid[src - (W + 1u)] == 1u) { sum += u[idx - (W + 1u)]; n++; }
      if (y + 1u < H && uValid[src + (W + 1u)] == 1u) { sum += u[idx + (W + 1u)]; n++; }
      if (n > 0u) { u[idx] = sum / f32(n); }
      uValid[dst] = select(0u, 1u, n > 0u);
    }
  }
  if (x < W && y <= H) {
    let idx = vIndex(x, y);
    let src = READ * V_FACES + idx;
    let dst = (1u - READ) * V_FACES + idx;
    if (vValid[src] == 1u) {
      vValid[dst] = 1u;
    } else if (vFaceSolid(i, j)) {
      vValid[dst] = 0u;
    } else {
      var sum = 0.0;
      var n = 0u;
      if (x > 0u && vValid[src - 1u] == 1u) { sum += v[idx - 1u]; n++; }
      if (x + 1u < W && vValid[src + 1u] == 1u) { sum += v[idx + 1u]; n++; }
      if (y > 0u && vValid[src - W] == 1u) { sum += v[idx - W]; n++; }
      if (y < H && vValid[src + W] == 1u) { sum += v[idx + W]; n++; }
      if (n > 0u) { v[idx] = sum / f32(n); }
      vValid[dst] = select(0u, 1u, n > 0u);
    }
  }
}

// Keeps the velocities before the forces (for the FLIP difference), then gravity on the interior v faces next to
// liquid, damping on every face, and solid faces back to zero.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn applyGravity(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  let i = i32(x);
  let j = i32(y);
  let keep = 1.0 - DAMPING;
  if (x <= W && y < H) {
    let idx = uIndex(x, y);
    uPrev[idx] = u[idx];
    u[idx] = select(u[idx] * keep, 0.0, uFaceSolid(i, j));
  }
  if (x < W && y <= H) {
    let idx = vIndex(x, y);
    vPrev[idx] = v[idx];
    var value = v[idx];
    if (y >= 1u && y < H && vFaceWet(i, j)) { value -= GRAVITY; }
    v[idx] = select(value * keep, 0.0, vFaceSolid(i, j));
  }
}

// Weight of the face between a liquid cell of density d and its neighbor: nothing flows through solid, an air neighbor
// holds p = 0 at the surface, which sits THETA of the way to its center (ghost fluid), and two liquids average.
fn faceWeight(flag: u32, d: f32, neighborDensity: f32) -> f32 {
  if (flag == FLAG_SOLID) { return 0.0; }
  if (flag == FLAG_AIR) { return 1.0 / (d * THETA); }
  return 2.0 / (d + neighborDensity);
}

fn densityAt(x: i32, y: i32, flag: u32) -> f32 {
  if (flag != FLAG_LIQUID) { return 0.0; }
  return density[cellIndex(u32(x), u32(y))];
}

// Face weights, and the divergence the solve has to cancel: the net outflow of the cell's faces minus the outflow
// the density correction asks for. A cell above rest density asks for outflow, an under-dense one surrounded by
// liquid for inflow (without it the liquid swells). The diagonal is zero outside liquid.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn prepare(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  if (flags[c] != FLAG_LIQUID) {
    diagDiv[c] = vec2f(0.0, 0.0);
    return;
  }
  let i = i32(gid.x);
  let j = i32(gid.y);
  let fl = flagAt(i - 1, j);
  let fr = flagAt(i + 1, j);
  let fb = flagAt(i, j - 1);
  let ft = flagAt(i, j + 1);
  let d = density[c];
  let w = vec4f(
    faceWeight(fl, d, densityAt(i - 1, j, fl)),
    faceWeight(fr, d, densityAt(i + 1, j, fr)),
    faceWeight(fb, d, densityAt(i, j - 1, fb)),
    faceWeight(ft, d, densityAt(i, j + 1, ft)),
  );
  weights[c] = w;

  let ratio = divergence[c];
  let interior = fl != FLAG_AIR && fr != FLAG_AIR && fb != FLAG_AIR && ft != FLAG_AIR;
  var source = 0.0;
  if (ratio > 0.0) { source = STIFFNESS * ratio; } else if (interior) { source = PULL * ratio; }
  let netOutflow = u[uIndex(gid.x + 1u, gid.y)] - u[uIndex(gid.x, gid.y)] + v[vIndex(gid.x, gid.y + 1u)] - v[vIndex(gid.x, gid.y)];
  diagDiv[c] = vec2f(w.x + w.y + w.z + w.w, 0.0);
  divergence[c] = netOutflow - source;
}

// One red-black Gauss-Seidel half sweep with over-relaxation (the plain solver). A cell's neighbors are all the other color, so threads
// of one dispatch never read what another writes and the result does not depend on their order.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn sweep(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H || ((gid.x + gid.y) & 1u) != COLOR) { return; }
  let c = cellIndex(gid.x, gid.y);
  let dd = diagDiv[c];
  if (dd.x == 0.0) { return; }
  let w = weights[c];
  var sum = 0.0;
  if (gid.x > 0u) { sum += w.x * p[c - 1u]; }
  if (gid.x + 1u < W) { sum += w.y * p[c + 1u]; }
  if (gid.y > 0u) { sum += w.z * p[c - W]; }
  if (gid.y + 1u < H) { sum += w.w * p[c + W]; }
  p[c] += OMEGA * ((sum - divergence[c]) / dd.x - p[c]);
}

// Subtracts the pressure gradient from the faces between two liquid cells, or a liquid and an air cell.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn gradient(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  let x = gid.x;
  let y = gid.y;
  if (x >= 1u && x < W && y < H) {
    let l = cellIndex(x - 1u, y);
    let r = cellIndex(x, y);
    let fl = flags[l];
    let fr = flags[r];
    let idx = uIndex(x, y);
    if (fl == FLAG_LIQUID && fr == FLAG_LIQUID) { u[idx] -= weights[l].y * (p[r] - p[l]); }
    else if (fl == FLAG_LIQUID && fr == FLAG_AIR) { u[idx] -= weights[l].y * -p[l]; }
    else if (fr == FLAG_LIQUID && fl == FLAG_AIR) { u[idx] -= weights[r].x * p[r]; }
  }
  if (x < W && y >= 1u && y < H) {
    let b = cellIndex(x, y - 1u);
    let t = cellIndex(x, y);
    let fb = flags[b];
    let ft = flags[t];
    let idx = vIndex(x, y);
    if (fb == FLAG_LIQUID && ft == FLAG_LIQUID) { v[idx] -= weights[b].w * (p[t] - p[b]); }
    else if (fb == FLAG_LIQUID && ft == FLAG_AIR) { v[idx] -= weights[b].w * -p[b]; }
    else if (ft == FLAG_LIQUID && fb == FLAG_AIR) { v[idx] -= weights[t].z * p[t]; }
  }
}

// A cell is a film when liquid rests on a solid under air.
fn isFilm(x: i32, y: i32) -> bool {
  return flagAt(x, y) == FLAG_LIQUID && flagAt(x, y - 1) == FLAG_SOLID && flagAt(x, y + 1) == FLAG_AIR;
}

// Wetting: a layer one cell deep that rests on a solid does not flow sideways, to another such cell or to air.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn pinFilms(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let gid = tileCell(wid, lid);
  if (gid.x < 1u || gid.x >= W || gid.y >= H) { return; }
  let i = i32(gid.x);
  let j = i32(gid.y);
  let left = isFilm(i - 1, j);
  let right = isFilm(i, j);
  if ((left && (right || flagAt(i, j) == FLAG_AIR)) || (right && flagAt(i - 1, j) == FLAG_AIR)) {
    u[uIndex(gid.x, gid.y)] = 0.0;
  }
}

// Test only: the largest |divergence - flow| over liquid cells for the current pressure, kept as the bits of a
// non-negative f32 (which order like u32s) so one atomicMax finds it. The caller zeroes residualMax first.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn measureResidual(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  let dd = diagDiv[c];
  if (dd.x == 0.0) { return; }
  let w = weights[c];
  var flow = 0.0;
  if (gid.x > 0u) { flow += w.x * (p[c - 1u] - p[c]); }
  if (gid.x + 1u < W) { flow += w.y * (p[c + 1u] - p[c]); }
  if (gid.y > 0u) { flow += w.z * (p[c - W] - p[c]); }
  if (gid.y + 1u < H) { flow += w.w * (p[c + W] - p[c]); }
  atomicMax(&residualMax, bitcast<u32>(abs(divergence[c] - flow)));
}
`;
