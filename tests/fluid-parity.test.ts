import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { FlipModel } from './cpu/flip';
import { createSim, device, loadScene, readBuffer, readFloats, runFluid } from './gpu';

const SEED = 7;

interface Worst {
  index: number;
  x: number;
  y: number;
  cpu: number;
  gpu: number;
  diff: number;
}

// The largest |cpu - gpu| over the entries `skip` does not exclude, with where it is (`row` entries per grid row).
function worstDifference(cpu: ArrayLike<number>, gpu: ArrayLike<number>, row: number, skip?: (index: number) => boolean): Worst {
  const worst: Worst = { index: -1, x: 0, y: 0, cpu: 0, gpu: 0, diff: 0 };
  for (let i = 0; i < cpu.length; i++) {
    if (skip?.(i)) continue;
    const diff = Math.abs(cpu[i] - gpu[i]);
    if (diff > worst.diff || worst.index < 0) Object.assign(worst, { index: i, x: i % row, y: Math.floor(i / row), cpu: cpu[i], gpu: gpu[i], diff });
  }
  return worst;
}

const maxAbs = (values: ArrayLike<number>): number => {
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, Math.abs(values[i]));
  return max;
};

const describeWorst = (name: string, w: Worst, tolerance: number): string =>
  `${name}: worst index ${w.index} (x ${w.x}, y ${w.y}) cpu ${w.cpu} gpu ${w.gpu} diff ${w.diff} > tolerance ${tolerance}`;

const PARITY_SCENES = ['uTube', 'damBreak', 'oilOnWater', 'sandIntoPool', 'film'];

describe.skipIf(!device)('fluid grid parity with the CPU reference', () => {
  it.each(PARITY_SCENES)('%s: one step of passes 1-13 matches FlipModel.stepGrid', async (name) => {
    const scene = SCENES[name]();
    const { width, height } = scene;

    const cpu = new FlipModel();
    cpu.load(scene);
    cpu.seedVelocities(SEED);

    const sim = createSim(width, height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(SEED);

    cpu.stepGrid();
    await runFluid(sim, 1);

    const reference = cpu.debugState();
    const { grid } = sim.fluid;
    const cells = width * height;
    const uFaces = (width + 1) * height;
    const vFaces = width * (height + 1);

    const flags = await readBuffer(device!, grid.flags, cells * 4);
    expect(Array.from(flags)).toEqual(Array.from(reference.flags));

    // Where the fixed-point rounding of a tiny weight dominates the face velocity, the comparison means nothing.
    const tiny = (weights: Float32Array) => (i: number): boolean => weights[i] > 0 && weights[i] < 1e-3;
    const fields: [string, Float32Array, Float32Array, number, ((i: number) => boolean) | undefined][] = [
      ['u', reference.u, await readFloats(grid.u, uFaces), width + 1, tiny(reference.uWeight)],
      ['v', reference.v, await readFloats(grid.v, vFaces), width, tiny(reference.vWeight)],
      ['p', reference.p, await readFloats(grid.p, cells), width, undefined],
      ['density', reference.density, await readFloats(grid.density, cells), width, undefined],
    ];
    for (const [field, expected, actual, row, skip] of fields) {
      const tolerance = 1e-4 * Math.max(1, maxAbs(expected));
      const worst = worstDifference(expected, actual, row, skip);
      expect(worst.diff, describeWorst(`${name} ${field}`, worst, tolerance)).toBeLessThanOrEqual(tolerance);
    }
  });
});
