import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { load, LONG, makeModel } from './liquid-acceptance';
import { bubbleCount, foamCount } from './metrics';

describe('liquid acceptance (CPU reference): settled scenes', () => {
  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool'])(
    'AC5: %s has no enclosed bubble and no foam after 3000 steps',
    (name) => {
      const model = makeModel();
      const scene = load(model, SCENES[name]());
      model.step(3000);
      expect(bubbleCount(model.cells(), scene.width, scene.height), `${name} bubbles`).toBe(0);
      const fill = model.fill?.();
      if (fill) expect(foamCount(fill, scene.width, scene.height), `${name} foam`).toBe(0);
    },
    LONG,
  );
});
