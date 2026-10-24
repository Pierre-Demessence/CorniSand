import { describe, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { expectVolumesConstant, load, LONG, makeModel } from './liquid-acceptance';

describe('liquid acceptance (CPU reference): volume', () => {
  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool', 'oilOnWater', 'uTubeOil'])(
    'AC4: volume stays constant in %s',
    (name) => {
      const model = makeModel();
      load(model, SCENES[name]());
      expectVolumesConstant(model, 1500);
    },
    LONG,
  );
});
