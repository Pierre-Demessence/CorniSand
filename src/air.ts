import type { RampKnot } from './heat';
import { wgslFloat } from './movement';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from './physics';

/** The shape of the air grid a shader that reads it needs: grid cells per air cell and air cells across and up. */
export interface AirShape {
  cellSize: number;
  columns: number;
  rows: number;
}

// Constants of the air (`git log --all -- docs/plans/m6-air.md`). Units: grid cells and dispatches (one Margolus pass), not air cells, so
// the air cell size changes the detail of the air and not its speeds. Pressure is dimensionless, 0 is ambient (the
// ghost air beyond the grid's edge is at 0). y = 0 is the bottom row, as for the cells.
export const AIR = {
  // Speed of a pressure wave: the ring a pulse grows spreads at this many grid cells per dispatch.
  waveSpeed: 1,
  // The speed limit of the air at a face. A pulse of pressure p moves the air at about waveSpeed * p, so this also caps
  // what a blast can do to the air in one place.
  maxSpeed: 2,
  // Share of its pressure an air cell loses per dispatch: a burst in a sealed pocket decays at this rate.
  pressureLoss: 0.005,
  // Share of its speed a face loses per dispatch.
  velocityLoss: 0.005,
  // Extra share the pressure and velocity of the outermost ring of air cells lose per dispatch, on top of the open
  // boundary (which already lets a wave leave): it takes the echo of waves that arrive at a slant. Small: a thicker damped
  // ring reflects more, like a wall (the echo of AC4 grows with it).
  edgeDamping: 0.02,
  // Share of the temperature difference to a neighbor an air cell closes per dispatch, across a fully open face.
  diffusion: 0.02,
  // Surface coefficient in W/m²·K between a cell that holds heat and its air cell: the heat that crosses a cell's face per
  // second per degree per square meter, the same for every material (`airShare`). It is the near half of the cooling
  // in still air: the other half is how fast the air removes the heat (diffusion across air cells and the rising plume),
  // so the two in series are tuned to the effective 5 to 10 W/m²·K of natural convection from a warm surface
  // (tests/air-heat.test.ts, M8.8 AC7: a steel block 7 cm wide cools at 9 W/m²·K with 40, 7 with 20, 5 with 10).
  surfaceCoefficient: 40,
  // Volumetric heat capacity of air in MJ/m³·K (1.2 kJ/m³·K, 1.005 kJ/kg·K at 1.2 kg/m³): about 1/3,500 of water's. An air
  // cell holds this times `cellSize` squared; a cell's heat per degree in the table's units (a cell is one unit of matter).
  heatCapacity: 0.0012,
  // A powder or liquid moving at least this fast (cells per dispatch) trades no heat with the air, as a flyer does: the
  // exchange stands for a cell warming the still air beside it, and a cell crossing a new air cell every few dispatches
  // would mix with a whole air cell of fresh air each frame (a lone falling lava cell would lose about 160 °C a frame,
  // and a poured stream would set in mid-fall and hang there as stone). A cell falling from rest passes it after 8
  // dispatches; one resting in moving air stays far below it.
  stillSpeed: 0.25,
  // Upward acceleration of the air per degree it is above room temperature, in cells per dispatch squared: hot air rises,
  // cold air sinks. Friction (`velocityLoss`) limits the speed hot air reaches to `buoyancy` x degrees / `velocityLoss`.
  // Tuned in M6.4a: small enough that the pressure the rising air builds does not push sand, large enough that a
  // plume draws smoke in toward its base (smoke already rises at the top speed, so it is not lifted faster).
  buoyancy: 0.000002,
  // Acceleration of powders and liquids by the pressure gradient, in (cells per dispatch squared) x density per unit of
  // pressure per cell: a cell of density d gains push x gradient / d each dispatch, so lighter matter is thrown harder.
  // Tuned against the pulse tests (tests/air-matter.test.ts): a pulse of peak pressure 2 and sigma 6 inside a layer of
  // sand throws the grains it reaches out of the surface at several cells per dispatch. Pressure and wind are coupled
  // (a pulse of pressure p moves the air at about p, capped at maxSpeed), so a pulse much above 2 is no stronger on the
  // air but pushes the matter proportionally harder.
  push: 16000,
  // Share of its speed the air in a cell wholly filled with powder or liquid loses per dispatch, on top of velocityLoss:
  // wind does not blow through a pile or a pool.
  matterLoss: 0.05,
  // Fixed-point scale of the burst buffer: pressure released by a cell is added as an integer, so the sum is the same
  // whatever order the threads add in.
  burstScale: 1024,
  // The air cell size, in grid cells along each axis, a `Transition.burst` is the pressure for: a cell's burst raises an
  // air cell of this size by that much, and a smaller air cell by more, in the ratio of their areas (the same gas in less
  // room), so a charge of powder raises the pressure around it by the same amount at every air cell size.
  burstCellSize: 4,
  // The Wind tool's air speed per unit of pointer speed: a stroke that moves the pointer `d` grid cells over a frame of `n`
  // dispatches blows at gain x d / n cells per dispatch, capped at maxSpeed.
  windToolGain: 0.5,
  // Share of the gap between the air's speed and the stroke's that a frame's stroke closes at the faces it reaches.
  windToolBlend: 0.5,
  // The pressure the air view's ramp ends at: from -viewRange (darkest) to +viewRange (lightest), clamped beyond. A
  // crushing blast (STONE_CRUSH 0.45) is 90% of the way out, a gunpowder charge (peak above 1) saturates.
  viewRange: 0.5,
} as const;

/**
 * The air view's colors by pressure: dark blue at -viewRange, mid grey at 0 (ambient), pale yellow at +viewRange. Each
 * knot is lighter than the one before (Rec. 709 luminance), so brightness alone orders the pressures and the view does
 * not rely on hue (the user is red-green colorblind). `temp` is the position along the ramp, here a pressure. Generates
 * the shader's `pressureColor` and the legend's gradient, like `HEAT_RAMP`.
 */
export const PRESSURE_RAMP: readonly RampKnot[] = [
  { temp: -AIR.viewRange, color: [0.02, 0.05, 0.30] },
  { temp: -AIR.viewRange / 2, color: [0.12, 0.25, 0.62] },
  { temp: 0, color: [0.45, 0.45, 0.45] },
  { temp: AIR.viewRange / 2, color: [0.78, 0.74, 0.40] },
  { temp: AIR.viewRange, color: [1.0, 0.96, 0.62] },
];

/** The pressures the air view's legend labels. */
export const AIR_LEGEND_PRESSURES: readonly number[] = [-AIR.viewRange, 0, AIR.viewRange];

/**
 * The air view's wind marks, in screen pixels: one line per `spacing` x `spacing` tile, centered on it, pointing
 * downwind with an arrowhead, `maxLength` long at the air's top speed (`AIR.maxSpeed`) and shorter by the power
 * `exponent` of the speed's share of it (so a breeze is still visible next to a gale); none below `minLength`.
 */
export const AIR_VIEW = {
  spacing: 16,
  maxLength: 11,
  exponent: 0.4,
  minLength: 2,
} as const;

/**
 * The speed the Wind tool gives the air for a stroke from `from` to `to` (grid cells) over a frame of `dispatches`
 * dispatches, in grid cells per dispatch: along the stroke, growing with its speed, never above `AIR.maxSpeed`; zero
 * for a pointer that did not move.
 */
export function windVelocity(from: { x: number; y: number }, to: { x: number; y: number }, dispatches: number): { x: number; y: number } {
  if (dispatches <= 0) return { x: 0, y: 0 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const speed = Math.min(AIR.windToolGain * length / dispatches, AIR.maxSpeed);
  return { x: dx / length * speed, y: dy / length * speed };
}

// Share of the temperature difference per unit of 1 / capacity (MJ/m³·K) that a cell and its air close in one superstep
// (PAIR_TIME): the surface coefficient h W/m²·K over the cell's face (CELL_SIZE wide per unit depth) heats a volume of
// CELL_SIZE² per unit depth, so dΔT/ΔT = h · PAIR_TIME / CELL_SIZE × (1 / C_cell + 1 / C_air).
const AIR_SURFACE = (AIR.surfaceCoefficient * PAIR_TIME) / CELL_SIZE / HEAT_UNIT;

/**
 * The share of the way to their capacity-weighted mean that a cell of heat capacity `cellCapacity` (MJ/m³·K) and its air
 * cell (`AIR.heatCapacity` × `airCellSize`²) move in one superstep, at most 1 (never past the mean). Mirrors the share in
 * `airExchangeWGSL`.
 */
export function airShare(cellCapacity: number, airCellSize: number): number {
  return Math.min(1, AIR_SURFACE * (1 / cellCapacity + 1 / (AIR.heatCapacity * airCellSize * airCellSize)));
}

/** The air cell sizes: grid cells per air cell along each axis. */
export const AIR_CELL_SIZES = [1, 2, 4, 8] as const;
export type AirCellSize = (typeof AIR_CELL_SIZES)[number];
export const DEFAULT_AIR_CELL_SIZE: AirCellSize = 4;

// The pressure-velocity pair is stable while a wave crosses at most this many air cells per air step (1/sqrt(2) is the
// limit of the 2D scheme).
const MAX_WAVE_COURANT = 0.7;

/**
 * Air steps per superstep (two dispatches): the fewest that keep the pressure waves (`waveSpeed`) within
 * `MAX_WAVE_COURANT` air cells per step and the fastest air (`maxSpeed`, which carries heat) within one air cell per step. 1 at 4x4.
 */
export function airSubsteps(cellSize: number): number {
  const wave = Math.ceil((AIR.waveSpeed * 2) / (cellSize * MAX_WAVE_COURANT));
  const flow = Math.ceil((AIR.maxSpeed * 2) / cellSize);
  return Math.max(1, wave, flow);
}

/** The constants a shader needs, per air step. */
export function airConstantsWGSL(cellSize: number, substeps: number): string {
  // Dispatches per air step.
  const dt = 2 / substeps;
  // Per-dispatch shares applied over one step.
  const keep = (loss: number): number => (1 - loss) ** dt;
  // Heat crosses a face at the air's speed up to this: with four faces, a cell then gives away at most all its heat in
  // one step, so the upwind sum stays a weighted mean of the cell and its neighbors and cannot overshoot.
  const fluxCap = Math.min(AIR.maxSpeed, (cellSize * substeps) / 8);
  const diffusion = AIR.diffusion * dt;
  if (diffusion > 0.25) throw new RangeError(`air diffusion ${AIR.diffusion} per dispatch is unstable over ${dt} dispatches`);
  return /* wgsl */`
const S: i32 = ${cellSize};
// Velocity gain per unit of pressure difference across a face, and pressure loss per unit of velocity difference across a cell.
const GRADIENT: f32 = ${wgslFloat(AIR.waveSpeed ** 2 * dt / cellSize)};
const DIVERGENCE: f32 = ${wgslFloat(dt / cellSize)};
// Air cells an air parcel crosses per unit of speed in one step.
const ADVECT: f32 = ${wgslFloat(dt / cellSize)};
const WAVE_SPEED: f32 = ${wgslFloat(AIR.waveSpeed)};
const MAX_AIR_SPEED: f32 = ${wgslFloat(AIR.maxSpeed)};
const FLUX_CAP: f32 = ${wgslFloat(fluxCap)};
const KEEP_PRESSURE: f32 = ${wgslFloat(keep(AIR.pressureLoss))};
const KEEP_VELOCITY: f32 = ${wgslFloat(keep(AIR.velocityLoss))};
const KEEP_MATTER: f32 = ${wgslFloat(keep(AIR.matterLoss))};
const KEEP_EDGE: f32 = ${wgslFloat(keep(AIR.edgeDamping))};
const DIFFUSION: f32 = ${wgslFloat(diffusion)};
// The share of a cell's difference to the air per unit of 1 / capacity (\`airShare\`).
const AIR_SURFACE: f32 = ${wgslFloat(AIR_SURFACE)};
// The heat an air cell takes per degree: its \`S x S\` grid cells' worth.
const AIR_CAPACITY: f32 = ${wgslFloat(AIR.heatCapacity * cellSize * cellSize)};
const STILL_SPEED: f32 = ${wgslFloat(AIR.stillSpeed)};
// Velocity gain per degree above room temperature over one step.
const BUOYANCY: f32 = ${wgslFloat(AIR.buoyancy * dt)};
const BURST_SCALE: f32 = ${wgslFloat(AIR.burstScale)};
`;
}
