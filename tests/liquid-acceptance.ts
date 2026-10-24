import { expect } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import type { Scene } from '../src/scenes';
import { FlipModel } from './cpu/flip';
import { type LiquidModel, observe, settleAndHold } from './liquid-model';
import { chamberLevel } from './metrics';

// Shared pieces of the acceptance suite for the liquid criteria AC1-AC11 of docs/plans/physics-foundation.md.
// The cases are written against LiquidModel so another implementation can run them, and they are split over
// several files because the CPU reference is slow and vitest runs files in parallel.

export const makeModel = (): LiquidModel => new FlipModel();

/** Generous timeout: the large scenes take a minute or more on the CPU. */
export const LONG = 600_000;

export function load(model: LiquidModel, scene: Scene): Scene {
  model.load(scene);
  return scene;
}

// Both arms of the tube within one cell of the analytic rest level.
function armsAtRest(scene: Scene): (cells: Uint32Array) => boolean {
  return (cells) =>
    scene.chambers.every(
      (chamber) => Math.abs(chamberLevel(cells, scene.width, scene.height, chamber, scene.floorY) - scene.expectedLevel!) <= 1,
    );
}

export function expectLevelsSettle(model: LiquidModel, scene: Scene, within: number): void {
  const result = settleAndHold(model, armsAtRest(scene), { within, hold: 1000 });
  expect(result.settledAt, `steps to settle (last step outside the rest band: ${result.lastBreak})`).not.toBeNull();
}

// Per-type cell counts that must not change without brush input.
export function expectVolumesConstant(model: LiquidModel, total: number): void {
  const types = [T.WATER, T.OIL, T.SAND];
  const before = types.map((t) => model.volume(t));
  observe(model, total, 50, () => {
    expect(types.map((t) => model.volume(t))).toEqual(before);
  });
}
