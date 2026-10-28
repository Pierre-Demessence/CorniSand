import type { RampKnot } from './heat';
import { wgslFloat } from './movement';

/** The shape of the air grid a shader that reads it needs: grid cells per air cell and air cells across and up. */
export interface AirShape {
  cellSize: number;
  columns: number;
  rows: number;
}

// Constants of the air (docs/plans/m6-air.md). Units: grid cells and dispatches (one Margolus pass), not air cells, so
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
  // Share of the temperature difference that evens out when a cell that holds heat exchanges with its air: the pair
  // meets at the harmonic mean of this and the cell's own conductivity (`exchangeHeat`'s rule). Tuned in M6.4a against
  // the cooling targets of docs/plans/m6-air.md.
  conductivity: 0.5,
  // Heat per degree of the air over one grid cell, in the units of the elements' heat capacity (a cell is one unit of
  // matter, water 4.2): air's volumetric heat capacity is about 1/3,500 of water's, so about 0.0012. An air cell holds
  // this times `cellSize` squared. Tuned in M6.4a.
  heatCapacity: 0.04,
  // A powder or liquid moving at least this fast (cells per dispatch) trades no heat with the air, as a flyer does: the
  // exchange stands for a cell warming the still air beside it, and a cell crossing a new air cell every few dispatches
  // would mix with a whole air cell of fresh air each frame (a lone falling lava cell would lose about 160 °C a frame,
  // and a poured stream would set in mid-fall and hang there as stone). A cell falling from rest passes it after 8
  // dispatches; one resting in moving air stays far below it.
  stillSpeed: 0.25,
  // Upward acceleration of the air per degree it is above room temperature, in cells per dispatch squared: hot air rises,
  // cold air sinks. Friction (`velocityLoss`) limits the speed hot air reaches to `buoyancy` x degrees / `velocityLoss`.
  // Tuned in M6.4a: small enough that the pressure the rising air builds does not push sand, large enough that a
  // plume lifts smoke faster than it rises alone.
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
const AIR_CONDUCTIVITY: f32 = ${wgslFloat(AIR.conductivity)};
// The heat an air cell takes per degree: its \`S x S\` grid cells' worth.
const AIR_CAPACITY: f32 = ${wgslFloat(AIR.heatCapacity * cellSize * cellSize)};
const STILL_SPEED: f32 = ${wgslFloat(AIR.stillSpeed)};
// Velocity gain per degree above room temperature over one step.
const BUOYANCY: f32 = ${wgslFloat(AIR.buoyancy * dt)};
const BURST_SCALE: f32 = ${wgslFloat(AIR.burstScale)};
`;
}
