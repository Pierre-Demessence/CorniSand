import { expect } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { SAND_POOL, SCENES, type Scene } from '../src/scenes';
import { FlipModel } from './cpu/flip';
import { type LiquidModel, observe, type SettleResult, settleAndHold } from './liquid-model';
import { bubbleCount, chamberLevel, columnLevel, flatness, foamCount, liquidVolume, LIQUIDS } from './metrics';

// Shared pieces of the acceptance suite for the liquid criteria AC1-AC11 of the finished plan, found with `git log --all -- docs/plans/physics-foundation.md`.
// The cases are written against LiquidModel so another implementation can run them: the CPU reference
// (tests/liquids-*.test.ts, split over several files because it is slow and vitest runs files in parallel) and
// the GPU (tests/liquids-gpu.test.ts).

export const makeModel = (): LiquidModel => new FlipModel();

/** Generous timeout: the large scenes take a minute or more on the CPU. */
export const LONG = 600_000;

export async function load(model: LiquidModel, scene: Scene): Promise<Scene> {
  await model.load(scene);
  return scene;
}

// Both arms of the tube within one cell of the analytic rest level.
function armsAtRest(scene: Scene): (cells: Uint32Array) => boolean {
  return (cells) =>
    scene.chambers.every(
      (chamber) => Math.abs(chamberLevel(cells, scene.width, scene.height, chamber, scene.floorY) - scene.expectedLevel!) <= 1,
    );
}

export async function expectLevelsSettle(model: LiquidModel, scene: Scene, within: number): Promise<SettleResult> {
  const result = await settleAndHold(model, armsAtRest(scene), { within, hold: 1000 });
  expect(result.settledAt, `steps to settle (last step outside the rest band: ${result.lastBreak})`).not.toBeNull();
  return result;
}

// Per-type cell counts that must not change without brush input, and no liquid cell the rasterization failed to place.
export async function expectVolumesConstant(model: LiquidModel, total: number): Promise<void> {
  const types = [T.WATER, T.OIL, T.SAND];
  const volumes = async (): Promise<number[]> => {
    const counts: number[] = [];
    for (const t of types) counts.push(await model.volume(t));
    return counts;
  };
  const before = await volumes();
  await observe(model, total, 50, async () => {
    expect(await volumes()).toEqual(before);
    if (model.maxShortfall !== undefined) expect(model.maxShortfall, 'maxShortfall').toBe(0);
  });
}

// Water cells with oil somewhere below them in the same column.
function waterAboveOilCount(cells: Uint32Array, scene: Scene): number {
  let count = 0;
  for (let x = 0; x < scene.width; x++) {
    let oilSeen = false;
    for (let y = scene.floorY; y < scene.height; y++) {
      const type = cells[y * scene.width + x] & 0xff;
      if (type === T.OIL) oilSeen = true;
      else if (oilSeen && type === T.WATER) count++;
    }
  }
  return count;
}

// AC11, second half: oil poured on water stays above it, and no liquid is lost. Water and oil particles overlap in a
// band about one cell wide at the interface, so a lone cell can be inverted for a step or two (docs/backlog.md D18);
// the layers count as ordered when, over 100 consecutive steps, the median step has no inverted cell and none has
// more than 3.
export async function expectOilAboveWater(model: LiquidModel): Promise<void> {
  const scene = await load(model, SCENES.oilOnWater());
  await model.step(1400);
  const inverted: number[] = [];
  await observe(model, 100, 1, (cells) => {
    inverted.push(waterAboveOilCount(cells, scene));
  });
  const sorted = [...inverted].sort((a, b) => a - b);
  expect(sorted[sorted.length >> 1], `median inverted cells per step (counts: ${inverted.join(',')})`).toBe(0);
  expect(sorted.at(-1), 'most inverted cells in one step').toBeLessThanOrEqual(3);
  expect(liquidVolume(await model.cells())).toBe(56 * 15 + 20 * 6);
}

// AC5: no enclosed bubble and, for a model with a fill fraction, no foam.
export async function expectNoBubblesOrFoam(model: LiquidModel, name: string): Promise<void> {
  const scene = await load(model, SCENES[name]());
  await model.step(3000);
  expect(bubbleCount(await model.cells(), scene.width, scene.height), `${name} bubbles`).toBe(0);
  const fill = await model.fill?.();
  if (fill) expect(foamCount(fill, scene.width, scene.height), `${name} foam`).toBe(0);
}

// AC6
export async function expectBasinFlat(model: LiquidModel): Promise<void> {
  const scene = await load(model, SCENES.basin());
  await model.step(3000);
  expect(flatness(await model.cells(), scene.width, scene.height, scene.chambers[0], scene.floorY)).toBeLessThanOrEqual(1);
}

// AC7
export async function expectDamBreakRunUp(model: LiquidModel): Promise<void> {
  const scene = await load(model, SCENES.damBreak());
  const farWall = scene.chambers[0].x1 - 1;
  let peak = 0;
  await observe(model, 3000, 5, (cells) => {
    peak = Math.max(peak, columnLevel(cells, scene.width, scene.height, farWall, scene.floorY));
  });
  expect(peak - scene.expectedLevel!, 'run-up above rest level').toBeGreaterThanOrEqual(5);
}

// AC8
export async function expectSealedChamberAtRest(model: LiquidModel): Promise<void> {
  await load(model, SCENES.sealedChamber());
  const before = Uint32Array.from(await model.cells());
  await observe(model, 500, 25, async (cells) => {
    expect(cells).toEqual(before);
    expect(await model.maxSpeed()).toBeLessThanOrEqual(1e-3);
  });
}

// AC9
export async function expectStaysInPlace(model: LiquidModel, name: string): Promise<void> {
  await load(model, SCENES[name]());
  const before = Uint32Array.from(await model.cells());
  await observe(model, 500, 25, (cells) => {
    expect(cells, name).toEqual(before);
  });
}

// AC10
export async function expectSandSinks(model: LiquidModel): Promise<void> {
  const scene = await load(model, SCENES.sandIntoPool());
  const water = await model.volume(T.WATER);
  await model.step(2500);
  const cells = await model.cells();
  expect(await model.volume(T.WATER)).toBe(water);
  expect(await model.volume(T.SAND)).toBe(SAND_POOL.sandSize ** 2);
  for (let y = scene.floorY; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      if ((cells[y * scene.width + x] & 0xff) !== T.SAND) continue;
      const below = cells[(y - 1) * scene.width + x] & 0xff;
      expect([T.SAND, T.WALL], `sand at ${x},${y} is unsupported`).toContain(below);
    }
  }
  const level = chamberLevel(cells, scene.width, scene.height, scene.chambers[0], scene.floorY, [...LIQUIDS, T.SAND]);
  expect(Math.abs(level - scene.expectedLevel!)).toBeLessThanOrEqual(1);
}
