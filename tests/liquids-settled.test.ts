import { describe, it } from 'vitest';
import { expectNoBubblesOrFoam, LONG, makeModel } from './liquid-acceptance';

describe('liquid acceptance (CPU reference): settled scenes', () => {
  it.each(['uTube', 'basin', 'damBreak', 'sandIntoPool'])(
    'AC5: %s has no enclosed bubble and no foam after 3000 steps',
    (name) => expectNoBubblesOrFoam(makeModel(), name),
    LONG,
  );
});
