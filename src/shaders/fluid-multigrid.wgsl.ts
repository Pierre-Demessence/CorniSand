import { FLUID, type LevelGeometry } from '../fluid-params';
import { fluidCommonWGSL, GRID_WORKGROUP } from './fluid-common.wgsl';

export const MG_BINDINGS = {
  weights: 0,
  diagDiv: 1,
  levelP: 2,
  p: 3,
  divergence: 4,
  cgD: 5,
  cgQ: 6,
  partials: 7,
  scalars: 8,
} as const;

/** Threads of the single-workgroup passes (the tail cycle and the sums of the dot products). */
export const TAIL_THREADS = 256;

/** Words of the scalars buffer: rz, alpha, beta, unused. */
export const SCALAR_WORDS = 4;

const M = MG_BINDINGS;

// A float literal WGSL accepts: `2` must read `2.0`.
const f32 = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// Statements of the tail cycle: the levels from `tailStart` down, each phase in the barrier-separated helpers below.
// The order is the CPU `MultigridSolver.vCycle`: pre-smoothing, restriction, the coarser levels, prolongation, then
// post-smoothing in reverse color order, with the coarsest level smoothed forward then back.
function tailCycleBody(tail: readonly LevelGeometry[]): string {
  const at = (k: number): string => `${tail[k].width}u, ${tail[k].height}u, ${tail[k].offset}u`;
  const pairs = (k: number, count: number, first: 0 | 1): string => `
  for (var s = 0u; s < ${count}u; s++) {
    smoothAll(${at(k)}, ${first}u, lid);
    smoothAll(${at(k)}, ${1 - first}u, lid);
  }`;
  const lines: string[] = [];
  for (let k = 0; k < tail.length - 1; k++) {
    lines.push(pairs(k, FLUID.preSweeps, 0));
    lines.push(`  restrictAll(${at(k)}, ${tail[k + 1].width}u, ${tail[k + 1].height}u, ${tail[k + 1].offset}u, lid);`);
  }
  const coarsest = tail.length - 1;
  lines.push(pairs(coarsest, FLUID.coarsestSweeps, 0));
  lines.push(pairs(coarsest, FLUID.coarsestSweeps, 1));
  for (let k = tail.length - 2; k >= 0; k--) {
    lines.push(`  prolongAll(${at(k)}, ${tail[k + 1].width}u, ${tail[k + 1].offset}u, lid);`);
    lines.push(pairs(k, FLUID.postSweeps, 1));
  }
  return lines.join('\n');
}

function tailBuildBody(tail: readonly LevelGeometry[]): string {
  const lines: string[] = [];
  for (let k = 1; k < tail.length; k++) {
    const f = tail[k - 1];
    const c = tail[k];
    lines.push(`  buildAll(${f.width}u, ${f.height}u, ${f.offset}u, ${c.width}u, ${c.height}u, ${c.offset}u, lid);`);
  }
  return lines.join('\n');
}

/**
 * The multigrid-preconditioned conjugate-gradient solve of the pressure (`MultigridSolver` in tests/cpu/solver.ts,
 * pass by pass). `levels` come from `multigridLevels`; the weights, the diagonal and right-hand side and the solution
 * of every level share one buffer each, from the level's `offset`. Level 0 is the preconditioner's own system:
 * `weights` are the pressure problem's, `diagDiv.y` holds the negated CG residual and `levelP` the preconditioned residual.
 */
export const fluidMultigridWGSL = (
  width: number,
  height: number,
  capacity: number,
  tail: readonly LevelGeometry[],
): string => /* wgsl */`
${fluidCommonWGSL(width, height, capacity)}

@group(0) @binding(${M.weights}) var<storage, read_write> weights: array<vec4f>;
// (diagonal, right-hand side in the sweep's convention: the system is  diagonal * x - sum(weight * x) = -div).
@group(0) @binding(${M.diagDiv}) var<storage, read_write> diagDiv: array<vec2f>;
@group(0) @binding(${M.levelP}) var<storage, read_write> lp: array<f32>;
@group(0) @binding(${M.p}) var<storage, read_write> p: array<f32>;
@group(0) @binding(${M.divergence}) var<storage, read_write> divergence: array<f32>;
@group(0) @binding(${M.cgD}) var<storage, read_write> cgD: array<f32>;
@group(0) @binding(${M.cgQ}) var<storage, read_write> cgQ: array<f32>;
@group(0) @binding(${M.partials}) var<storage, read_write> partials: array<f32>;
@group(0) @binding(${M.scalars}) var<storage, read_write> scalars: array<f32>;

const SMOOTHER_OMEGA: f32 = ${f32(FLUID.smootherOmega)};
const CORRECTION_SCALE: f32 = ${f32(FLUID.correctionScale)};
// A coarse cell whose diagonal falls below this share of its children's is enclosed with no exit (a sealed pocket).
const SEALED_DIAGONAL: f32 = 1e-5;
const CG_FLOOR: f32 = ${f32(FLUID.cgFloor)};
const TAIL_THREADS: u32 = ${TAIL_THREADS}u;
const PARTIALS: u32 = GRID_GROUPS_X * GRID_GROUPS_Y;

// A level is nx x ny cells stored from \`off\`; cell (x, y) is at off + y * nx + x. Neighbors outside the level, and
// cells without liquid (diagonal 0), hold x = 0.

fn smoothCell(nx: u32, ny: u32, off: u32, x: u32, y: u32) {
  let c = off + y * nx + x;
  let dd = diagDiv[c];
  if (dd.x == 0.0) { return; }
  let w = weights[c];
  var sum = 0.0;
  if (x > 0u) { sum += w.x * lp[c - 1u]; }
  if (x + 1u < nx) { sum += w.y * lp[c + 1u]; }
  if (y > 0u) { sum += w.z * lp[c - nx]; }
  if (y + 1u < ny) { sum += w.w * lp[c + nx]; }
  lp[c] += SMOOTHER_OMEGA * ((sum - dd.y) / dd.x - lp[c]);
}

// rhs - A x in one cell of a liquid cell.
fn residualAt(nx: u32, ny: u32, off: u32, x: u32, y: u32) -> f32 {
  let c = off + y * nx + x;
  let w = weights[c];
  let dd = diagDiv[c];
  var sum = 0.0;
  if (x > 0u) { sum += w.x * lp[c - 1u]; }
  if (x + 1u < nx) { sum += w.y * lp[c + 1u]; }
  if (y > 0u) { sum += w.z * lp[c - nx]; }
  if (y + 1u < ny) { sum += w.w * lp[c + nx]; }
  return sum - dd.x * lp[c] - dd.y;
}

// The coarse cell (cx, cy) takes the sum of the residuals of its liquid children as its right-hand side and a zero solution.
fn restrictCell(fnx: u32, fny: u32, foff: u32, cnx: u32, coff: u32, cx: u32, cy: u32) {
  var sum = 0.0;
  for (var dy = 0u; dy < 2u; dy++) {
    for (var dx = 0u; dx < 2u; dx++) {
      let x = 2u * cx + dx;
      let y = 2u * cy + dy;
      if (x < fnx && y < fny && diagDiv[foff + y * fnx + x].x != 0.0) { sum -= residualAt(fnx, fny, foff, x, y); }
    }
  }
  let c = coff + cy * cnx + cx;
  diagDiv[c].y = sum;
  lp[c] = 0.0;
}

fn prolongCell(fnx: u32, foff: u32, cnx: u32, coff: u32, x: u32, y: u32) {
  let c = foff + y * fnx + x;
  if (diagDiv[c].x != 0.0) { lp[c] += CORRECTION_SCALE * lp[coff + (y >> 1u) * cnx + (x >> 1u)]; }
}

fn fineActive(fnx: u32, fny: u32, foff: u32, x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(fnx) && y < i32(fny) && diagDiv[foff + u32(y) * fnx + u32(x)].x > 0.0;
}

// Galerkin coarse operator for piecewise-constant transfer over 2 x 2 blocks: couplings are summed over the fine
// faces between two blocks, the diagonal is the children's diagonals minus twice the couplings inside the block.
fn buildCell(fnx: u32, fny: u32, foff: u32, cnx: u32, coff: u32, cx: u32, cy: u32) {
  var cl = 0.0;
  var cr = 0.0;
  var cb = 0.0;
  var ct = 0.0;
  var d = 0.0;
  var childDiag = 0.0;
  for (var dy = 0u; dy < 2u; dy++) {
    for (var dx = 0u; dx < 2u; dx++) {
      let x = i32(2u * cx + dx);
      let y = i32(2u * cy + dy);
      if (!fineActive(fnx, fny, foff, x, y)) { continue; }
      let c = foff + u32(y) * fnx + u32(x);
      let w = weights[c];
      let diagonal = diagDiv[c].x;
      d += diagonal;
      childDiag += diagonal;
      if (fineActive(fnx, fny, foff, x - 1, y)) { if (dx == 1u) { d -= w.x; } else { cl += w.x; } }
      if (fineActive(fnx, fny, foff, x + 1, y)) { if (dx == 0u) { d -= w.y; } else { cr += w.y; } }
      if (fineActive(fnx, fny, foff, x, y - 1)) { if (dy == 1u) { d -= w.z; } else { cb += w.z; } }
      if (fineActive(fnx, fny, foff, x, y + 1)) { if (dy == 0u) { d -= w.w; } else { ct += w.w; } }
    }
  }
  let c = coff + cy * cnx + cx;
  weights[c] = vec4f(cl, cr, cb, ct);
  diagDiv[c] = vec2f(select(0.0, d, d > SEALED_DIAGONAL * childDiag), 0.0);
  lp[c] = 0.0;
}

// ---- One level per dispatch (the levels too large for the tail cycle). Level sizes and offsets are pipeline constants. ----

override NX: u32 = 1u;
override NY: u32 = 1u;
override OFF: u32 = 0u;
override COLOR: u32 = 0u;
override FNX: u32 = 1u;
override FNY: u32 = 1u;
override FOFF: u32 = 0u;
override CNX: u32 = 1u;
override CNY: u32 = 1u;
override COFF: u32 = 0u;

@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn smoothLevel(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= NX || gid.y >= NY || ((gid.x + gid.y) & 1u) != COLOR) { return; }
  smoothCell(NX, NY, OFF, gid.x, gid.y);
}

// Thread per coarse cell.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn buildLevel(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= CNX || gid.y >= CNY) { return; }
  buildCell(FNX, FNY, FOFF, CNX, COFF, gid.x, gid.y);
}

// Thread per coarse cell.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn restrictLevel(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= CNX || gid.y >= CNY) { return; }
  restrictCell(FNX, FNY, FOFF, CNX, COFF, gid.x, gid.y);
}

// Thread per fine cell.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn prolongLevel(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FNX || gid.y >= FNY) { return; }
  prolongCell(FNX, FOFF, CNX, COFF, gid.x, gid.y);
}

// ---- The tail: the small levels, cycled by one workgroup. Every phase is a loop over the level's cells with a fixed
// trip count (so the barrier after it is in uniform control flow) and ends with a barrier. ----

fn syncAll() {
  storageBarrier();
  workgroupBarrier();
}

fn smoothAll(nx: u32, ny: u32, off: u32, color: u32, lid: u32) {
  for (var base = 0u; base < nx * ny; base += TAIL_THREADS) {
    let i = base + lid;
    if (i < nx * ny) {
      let x = i % nx;
      let y = i / nx;
      if (((x + y) & 1u) == color) { smoothCell(nx, ny, off, x, y); }
    }
  }
  syncAll();
}

fn restrictAll(fnx: u32, fny: u32, foff: u32, cnx: u32, cny: u32, coff: u32, lid: u32) {
  for (var base = 0u; base < cnx * cny; base += TAIL_THREADS) {
    let i = base + lid;
    if (i < cnx * cny) { restrictCell(fnx, fny, foff, cnx, coff, i % cnx, i / cnx); }
  }
  syncAll();
}

fn prolongAll(fnx: u32, fny: u32, foff: u32, cnx: u32, coff: u32, lid: u32) {
  for (var base = 0u; base < fnx * fny; base += TAIL_THREADS) {
    let i = base + lid;
    if (i < fnx * fny) { prolongCell(fnx, foff, cnx, coff, i % fnx, i / fnx); }
  }
  syncAll();
}

fn buildAll(fnx: u32, fny: u32, foff: u32, cnx: u32, cny: u32, coff: u32, lid: u32) {
  for (var base = 0u; base < cnx * cny; base += TAIL_THREADS) {
    let i = base + lid;
    if (i < cnx * cny) { buildCell(fnx, fny, foff, cnx, coff, i % cnx, i / cnx); }
  }
  syncAll();
}

@compute @workgroup_size(${TAIL_THREADS})
fn tailCycle(@builtin(local_invocation_index) lid: u32) {
${tailCycleBody(tail)}
}

@compute @workgroup_size(${TAIL_THREADS})
fn tailBuild(@builtin(local_invocation_index) lid: u32) {
${tailBuildBody(tail)}
}

// ---- Conjugate gradients on the fluid grid (level 0). ----

var<workgroup> reduction: array<f32, ${GRID_WORKGROUP * GRID_WORKGROUP}>;

// Sums one value per thread of a grid workgroup into its slot of \`partials\`. Called by every thread of the workgroup.
fn reducePartial(value: f32, lid: u32, wid: vec3u) {
  reduction[lid] = value;
  workgroupBarrier();
  for (var s = ${GRID_WORKGROUP * GRID_WORKGROUP / 2}u; s > 0u; s >>= 1u) {
    if (lid < s) { reduction[lid] += reduction[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { partials[wid.y * GRID_GROUPS_X + wid.x] = reduction[0]; }
}

// -rhs_precond = -div of the preconditioner system is the negated CG residual: r = rhs - A p, stored as -r in diagDiv.y.
// Writes it for the current pressure, and clears the preconditioner's solution.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgInit(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  lp[c] = 0.0;
  let diagonal = diagDiv[c].x;
  if (diagonal == 0.0) {
    diagDiv[c].y = 0.0;
    return;
  }
  let w = weights[c];
  var sum = 0.0;
  if (gid.x > 0u) { sum += w.x * p[c - 1u]; }
  if (gid.x + 1u < W) { sum += w.y * p[c + 1u]; }
  if (gid.y > 0u) { sum += w.z * p[c - W]; }
  if (gid.y + 1u < H) { sum += w.w * p[c + W]; }
  diagDiv[c].y = divergence[c] + diagonal * p[c] - sum;
}

// First search direction d = z, and the partial sums of r . z.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgDotInit(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
) {
  var value = 0.0;
  if (gid.x < W && gid.y < H) {
    let c = cellIndex(gid.x, gid.y);
    let z = lp[c];
    cgD[c] = z;
    value = -diagDiv[c].y * z;
  }
  reducePartial(value, lid, wid);
}

// q = A d over the liquid cells, and the partial sums of d . q. Air and inactive neighbors hold d = 0.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgMultiply(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
) {
  var value = 0.0;
  if (gid.x < W && gid.y < H) {
    let c = cellIndex(gid.x, gid.y);
    let diagonal = diagDiv[c].x;
    var q = 0.0;
    if (diagonal != 0.0) {
      let w = weights[c];
      var sum = 0.0;
      if (gid.x > 0u) { sum += w.x * cgD[c - 1u]; }
      if (gid.x + 1u < W) { sum += w.y * cgD[c + 1u]; }
      if (gid.y > 0u) { sum += w.z * cgD[c - W]; }
      if (gid.y + 1u < H) { sum += w.w * cgD[c + W]; }
      q = diagonal * cgD[c] - sum;
      value = cgD[c] * q;
    }
    cgQ[c] = q;
  }
  reducePartial(value, lid, wid);
}

// p += alpha d and r -= alpha q (stored negated, so it grows), and clears the solution of the next preconditioner cycle.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgUpdate(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  let alpha = scalars[1];
  p[c] += alpha * cgD[c];
  diagDiv[c].y += alpha * cgQ[c];
  lp[c] = 0.0;
}

// Partial sums of r . z after a preconditioner cycle.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgDot(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3u,
) {
  var value = 0.0;
  if (gid.x < W && gid.y < H) {
    let c = cellIndex(gid.x, gid.y);
    value = -diagDiv[c].y * lp[c];
  }
  reducePartial(value, lid, wid);
}

// d = z + beta d.
@compute @workgroup_size(${GRID_WORKGROUP}, ${GRID_WORKGROUP})
fn cgDirection(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= W || gid.y >= H) { return; }
  let c = cellIndex(gid.x, gid.y);
  cgD[c] = lp[c] + scalars[2] * cgD[c];
}

var<workgroup> sums: array<f32, ${TAIL_THREADS}>;

// Total of the workgroup partials, the same on every thread. The sum order is fixed, so the result is reproducible.
fn sumPartials(lid: u32) -> f32 {
  var total = 0.0;
  for (var i = lid; i < PARTIALS; i += TAIL_THREADS) { total += partials[i]; }
  sums[lid] = total;
  workgroupBarrier();
  for (var s = ${TAIL_THREADS / 2}u; s > 0u; s >>= 1u) {
    if (lid < s) { sums[lid] += sums[lid + s]; }
    workgroupBarrier();
  }
  let result = sums[0];
  workgroupBarrier();
  return result;
}

// rz = r . z of the first search direction.
@compute @workgroup_size(${TAIL_THREADS})
fn scalarInit(@builtin(local_invocation_index) lid: u32) {
  let rz = sumPartials(lid);
  if (lid == 0u) { scalars[0] = rz; }
}

// alpha = r . z / d . q; zero (no step) when r . z is down to rounding noise or d . q is not positive. The CPU loop
// stops there; here the next iteration still runs, and takes a step only if its own alpha is positive.
@compute @workgroup_size(${TAIL_THREADS})
fn scalarAlpha(@builtin(local_invocation_index) lid: u32) {
  let dq = sumPartials(lid);
  if (lid == 0u) {
    let rz = scalars[0];
    scalars[1] = select(0.0, rz / dq, rz > CG_FLOOR && dq > 0.0);
  }
}

// beta = (r . z)_new / (r . z)_old, and the new r . z becomes the current one.
@compute @workgroup_size(${TAIL_THREADS})
fn scalarBeta(@builtin(local_invocation_index) lid: u32) {
  let next = sumPartials(lid);
  if (lid == 0u) {
    let rz = scalars[0];
    scalars[2] = select(0.0, next / rz, rz > CG_FLOOR);
    scalars[0] = next;
  }
}
`;
