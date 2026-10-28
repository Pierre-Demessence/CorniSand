import { AIR, airConstantsWGSL, type AirShape } from '../air';
import { ROOM_TEMP } from '../heat';
import type { ElementDef } from '../elements';
import { wgslFloat } from '../movement';
import { cellBindingsWGSL, cellTypesWGSL } from './cell.wgsl';
import { elementsWGSL } from './elements.wgsl';

// The air passes (`docs/simulation.md`, "Air"). The air is a staggered grid of `S x S` cells: per air cell, one
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

/**
 * Reads of an air state array named `array` (needs the constants `AW` and `AH`): the index of an array position, the
 * speed through the right and top faces and the pressure of one (0 beyond the array), and bilinear samples at a point.
 * Points are in air cells counted from the ghost column and row (grid cell x is at x / S + 1), so the right faces of
 * array column a sit at x = a + 1 and the top faces of row b at y = b + 1. Shared by the air passes and by every pass
 * that reads the air (the CA, the flight pass, the display).
 */
export const airSamplersWGSL = (array: string): string => /* wgsl */`
fn airIndex(a: i32, b: i32) -> u32 { return u32(b * AW + a); }
fn inArray(a: i32, b: i32) -> bool { return a >= 0 && a < AW && b >= 0 && b < AH; }

// The speed of the air through the right face of (a, b), and through its top face; 0 beyond the array.
fn uAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return ${array}[airIndex(a, b)].x; }
fn vAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return ${array}[airIndex(a, b)].y; }
fn pressureAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return ${array}[airIndex(a, b)].z; }

// The pressure difference across the right face of (a, b), and across its top face: what accelerates the air there. The
// faces on the world's edge (the left faces of column 0's cells, the right faces of the last column, likewise rows) carry
// none: the air through them leaves at the speed of a wave, as the velocity pass has it, and matter must not be pushed by
// the pressure beside the edge against the ghost air beyond it.
fn dpxAt(a: i32, b: i32) -> f32 {
  if (a <= 0 || a >= AW - 1) { return 0.0; }
  return pressureAt(a + 1, b) - pressureAt(a, b);
}
fn dpyAt(a: i32, b: i32) -> f32 {
  if (b <= 0 || b >= AH - 1) { return 0.0; }
  return pressureAt(a, b + 1) - pressureAt(a, b);
}

// Bilinear samples at a point of the two speed fields; the right faces sit at (a + 1, b + 1/2), the top faces at
// (a + 1/2, b + 1).
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

// The pressure gradient at a point, per air cell: the pressure differences across the faces, sampled like the speeds.
fn sampleGradient(x: f32, y: f32) -> vec2f {
  var g = vec2f(0.0);
  {
    let fx = x - 1.0;
    let fy = y - 0.5;
    let a = i32(floor(fx));
    let b = i32(floor(fy));
    let tx = fx - f32(a);
    let ty = fy - f32(b);
    g.x = mix(mix(dpxAt(a, b), dpxAt(a + 1, b), tx), mix(dpxAt(a, b + 1), dpxAt(a + 1, b + 1), tx), ty);
  }
  {
    let fx = x - 0.5;
    let fy = y - 1.0;
    let a = i32(floor(fx));
    let b = i32(floor(fy));
    let tx = fx - f32(a);
    let ty = fy - f32(b);
    g.y = mix(mix(dpyAt(a, b), dpyAt(a + 1, b), tx), mix(dpyAt(a, b + 1), dpyAt(a + 1, b + 1), tx), ty);
  }
  return g;
}
`;

/**
 * What the CA reads of the air (group 3, binding 1, read-only): the air state and the sampling of it at a grid point.
 * `airAround` returns the air's velocity there, in grid cells per dispatch, and the pressure gradient, per grid cell.
 * The air state changes only in the air passes, between CA dispatches, so a block may read it outside its own cells.
 */
export const airReadWGSL = (shape: AirShape): string => /* wgsl */`
// Array columns and rows: one more than the air cells (the ghost column and row).
const AW: i32 = ${shape.columns + 1};
const AH: i32 = ${shape.rows + 1};
const AIR_S: f32 = ${wgslFloat(shape.cellSize)};
const AIR_PUSH: f32 = ${wgslFloat(AIR.push)};
@group(3) @binding(1) var<storage, read> airState: array<vec4f>;
${airSamplersWGSL('airState')}

struct AirAround {
  velocity: vec2f,
  gradient: vec2f,
};

fn airAround(x: f32, y: f32) -> AirAround {
  let px = x / AIR_S + 1.0;
  let py = y / AIR_S + 1.0;
  return AirAround(vec2f(sampleU(px, py), sampleV(px, py)), sampleGradient(px, py) / AIR_S);
}
`;

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

${airSamplersWGSL('air')}
fn isCell(a: i32, b: i32) -> bool { return a >= 1 && a <= NX && b >= 1 && b <= NY; }

// The pressure of array position (a, b) with the burst the CA released into it added: the pressure pass stores the sum.
fn pressureNow(a: i32, b: i32) -> f32 {
  let k = airIndex(a, b);
  var p = air[k].z;
  if (isCell(a, b)) { p += f32(atomicLoad(&burst[k])) / BURST_SCALE; }
  return p;
}

// The factor a face's speed is multiplied by. A wall of one cell, whatever its angle, closes at least half the rows of
// the faces it crosses and leaves the two faces on the way across the wall's air cell with openness summing to 1, so
// that at most one of them is above one half: scaling openness from [1/2, 1] to [0, 1] closes the other and so every
// path through the wall. A face that is open on at least half its rows stays a passage.
fn faceGate(openness: f32) -> f32 { return max(0.0, 2.0 * openness - 1.0); }

// The factor the speed of a face is multiplied by for the powder and liquid in the air cells it joins (their mean share).
fn matterKeep(share: f32) -> f32 { return 1.0 - share * (1.0 - KEEP_MATTER); }

// The temperature above room temperature, 0 beyond the array.
fn heatAt(a: i32, b: i32) -> f32 { if (!inArray(a, b)) { return 0.0; } return air[airIndex(a, b)].w - ROOM; }
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
  mask[airIndex(a, b)] = vec4f(openRows(spanX0, spanX1, j * S), openColumns(i * S, spanY0, spanY1), f32(matter) / f32(S * S), f32(heat));
}
`;

/**
 * The exchange pass, one thread per air cell, once per call to `simulate` (the air steps of the call are folded into it):
 * exchanges heat between the air cell and the cells that hold heat and belong to it, one after the other in row-major
 * order (every cell at its own turn sees the air as the cells before it left it, so the exchange conserves heat and
 * never overshoots). A powder or liquid moving at `AIR.stillSpeed` or faster takes no part, as a flyer. A pair that
 * would exchange `g` of its difference at each of `steps` air steps exchanges `1 - (1 - g)^steps` at once, what the
 * steps would leave of it if the air stood still between them. A cell that is not solid belongs to the air cell it is
 * in. A solid cell belongs to the air cell of its first neighbor (up, left, right, down) that is empty space, a gas or
 * fire: the air cells inside a block of metal are closed off, and its surface must reach the open air next to it. A
 * solid with no such neighbor belongs to none and a cell on the grid's edge counts the outside as no neighbor. The
 * thread reads the one-cell ring around its cells to find the solids that belong to it, so no cell belongs to two
 * threads. Cells hold their temperature in `temp`, which this pass writes; it runs before the CA dispatches, so nothing
 * else touches it.
 */
export const airExchangeWGSL = (elements: readonly ElementDef[], width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${cellTypesWGSL(elements)}
${cellBindingsWGSL('read_write', ['kind', 'velocity', 'temp'])}
${elementsWGSL}
${prelude(width, height, cellSize, substeps, nx, ny)}

const NONE: u32 = 0xffffffffu;

// The number of air steps this call folds into the exchange.
struct Exchange {
  steps: f32,
};
@group(3) @binding(0) var<uniform> exchange: Exchange;

fn inGrid(x: i32, y: i32) -> bool { return x >= 0 && x < W && y >= 0 && y < H; }
fn kindAt(x: i32, y: i32) -> u32 { return loadKind(u32(y * W + x)) & 0xffu; }
// The array position of the air cell over grid cell (x, y).
fn airOver(x: i32, y: i32) -> u32 { return airIndex(x / S + 1, y / S + 1); }

fn opensToAir(x: i32, y: i32) -> bool {
  if (!inGrid(x, y)) { return false; }
  let s = elState(kindAt(x, y));
  return s == ST_EMPTY || s == ST_GAS || s == ST_PLASMA;
}

// The array position of the air cell the heat-holding cell (x, y) of element t exchanges with, or NONE.
fn airOf(x: i32, y: i32, t: u32) -> u32 {
  if (elState(t) != ST_SOLID) { return airOver(x, y); }
  if (opensToAir(x, y + 1)) { return airOver(x, y + 1); }
  if (opensToAir(x - 1, y)) { return airOver(x - 1, y); }
  if (opensToAir(x + 1, y)) { return airOver(x + 1, y); }
  if (opensToAir(x, y - 1)) { return airOver(x, y - 1); }
  return NONE;
}

${ENTRY} {
  ${GROUP}
  let k = airIndex(a, b);
  if (!isCell(a, b)) { return; }

  var airTemp = air[k].w;
  let x0 = (a - 1) * S;
  let y0 = (b - 1) * S;
  for (var y = y0 - 1; y <= y0 + S; y++) {
    for (var x = x0 - 1; x <= x0 + S; x++) {
      let insideX = x >= x0 && x < x0 + S;
      let insideY = y >= y0 && y < y0 + S;
      // The ring's corners touch this air cell only diagonally.
      if (!insideX && !insideY) { continue; }
      if (!inGrid(x, y)) { continue; }
      let i = u32(y * W + x);
      let t = loadKind(i) & 0xffu;
      if (!elHoldsHeat(t)) { continue; }
      // A falling cell keeps its heat until it slows down (\`AIR.stillSpeed\`).
      if (length(unpack2x16float(field_velocity[i])) >= STILL_SPEED) { continue; }
      let inside = insideX && insideY;
      if (!inside && elState(t) != ST_SOLID) { continue; }
      if (airOf(x, y, t) != k) { continue; }
      // The pair's exchange, as \`exchangeHeat\`: the cell's temperature is its stored one clamped to its thresholds.
      let kc = elConductivity(t);
      if (kc <= 0.0) { continue; }
      let d = clamp(field_temp[i], elBelowTemp(t), elAboveTemp(t)) - airTemp;
      if (d == 0.0) { continue; }
      let c = elHeatCapacity(t);
      let g = 2.0 * kc * AIR_CONDUCTIVITY / (kc + AIR_CONDUCTIVITY);
      var share = g;
      if (exchange.steps > 1.0) { share = 1.0 - pow(1.0 - g, exchange.steps); }
      let flow = share * d / (c + AIR_CAPACITY);
      field_temp[i] -= flow * AIR_CAPACITY;
      airTemp += flow * c;
    }
  }
  air[k].w = airTemp;
}
`;

/** Floats in the Wind tool's uniform (`airWindWGSL`): prev (2), cur (2), velocity (2), radius, 1 pad = 32 bytes. */
export const WIND_UNIFORM_WORDS = 8;

/**
 * The Wind tool, one thread per air cell, once per frame after the mask pass and before the CA: every interior face whose
 * center lies within `radius` of the stroke's segment moves toward the stroke's velocity by `windToolBlend` of the gap
 * (the right faces toward its x, the top faces toward its y). A closed face stays at 0, so wind does not cross a wall.
 * Writes only the thread's own two speeds, so it runs in place. The edge faces are the open boundary's, as in the
 * velocity pass, and are left alone.
 */
export const airWindWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

struct Wind {
  prev: vec2f,
  cur: vec2f,
  velocity: vec2f,
  radius: f32,
  _pad: f32,
};
@group(1) @binding(0) var<uniform> wind: Wind;

const BLEND: f32 = ${wgslFloat(AIR.windToolBlend)};

// Whether the stroke along prev -> cur reaches the point (in grid cells).
fn reaches(pos: vec2f) -> bool {
  let ab = wind.cur - wind.prev;
  let segLen2 = dot(ab, ab);
  var t: f32 = 0.0;
  if (segLen2 > 0.001) {
    t = clamp(dot(pos - wind.prev, ab) / segLen2, 0.0, 1.0);
  }
  return length(pos - (wind.prev + t * ab)) <= wind.radius;
}

${ENTRY} {
  ${GROUP}
  let k = airIndex(a, b);
  let m = mask[k];
  // The right face of (a, b) sits on the right edge of the air cell, halfway up it; the top face on its top edge.
  if (b >= 1 && a >= 1 && a < NX && b <= NY) {
    if (reaches(vec2f(f32(a * S), f32((b - 1) * S) + 0.5 * f32(S)))) {
      air[k].x += (wind.velocity.x * faceGate(m.x) - air[k].x) * BLEND;
    }
  }
  if (a >= 1 && a <= NX && b >= 1 && b < NY) {
    if (reaches(vec2f(f32((a - 1) * S) + 0.5 * f32(S), f32(b * S)))) {
      air[k].y += (wind.velocity.y * faceGate(m.y) - air[k].y) * BLEND;
    }
  }
}
`;

/**
 * The speed of every face: the pressure difference across it accelerates the air (and, on a top face, the warmth of the
 * air makes it rise), friction slows it, the edge ring is damped, the speed is capped and a closed face is held at 0. The edge faces let the air out at the speed a wave of the
 * pressure inside travels at. Reads the pressures with the CA's pending bursts added. Writes only speeds and reads only pressures, so it runs in place.
 */
export const airVelocityWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

${ENTRY} {
  ${GROUP}
  let k = airIndex(a, b);
  let m = mask[k];
  let ring = a == 1 || a == NX || b == 1 || b == NY;
  var edge = 1.0;
  if (ring) { edge = KEEP_EDGE; }

  // The right face of cell (a, b); the ghost row has none.
  if (b >= 1) {
    if (a == 0) {
      air[k].x = clamp(0.0 - WAVE_SPEED * pressureNow(1, b), -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.x);
    } else if (a == NX) {
      air[k].x = clamp(WAVE_SPEED * pressureNow(a, b), -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.x);
    } else if (a < NX) {
      let u = (air[k].x - GRADIENT * (pressureNow(a + 1, b) - pressureNow(a, b))) * KEEP_VELOCITY * edge * matterKeep(0.5 * (m.z + mask[airIndex(a + 1, b)].z));
      air[k].x = clamp(u, -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.x);
    }
  }
  // The top face; the ghost column has none.
  if (a >= 1) {
    if (b == 0) {
      air[k].y = clamp(0.0 - WAVE_SPEED * pressureNow(a, 1), -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.y);
    } else if (b == NY) {
      air[k].y = clamp(WAVE_SPEED * pressureNow(a, b), -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.y);
    } else if (b < NY) {
      // Hot air rises: the face gains BUOYANCY per degree the mean of the two air cells it joins is above room temperature,
      // less the share of them that powder or liquid fills (the hot air in a pile or a pool is not free to rise).
      let matter = 0.5 * (m.z + mask[airIndex(a, b + 1)].z);
      let warmth = 0.5 * ((air[k].w - ROOM) + (air[airIndex(a, b + 1)].w - ROOM));
      let v = (air[k].y - GRADIENT * (pressureNow(a, b + 1) - pressureNow(a, b)) + BUOYANCY * warmth * (1.0 - matter)) * KEEP_VELOCITY * edge * matterKeep(matter);
      air[k].y = clamp(v, -MAX_AIR_SPEED, MAX_AIR_SPEED) * faceGate(m.y);
    }
  }
}
`;

/** The pressure of every air cell: the burst the CA released into it (cleared here) and what flows in through its faces raise it, what flows out lowers it. In place. */
export const airPressureWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

${ENTRY} {
  ${GROUP}
  if (!isCell(a, b)) { return; }
  let k = airIndex(a, b);
  let flow = (air[k].x - air[airIndex(a - 1, b)].x) + (air[k].y - air[airIndex(a, b - 1)].y);
  let released = atomicExchange(&burst[k], 0);
  var p = (air[k].z + f32(released) / BURST_SCALE - DIVERGENCE * flow) * KEEP_PRESSURE;
  if (a == 1 || a == NX || b == 1 || b == NY) { p *= KEEP_EDGE; }
  air[k].z = p;
}
`;

/**
 * Carries the air's heat along with the air, state to scratch: the temperature in flux form (what leaves one cell enters
 * the next, so the heat is kept). The speeds and pressures are copied unchanged: the air is a linear wave (the speeds
 * never advect themselves), the one model with no gain at any speed.
 */
export const airAdvectWGSL = (width: number, height: number, cellSize: number, substeps: number, nx: number, ny: number): string => /* wgsl */`
${prelude(width, height, cellSize, substeps, nx, ny)}

// The speed a face moves heat at: the air's, up to the cap that keeps a cell from giving away more than it holds.
fn flux(speed: f32) -> f32 { return clamp(speed, -FLUX_CAP, FLUX_CAP); }

${ENTRY} {
  ${GROUP}
  let k = airIndex(a, b);
  let s = air[k];
  var out = s;

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
  return scratch[airIndex(a, b)].w - ROOM;
}

${ENTRY} {
  ${GROUP}
  let k = airIndex(a, b);
  var out = scratch[k];
  if (isCell(a, b)) {
    let heat = out.w - ROOM;
    let toRight = faceGate(mask[k].x) * (scratchHeat(a + 1, b) - heat);
    let toLeft = faceGate(mask[airIndex(a - 1, b)].x) * (scratchHeat(a - 1, b) - heat);
    let toTop = faceGate(mask[k].y) * (scratchHeat(a, b + 1) - heat);
    let toBottom = faceGate(mask[airIndex(a, b - 1)].y) * (scratchHeat(a, b - 1) - heat);
    out.w = ROOM + (heat + DIFFUSION * ((toRight + toLeft) + (toTop + toBottom)));
  }
  air[k] = out;
}
`;
