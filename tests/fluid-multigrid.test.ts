import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { FlipModel } from './cpu/flip';
import { createSim, device, loadScene, readFloats, runFluid } from './gpu';

const SEED = 7;
const SCENE_NAMES = ['uTube', 'damBreak', 'oilOnWater', 'sandIntoPool', 'film'];

// The coarse operators the GPU builds from the fine weights (docs/simulation.md): every level's face weights and
// diagonal must match the CPU reference's, entry by entry.
describe.skipIf(!device)('GPU multigrid hierarchy matches the CPU reference', () => {
  it.each(SCENE_NAMES)('%s: every level\'s weights and diagonals match MultigridSolver.levels', async (name) => {
    const scene = SCENES[name]();
    const { width, height } = scene;

    const cpu = new FlipModel();
    cpu.load(scene);
    cpu.seedVelocities(SEED);
    const sim = createSim(width, height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(SEED);

    cpu.stepGrid();
    await runFluid(sim, 1, true, 'grid');

    const reference = cpu.debugLevels();
    const { levels } = sim.fluid.grid;
    expect(levels, 'level count').toHaveLength(reference.length);
    expect(reference.length, 'a hierarchy to compare').toBeGreaterThan(1);

    const last = levels[levels.length - 1];
    const total = last.offset + last.width * last.height;
    const weights = await readFloats(sim.fluid.grid.weights, 4 * total);
    const diagDiv = await readFloats(sim.fluid.grid.diagDiv, 2 * total);

    levels.forEach((level, l) => {
      const cpuLevel = reference[l];
      expect([level.width, level.height], `level ${l} size`).toEqual([cpuLevel.nx, cpuLevel.ny]);
      let liquid = 0;
      for (let c = 0; c < level.width * level.height; c++) {
        const gpuDiag = diagDiv[2 * (level.offset + c)];
        const cpuDiag = cpuLevel.diag[c];
        // A cell without liquid has no equation: the two must agree on which cells those are.
        expect(gpuDiag === 0, `level ${l} cell ${c} has an equation: cpu diag ${cpuDiag} gpu diag ${gpuDiag}`).toBe(cpuDiag === 0);
        if (cpuDiag === 0) continue;
        liquid++;
        const entries: [string, number, number][] = [
          ['diag', cpuDiag, gpuDiag],
          ['wl', cpuLevel.wl[c], weights[4 * (level.offset + c)]],
          ['wr', cpuLevel.wr[c], weights[4 * (level.offset + c) + 1]],
          ['wb', cpuLevel.wb[c], weights[4 * (level.offset + c) + 2]],
          ['wt', cpuLevel.wt[c], weights[4 * (level.offset + c) + 3]],
        ];
        for (const [entry, expected, actual] of entries) {
          const tolerance = 1e-5 * Math.max(1, Math.abs(expected));
          expect(Math.abs(expected - actual), `${name} level ${l} cell ${c} ${entry}: cpu ${expected} gpu ${actual}`).toBeLessThanOrEqual(tolerance);
        }
      }
      expect(liquid, `level ${l} has liquid cells`).toBeGreaterThan(0);
    });
  });
});
