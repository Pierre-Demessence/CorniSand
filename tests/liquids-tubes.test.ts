import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { SCENES } from '../src/scenes';
import { expectLevelsSettle, load, LONG, makeModel } from './liquid-acceptance';
import { liquidVolume } from './metrics';

describe('liquid acceptance (CPU reference): U-tubes and layers', () => {
  it('AC1: the small U-tube settles within 2000 steps and stays settled for 1000', () => {
    const model = makeModel();
    expectLevelsSettle(model, load(model, SCENES.uTube()), 2000);
  }, LONG);

  it('AC2: the large U-tube settles within 8000 steps', () => {
    const model = makeModel();
    expectLevelsSettle(model, load(model, SCENES.uTubeLarge()), 8000);
  }, LONG);

  it('AC3: a U-tube with 8 and 32 wide arms settles within 4000 steps', () => {
    const model = makeModel();
    expectLevelsSettle(model, load(model, SCENES.uTubeUnequal()), 4000);
  }, LONG);

  it('AC11: the oil U-tube settles like the water one, and oil poured on water stays above it', () => {
    const model = makeModel();
    expectLevelsSettle(model, load(model, SCENES.uTubeOil()), 2000);

    const scene = load(model, SCENES.oilOnWater());
    model.step(1500);
    const cells = model.cells();
    for (let x = 0; x < scene.width; x++) {
      let oilSeen = false;
      for (let y = scene.floorY; y < scene.height; y++) {
        const type = cells[y * scene.width + x] & 0xff;
        if (type === T.OIL) oilSeen = true;
        expect(oilSeen && type === T.WATER, `water above oil at ${x},${y}`).toBe(false);
      }
    }
    expect(liquidVolume(cells)).toBe(56 * 15 + 20 * 6);
  }, LONG);
});
