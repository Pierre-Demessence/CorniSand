import { describe, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { expectLevelsSettle, expectOilAboveWater, load, LONG, makeModel } from './liquid-acceptance';

describe('liquid acceptance (CPU reference): U-tubes and layers', () => {
  it('AC1: the small U-tube settles within 2000 steps and stays settled for 1000', async () => {
    const model = makeModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTube()), 2000);
  }, LONG);

  it('AC2: the large U-tube settles within 8000 steps', async () => {
    const model = makeModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeLarge()), 8000);
  }, LONG);

  it('AC3: a U-tube with 8 and 32 wide arms settles within 4000 steps', async () => {
    const model = makeModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeUnequal()), 4000);
  }, LONG);

  it('AC11: the oil U-tube settles like the water one, and oil poured on water stays above it', async () => {
    const model = makeModel();
    await expectLevelsSettle(model, await load(model, SCENES.uTubeOil()), 2000);
    await expectOilAboveWater(makeModel());
  }, LONG);
});
