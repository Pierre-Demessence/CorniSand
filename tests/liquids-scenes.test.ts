import { describe, it } from 'vitest';
import {
  expectBasinFlat,
  expectDamBreakRunUp,
  expectSandSinks,
  expectSealedChamberAtRest,
  expectStaysInPlace,
  LONG,
  makeModel,
} from './liquid-acceptance';

describe('liquid acceptance (CPU reference): single scenes', () => {
  it('AC6: the basin is flat after 3000 steps', () => expectBasinFlat(makeModel()), LONG);

  it('AC7: a dam break reaches the far wall and climbs at least 5 cells above the rest level', () => expectDamBreakRunUp(makeModel()), LONG);

  it('AC8: a sealed full chamber stays at rest', () => expectSealedChamberAtRest(makeModel()), LONG);

  it.each(['droplet', 'film'])('AC9: the %s stays in place', (name) => expectStaysInPlace(makeModel(), name), LONG);

  it('AC10: sand dropped into a pool reaches the bottom and raises the surface by its volume', () => expectSandSinks(makeModel()), LONG);
});
