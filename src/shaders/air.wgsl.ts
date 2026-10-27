import { airConstantsWGSL } from '../air';
import { ROOM_TEMP } from '../heat';
import type { ElementDef } from '../elements';
import { wgslFloat } from '../movement';
import { cellBindingsWGSL, cellTypesWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// The air passes (docs/plans/m6-air.md, "The air grid"). The air is a staggered grid of `S x S` cells: per air cell, one
// vec4f holds the speed of the air through its right face (x) and its top face (y), its pressure at the center (z) and
// its temperature in degrees (w).
//
// The arrays have one more column and row than there are air cells. Array position (a, b) holds air cell (a - 1, b - 1),
// so column 0 and row 0 are ghost cells: their pressure is 0 and their temperature room temperature for good, and their
// faces are the left and bottom faces of the first real cells, the edge of the world. Beyond the right and top edge the
// ghost air is read as pressure 0 and room temperature. The edge faces carry no pressure gradient: the air through them
// leaves at the speed a wave of that pressure travels at, which lets a wave out without an echo.
//
// A face is closed by solid cells: the mask pass stores each face's openness, the share of the rows (columns) of grid
// cells between the centers of its two air cells that hold no solid cell, and `faceGate` turns it into the factor the
// face's speed is multiplied by.

const prelude = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${airConstantsWGSL(cellSize, substeps)}
const W: i32 = ${width};
const H: i32 = ${height};
// Air cells across and up.
const NX: i32 = ${nx};
const NY: i32 = ${ny};
// Array columns and rows.
const AW: i32 = ${nx + 1};
const AH: i32 = ${ny + 1};
const ROOM: f32 = ${wgslFloat(ROOM_TEMP)};

@group(0) @binding(0) var<storage, read_write> air: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> scratch: array<vec4f>;
// Openness of the right face (x) and the top face (y), the share of powder and liquid cells (z), the count of cells that hold heat (w).
@group(0) @binding(2) var<storage, read_write> mask: array<vec4f>;
// Pressure released into an air cell by the CA, in 1 / BURST_SCALE units.
@group(0) @binding(3) var<storage, read_write> burst: array<atomic<i32>>;

fn at(a: i32, b: i32) -> u32 { return u32(b * AW + a); }
fn inArray(a: i32, b: i32) -> bool { return a >= 0 && a < AW && b >= 0 && b < AH; }
fn isCell(a: i32, b: i32) -> bool { return a >= 1 && a <= NX && b >= 1 && b <= NY; }

// The factor a face's speed is multiplied by. A wall of one cell, whatever its angle, closes at least half the rows of
// the faces it crosses and leaves the two faces on the way across the wall's air cell with openness summing to 1, so
// that at most one of them is above one half: scaling openness from [1/2, 1] to [0, 1] closes the other and so every
// path through the wall. A face that is open on at least half its rows stays a passage.
fn faceGate(openness: f32) -> f32 { return max(0.0, 2.0 * openness - 1.0); }

// The speed of the air through the right face of (a, b), and through its top face; 0 beyond the array.
fn uAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return air[at(a, b)].x; }
fn vAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return air[at(a, b)].y; }
// The temperature above room temperature, 0 beyond the array.
fn heatAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return air[at(a, b)].w - ROOM; }
fn pressureAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return air[at(a, b)].z; }
`;

const GROUP = 'let a = i32(gid.x);\n  let b = i32(gid.y);\n  if (a >= AW || b >= AH) { return; }';
const ENTRY = '@compute @workgroup_size(8, 8)\nfn main(@builtin(global_invocation_id) gid: vec3u)';

/** The mask pass: openness of each face, matter share and heat holders of each air cell, from the cells' kinds. */
export const airMaskWGSL = (elements: readonly ElementDef[], width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${cellTypesWGSL(elements)}
${cellBindingsWGSL('read', ['kind'])}
${elementsWGSL}
${prelude(width, height, cellSize, substeps, nx, ny)}

fn solidAt(x: i32, y: i32) -> bool {
  if (x < 0 || x >= W || y < 0 || y >= H) { return false; }
  return elState(loadKind(u32(y * W + x)) & 0xffu) == ST_SOLID;
}

// The share of rows [y0, y0 + S) with no solid cell in columns [x0, x1); rows and columns outside the grid are open.
fn openRows(x0: i32, x1: i32, y0: i32) -> f32 {
  var open = 0;
  for (var y = y0; y < y0 + S; y++) {
    var closed = false;
    for (var x = x0; x < x1; x++) {
      if (solidAt(x, y)) { closed = true; break; }
    }
    if (!closed) { open++; }
  }
  return f32(open) / f32(S);
}

// The same for the columns [x0, x0 + S) and the rows [y0, y1).
fn openColumns(x0: i32, y0: i32, y1: i32) -> f32 {
  var open = 0;
  for (var x = x0; x < x0 + S; x++) {
    var closed = false;
    for (var y = y0; y < y1; y++) {
      if (solidAt(x, y)) { closed = true; break; }
    }
    if (!closed) { open++; }
  }
  return f32(open) / f32(S);
}

${ENTRY} {
  ${GROUP}
  let i = a - 1;
  let j = b - 1;
  // The span between the centers of this air cell and the next: from the middle of this one to the middle of the next,
  // rounded outwards (for one-cell air cells that takes in both cells).
  let spanX0 = i * S + S / 2;
  let spanX1 = i * S + S + (S + 1) / 2;
  let spanY0 = j * S + S / 2;
  let spanY1 = j * S + S + (S + 1) / 2;

  var matter = 0;
  var heat = 0;
  for (var y = j * S; y < j * S + S; y++) {
    for (var x = i * S; x < i * S + S; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) { continue; }
      let t = loadKind(u32(y * W + x)) & 0xffu;
      let s = elState(t);
      if (s == ST_POWDER || s == ST_LIQUID) { matter++; }
      if (elHoldsHeat(t)) { heat++; }
    }
  }
  mask[at(a, b)] = vec4f(openRows(spanX0, spanX1, j * S), openColumns(i * S, spanY0, spanY1), f32(matter) / f32(S * S), f32(heat));
}
`;

/** Adds the bursts the CA released to the pressure and clears them. */
export const airCouplingWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

${ENTRY} {
  ${GROUP}
  let k = at(a, b);
  if (atomicLoad(&burst[k]) == 0) { return; }
  let released = atomicExchange(&burst[k], 0);
  if (isCell(a, b)) { air[k].z += f32(released) / BURST_SCALE; }
}
`;

/**
 * The speed of every face: the pressure difference across it accelerates the air, friction slows it, the edge ring is
 * damped, the speed is capped and a closed face is held at 0. The edge faces let the air out at the speed a wave of the
 * pressure inside travels at. Writes only speeds and reads only pressures, so it runs in place.
 */
export const airVelocityWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

${ENTRY} {
  ${GROUP}
  let k = at(a, b);
  let m = mask[k];
  let ring = a == 1 || a == NX || b == 1 || b == NY;
  var edge = 1.0;
  if (ring) { edge = KEEP_EDGE; }

  // The right face of cell (a, b); the ghost row has none.
  if (b >= 1) {
    if (a == 0) {
      air[k].x = (0.0 - WAVE_SPEED * air[at(1, b)].z) * faceGate(m.x);
    } else if (a == NX) {
      air[k].x = (WAVE_SPEED * air[k].z) * faceGate(m.x);
    } else if (a < NX) {
      let u = (air[k].x - GRADIENT * (air[at(a + 1, b)].z - air[k].z)) * KEEP_VELOCITY * edge;
      air[k].x = clamp(u, -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.x);
    }
  }
  // The top face; the ghost column has none.
  if (a >= 1) {
    if (b == 0) {
      air[k].y = (0.0 - WAVE_SPEED * air[at(a, 1)].z) * faceGate(m.y);
    } else if (b == NY) {
      air[k].y = (WAVE_SPEED * air[k].z) * faceGate(m.y);
    } else if (b < NY) {
      let v = (air[k].y - GRADIENT * (air[at(a, b + 1)].z - air[k].z)) * KEEP_VELOCITY * edge;
      air[k].y = clamp(v, -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.y);
    }
  }
}
`;

/** The pressure of every air cell: what flows in through its faces raises it, what flows out lowers it. In place. */
export const airPressureWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

${ENTRY} {
  ${GROUP}
  if (!isCell(a, b)) { return; }
  let k = at(a, b);
  let flow = (air[k].x - air[at(a - 1, b)].x) + (air[k].y - air[at(a, b - 1)].y);
  var p = (air[k].z - DIVERGENCE * flow) * KEEP_PRESSURE;
  if (a == 1 || a == NX || b == 1 || b == NY) { p *= KEEP_EDGE; }
  air[k].z = p;
}
`;

/**
 * Carries the air along with itself, state to scratch: the speeds by semi-Lagrangian advection (each face takes the
 * speed from where its air came from), the temperature in flux form (what leaves one cell enters the next, so the heat
 * is kept), the pressure unchanged. A closed face stays closed.
 */
export const airAdvectWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

// Bilinear samples of the two speed fields at a point in air cells; the right faces sit at (a + 1, b + 1/2), the top
// faces at (a + 1/2, b + 1).
fn sampleU(x: f32, y: f32) -> f32 {
  let fx = x - 1.0;
  let fy = y - 0.5;
  let a = i32(floor(fx));
  let b = i32(floor(fy));
  let tx = fx - f32(a);
  let ty = fy - f32(b);
  return mix(mix(uAt(a, b), uAt(a + 1, b), tx), mix(uAt(a, b + 1), uAt(a + 1, b + 1), tx), ty);
}

fn sampleV(x: f32, y: f32) -> f32 {
  let fx = x - 0.5;
  let fy = y - 1.0;
  let a = i32(floor(fx));
  let b = i32(floor(fy));
  let tx = fx - f32(a);
  let ty = fy - f32(b);
  return mix(mix(vAt(a, b), vAt(a + 1, b), tx), mix(vAt(a, b + 1), vAt(a + 1, b + 1), tx), ty);
}

// The speed a face moves heat at: the air's, up to the cap that keeps a cell from giving away more than it holds.
fn flux(speed: f32) -> f32 { return clamp(speed, -FLUX_CAP, FLUX_CAP); }

${ENTRY} {
  ${GROUP}
  let k = at(a, b);
  let s = air[k];
  let m = mask[k];
  var out = s;

  if (b >= 1 && a >= 1 && a < NX) {
    let x = f32(a) + 1.0;
    let y = f32(b) + 0.5;
    let across = sampleV(x, y);
    out.x = sampleU(x - s.x * ADVECT, y - across * ADVECT) * faceGate(m.x);
  }
  if (a >= 1 && b >= 1 && b < NY) {
    let x = f32(a) + 0.5;
    let y = f32(b) + 1.0;
    let across = sampleU(x, y);
    out.y = sampleV(x - across * ADVECT, y - s.y * ADVECT) * faceGate(m.y);
  }

  if (isCell(a, b)) {
    let heat = s.w - ROOM;
    let right = flux(s.x);
    let left = flux(uAt(a - 1, b));
    let top = flux(s.y);
    let bottom = flux(vAt(a, b - 1));
    var heatRight = heatAt(a + 1, b);
    if (right > 0.0) { heatRight = heat; }
    var heatLeft = heat;
    if (left > 0.0) { heatLeft = heatAt(a - 1, b); }
    var heatTop = heatAt(a, b + 1);
    if (top > 0.0) { heatTop = heat; }
    var heatBottom = heat;
    if (bottom > 0.0) { heatBottom = heatAt(a, b - 1); }
    let net = (right * heatRight - left * heatLeft) + (top * heatTop - bottom * heatBottom);
    out.w = ROOM + (heat - ADVECT * net);
  }
  scratch[k] = out;
}
`;

/** Spreads the temperature across the open faces, scratch to state; also moves the speeds and pressures back. */
export const airDiffuseWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

fn scratchHeat(a: i32, b: i32) -> f32 {
  if (!inArray(a, b)) { return 0.0; }
  return scratch[at(a, b)].w - ROOM;
}

${ENTRY} {
  ${GROUP}
  let k = at(a, b);
  var out = scratch[k];
  if (isCell(a, b)) {
    let heat = out.w - ROOM;
    let toRight = faceGate(mask[k].x) * (scratchHeat(a + 1, b) - heat);
    let toLeft = faceGate(mask[at(a - 1, b)].x) * (scratchHeat(a - 1, b) - heat);
    let toTop = faceGate(mask[k].y) * (scratchHeat(a, b + 1) - heat);
    let toBottom = faceGate(mask[at(a, b - 1)].y) * (scratchHeat(a, b - 1) - heat);
    out.w = ROOM + (heat + DIFFUSION * ((toRight + toLeft) + (toTop + toBottom)));
  }
  air[k] = out;
}
`;
