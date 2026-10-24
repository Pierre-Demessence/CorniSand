import type { Scene } from '../src/scenes';

/** What the acceptance tests need from a liquid simulation, so the same tests run on every implementation. */
export interface LiquidModel {
  load(scene: Scene): void;
  /** Advances `n` supersteps: one fluid update plus the two CA dispatches each. */
  step(n: number): void;
  /** Packed cells, row y = 0 at the bottom. Valid until the next `step`. */
  cells(): Uint32Array;
  /** Number of cells of a particle type. */
  volume(type: number): number;
  /** Per-cell fill fraction, for representations that have one (foam check). */
  fill?(): Float32Array;
  /** Largest face speed in cells per step. */
  maxSpeed(): number;
}

export interface SettleResult {
  /** Sampled step from which `check` held without a break for `hold` steps, or null if no such run starts by `within`. */
  settledAt: number | null;
  /** Last sampled step at which `check` failed, or null if it never did; a late value shows what kept the model from settling. */
  lastBreak: number | null;
}

/**
 * Steps the model, sampling `check` every `every` steps. Settled means the condition holds at every sample of a
 * run that starts at or before `within` and lasts `hold` steps; a model that merely passes through the band while
 * sloshing does not count.
 */
export function settleAndHold(
  model: LiquidModel,
  check: (cells: Uint32Array) => boolean,
  { within, hold, every = 25 }: { within: number; hold: number; every?: number },
): SettleResult {
  let step = 0;
  let since: number | null = null;
  let lastBreak: number | null = null;
  while (step < within + hold) {
    model.step(every);
    step += every;
    if (check(model.cells())) {
      since ??= step;
      if (since > within) return { settledAt: null, lastBreak };
      if (step - since >= hold) return { settledAt: since, lastBreak };
    } else {
      since = null;
      lastBreak = step;
      if (step >= within) return { settledAt: null, lastBreak };
    }
  }
  return { settledAt: null, lastBreak };
}

/** Calls `observe` with the cells every `every` steps, `total` steps in all. */
export function observe(model: LiquidModel, total: number, every: number, visit: (cells: Uint32Array, step: number) => void): void {
  for (let step = every; step <= total; step += every) {
    model.step(every);
    visit(model.cells(), step);
  }
}
