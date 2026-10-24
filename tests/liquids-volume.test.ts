import { describe, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { expectVolumesConstant, load, LONG, makeModel } from './liquid-acceptance';

describe('liquid acceptance (CPU reference): volume', () => {
  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool', 'oilOnWater', 'uTubeOil'])(
    'AC4: volume stays constant in %s',
    async (name) => {
      const model = makeModel();
      await load(model, SCENES[name]());
      await expectVolumesConstant(model, 1500);
    },
    LONG,
  );
});
