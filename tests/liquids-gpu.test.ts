import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { flatness } from './metrics';
import { device } from './gpu';
import { GpuLiquidModel } from './gpu-liquid-model';
import {
  expectBasinFlat,
  expectDamBreakRunUp,
  expectLevelsSettle,
  expectNoBubblesOrFoam,
  expectOilAboveWater,
  expectSandSinks,
  expectSealedChamberAtRest,
  expectStaysInPlace,
  expectVolumesConstant,
  load,
  LONG,
} from './liquid-acceptance';

// AC12: the acceptance cases of tests/liquids-*.test.ts on the GPU build through read-back, with the same thresholds.
describe.skipIf(!device)('liquid acceptance (GPU)', () => {
  it('AC1: the small U-tube settles within 2000 steps and stays settled for 1000', async () => {
    const model = new GpuLiquidModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTube()), 2000);
  }, LONG);

  it('AC2: the large U-tube settles within 8000 steps', async () => {
    const model = new GpuLiquidModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeLarge()), 8000);
  }, LONG);

  it('AC3: a U-tube with 8 and 32 wide arms settles within 4000 steps', async () => {
    const model = new GpuLiquidModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeUnequal()), 4000);
  }, LONG);

  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool', 'oilOnWater', 'uTubeOil'])(
    'AC4: volume stays constant in %s and the rasterization never falls short',
    async (name) => {
      const model = new GpuLiquidModel();
      await load(model, SCENES[name]());
      await expectVolumesConstant(model, 1500);
    },
    LONG,
  );

  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool'])(
    'AC5: %s has no enclosed bubble after 3000 steps',
    (name) => expectNoBubblesOrFoam(new GpuLiquidModel(), name),
    LONG,
  );

  it('AC6: the basin is flat after 3000 steps', () => expectBasinFlat(new GpuLiquidModel()), LONG);

  it('AC7: a dam break reaches the far wall and climbs at least 5 cells above the rest level', () => expectDamBreakRunUp(new GpuLiquidModel()), LONG);

  it('AC8: a sealed full chamber stays at rest', () => expectSealedChamberAtRest(new GpuLiquidModel()), LONG);

  it.each(['droplet', 'film'])('AC9: the %s stays in place', (name) => expectStaysInPlace(new GpuLiquidModel(), name), LONG);

  it('AC10: sand dropped into a pool reaches the bottom and raises the surface by its volume', () => expectSandSinks(new GpuLiquidModel()), LONG);

  it('AC11: the oil U-tube settles like the water one, and oil poured on water stays above it', async () => {
    const model = new GpuLiquidModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeOil()), 2000);
    await expectOilAboveWater(new GpuLiquidModel());
  }, LONG);

  // M1.5b: the solver at screen scale, where one pressure wave must cross 480 to 1,200 rows. Both cases fail with 40
  // sweeps (the finished plan, found with `git log --all -- docs/plans/physics-foundation.md`, "M1.5b measurements") and pass with the multigrid solve.
  it('M1.5b: the huge U-tube (408x480) settles within 16000 steps', async () => {
    const model = new GpuLiquidModel();
    const result = await expectLevelsSettle(model, await load(model, SCENES.uTubeHuge()), 16_000);
    console.log(`uTubeHuge: settled at step ${result.settledAt}, residual ${await model.residual()}, particles over 0.3 cells/step ${await model.fractionFasterThan(0.3)}`);
  }, LONG);

  it('M1.5b: the deep pool (512x1200) is flat and mostly calm after 6000 steps', async () => {
    const model = new GpuLiquidModel();
    const scene = await load(model, SCENES.deepPool());
    await model.step(6000);
    const flat = flatness(model.cells(), scene.width, scene.height, scene.chambers[0], scene.floorY);
    const fast = await model.fractionFasterThan(0.3);
    console.log(`deepPool: flatness ${flat}, maxShortfall ${model.maxShortfall}, residual ${await model.residual()}, particles over 0.3 cells/step ${fast}`);
    expect(flat, 'flatness').toBeLessThanOrEqual(1);
    expect(fast, 'share of particles faster than 0.3 cells/step').toBeLessThanOrEqual(0.35);
  }, LONG);
});
