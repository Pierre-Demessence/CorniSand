import { describe, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { device } from './gpu';
import { GpuLiquidModel } from './gpu-liquid-model';
import {
  expectBasinFlat,
  expectDamBreakRunUp,
  expectLevelsSettle,
  expectNoBubblesOrFoam,
  expectSealedChamberAtRest,
  expectStaysInPlace,
  expectVolumesConstant,
  load,
  LONG,
} from './liquid-acceptance';

// AC12: the acceptance cases of tests/liquids-*.test.ts on the GPU build through read-back, with the same thresholds.
// AC10 and AC11 follow in M1.5a.
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
});
