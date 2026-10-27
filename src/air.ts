import { wgslFloat } from './movement';

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
  // boundary (which already lets a wave leave): it takes the echo of waves that arrive at a slant.
  edgeDamping: 0.1,
  // Share of the temperature difference to a neighbor an air cell closes per dispatch, across a fully open face.
  diffusion: 0.02,
  // Fixed-point scale of the burst buffer: pressure released by a cell is added as an integer, so the sum is the same
  // whatever order the threads add in.
  burstScale: 1024,
} as const;

/** The air cell sizes: grid cells per air cell along each axis. */
export const AIR_CELL_SIZES = [1, 2, 4, 8] as const;
export type AirCellSize = (typeof AIR_CELL_SIZES)[number];
export const DEFAULT_AIR_CELL_SIZE: AirCellSize = 4;

// The pressure-velocity pair is stable while a wave crosses at most this many air cells per air step (1/sqrt(2) is the
// limit of the 2D scheme).
const MAX_WAVE_COURANT = 0.7;

/**
 * Air steps per superstep (two dispatches): the fewest that keep the pressure waves (`waveSpeed`) within
 * `MAX_WAVE_COURANT` air cells per step and the fastest air (`maxSpeed`) within one air cell per step. 1 at 4x4.
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
const KEEP_EDGE: f32 = ${wgslFloat(keep(AIR.edgeDamping))};
const DIFFUSION: f32 = ${wgslFloat(diffusion)};
const BURST_SCALE: f32 = ${wgslFloat(AIR.burstScale)};
`;
}
