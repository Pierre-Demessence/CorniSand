// Lightweight pressure diffusion for liquid cells.
// Spreads pressure across connected liquid, decays over time.
// Velocity is also lightly diffused to create coherent flow.
export const pressureWGSL = /* wgsl */`

struct Cell {
  pType: u32,
  variant: f32,
  lifetime: f32,
  pressure: f32,
  velocityX: f32,
  velocityY: f32,
  _pad0: f32,
  _pad1: f32,
};

struct FluidUniforms {
  resolution: vec2f,
  dt: f32,
  _pad: f32,
};

@group(0) @binding(0) var<storage, read> inputCells: array<Cell>;
@group(0) @binding(1) var<storage, read_write> outputCells: array<Cell>;
@group(0) @binding(2) var<uniform> fu: FluidUniforms;

const TYPE_WATER: u32 = 3u;
const TYPE_OIL: u32   = 5u;

const DIFFUSION_RATE: f32 = 0.25;
const PRESSURE_DECAY: f32 = 0.92;
const VELOCITY_DIFFUSION: f32 = 0.1;
const VELOCITY_DECAY: f32 = 0.96;

fn isLiquid(t: u32) -> bool { return t == TYPE_WATER || t == TYPE_OIL; }

fn cellIdx(x: i32, y: i32) -> u32 {
  return u32(y) * u32(fu.resolution.x) + u32(x);
}

fn readCell(x: i32, y: i32) -> Cell {
  let w = i32(fu.resolution.x);
  let h = i32(fu.resolution.y);
  if (x < 0 || x >= w || y < 0 || y >= h) {
    return Cell(2u, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  }
  return inputCells[cellIdx(x, y)];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  let w = i32(fu.resolution.x);
  let h = i32(fu.resolution.y);
  if (pos.x >= w || pos.y >= h) { return; }

  let idx = cellIdx(pos.x, pos.y);
  let current = inputCells[idx];

  // Non-liquid cells: pass through, zero out their pressure/velocity
  if (!isLiquid(current.pType)) {
    var result = current;
    result.pressure *= 0.5;
    result.velocityX *= 0.5;
    result.velocityY *= 0.5;
    outputCells[idx] = result;
    return;
  }

  let cellR = readCell(pos.x + 1, pos.y);
  let cellL = readCell(pos.x - 1, pos.y);
  let cellU = readCell(pos.x, pos.y + 1);
  let cellD = readCell(pos.x, pos.y - 1);

  let liquidR = isLiquid(cellR.pType);
  let liquidL = isLiquid(cellL.pType);
  let liquidU = isLiquid(cellU.pType);
  let liquidD = isLiquid(cellD.pType);

  // Count neighboring liquid cells
  let nCount = select(0.0, 1.0, liquidR)
             + select(0.0, 1.0, liquidL)
             + select(0.0, 1.0, liquidU)
             + select(0.0, 1.0, liquidD);

  // Average neighbor pressure (only liquid neighbors)
  var avgP: f32 = 0.0;
  if (liquidR) { avgP += cellR.pressure; }
  if (liquidL) { avgP += cellL.pressure; }
  if (liquidU) { avgP += cellU.pressure; }
  if (liquidD) { avgP += cellD.pressure; }
  if (nCount > 0.0) { avgP /= nCount; }

  // Diffuse pressure toward neighbor average, then decay
  let newPressure = mix(current.pressure, avgP, DIFFUSION_RATE) * PRESSURE_DECAY;

  // Lightly diffuse velocity for coherent flow
  var avgVx: f32 = 0.0;
  var avgVy: f32 = 0.0;
  if (liquidR) { avgVx += cellR.velocityX; avgVy += cellR.velocityY; }
  if (liquidL) { avgVx += cellL.velocityX; avgVy += cellL.velocityY; }
  if (liquidU) { avgVx += cellU.velocityX; avgVy += cellU.velocityY; }
  if (liquidD) { avgVx += cellD.velocityX; avgVy += cellD.velocityY; }
  if (nCount > 0.0) { avgVx /= nCount; avgVy /= nCount; }

  let newVx = mix(current.velocityX, avgVx, VELOCITY_DIFFUSION) * VELOCITY_DECAY;
  let newVy = mix(current.velocityY, avgVy, VELOCITY_DIFFUSION) * VELOCITY_DECAY;

  var result = current;
  result.pressure = newPressure;
  result.velocityX = newVx;
  result.velocityY = newVy;
  outputCells[idx] = result;
}
`;
