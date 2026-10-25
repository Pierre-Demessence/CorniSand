import { describe, expect, it } from 'vitest';
import { SCENES } from '../../src/scenes';
import { DEFAULT_MULTIGRID } from './solver';
import { convergenceFactor, multigridResiduals, oilAbove, sorResidual, warmStart } from './solver-experiments';

// M1.5c experiments E1 and E2 at screen size. About 15 s on top of a suite that is already long, so run on demand: `SCREEN=1 npx vitest run solver-screen`.
// The numbers it logs are recorded in the finished plan, found with `git log --all -- docs/plans/physics-foundation.md` ("M1.5c measurements").

const problems = [
  SCENES.deepPool(),
  { ...SCENES.uTubeHuge(), name: 'uTubeHuge' },
  { ...SCENES.uTubeLarge(), name: 'uTubeLarge' },
  // The large U-tube with the top 60 rows of its left arm oil: a layered body, for the density weights.
  { ...oilAbove(SCENES.uTubeLarge(), 150), name: 'uTubeLarge+oil' },
];

const format = (x: number): string => x.toExponential(1);

describe.skipIf(!process.env.SCREEN)('multigrid at screen size', () => {
  it.each(problems.map((scene) => [`${scene.name} ${scene.width}x${scene.height}`, scene] as const))(
    'meets E1 and E2 on %s',
    (name, scene) => {
      const residuals = multigridResiduals(scene, DEFAULT_MULTIGRID, 6);
      const bare = multigridResiduals(scene, { ...DEFAULT_MULTIGRID, preconditioned: false }, 6);
      const factor = convergenceFactor(residuals);
      const warm = warmStart(scene, DEFAULT_MULTIGRID, 5);
      const warmSor = warmStart(scene, DEFAULT_MULTIGRID, 5, 40);
      console.log([
        name,
        `  multigrid CG, residual after 0..6 iterations: ${residuals.map(format).join(' ')}, factor ${factor.toFixed(3)}`,
        `  bare V-cycles, same parameters: ${bare.map(format).join(' ')}, factor ${convergenceFactor(bare).toFixed(3)}`,
        `  SOR from p = 0: 40 pairs ${format(sorResidual(scene, 40))}, 160 ${format(sorResidual(scene, 160))}, 1000 ${format(sorResidual(scene, 1000))}`,
        `  warm start, worst of 5 perturbed steps: multigrid ${format(warm)}, SOR 40 pairs ${format(warmSor)}`,
      ].join('\n'));
      expect(factor).toBeLessThanOrEqual(0.35);
      expect(warm).toBeLessThanOrEqual(0.05);
    },
    600_000,
  );
});
