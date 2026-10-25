import { describe, expect, it } from 'vitest';
import { SCENES } from '../src/scenes';
import { FlipModel } from './cpu/flip';
import { PARTICLE_STRIDE } from '../src/fluid-params';
import { PARTICLE_TYPES as T } from '../src/particles';
import { createSim, device, loadScene, readBuffer, readCells, readFloats, readParticles, run, runFluid } from './gpu';

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
    await runFluid(sim, 1, true, 'grid');

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

interface PerCell {
  count: Uint32Array;
  meanVx: Float64Array;
  meanVy: Float64Array;
}

// Particles binned by the cell they sit in, with the mean velocity per cell: compaction reorders the particles, so
// they are compared per cell.
function binParticles(
  width: number,
  height: number,
  count: number,
  at: (p: number) => { px: number; py: number; vx: number; vy: number },
): PerCell {
  const bins: PerCell = { count: new Uint32Array(width * height), meanVx: new Float64Array(width * height), meanVy: new Float64Array(width * height) };
  for (let p = 0; p < count; p++) {
    const { px, py, vx, vy } = at(p);
    const c = Math.floor(py) * width + Math.floor(px);
    bins.count[c]++;
    bins.meanVx[c] += vx;
    bins.meanVy[c] += vy;
  }
  for (let c = 0; c < bins.count.length; c++) {
    if (bins.count[c] === 0) continue;
    bins.meanVx[c] /= bins.count[c];
    bins.meanVy[c] /= bins.count[c];
  }
  return bins;
}

const isLiquidType = (c: number): boolean => (c & 0xff) === T.WATER || (c & 0xff) === T.OIL;

describe.skipIf(!device)('full fluid step parity with the CPU reference', () => {
  it.each(PARITY_SCENES)('%s: one step (no CA) matches stepGrid + stepParticles + stepRaster', async (name) => {
    const scene = SCENES[name]();
    const { width, height } = scene;

    const cpu = new FlipModel();
    cpu.load(scene);
    cpu.seedVelocities(SEED);
    const sim = createSim(width, height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(SEED);

    cpu.stepGrid();
    cpu.stepParticles();
    cpu.stepRaster();
    await runFluid(sim, 1);

    const gpuCells = await readCells(sim);
    const differing = new Set<number>();
    cpu.cells().forEach((c, i) => {
      if (c !== gpuCells[i]) differing.add(i);
    });

    const ref = cpu.debugState();
    const gpuParticles = await readParticles(sim);
    expect(gpuParticles.count, 'live particles').toBe(ref.px.length);
    const expected = binParticles(width, height, ref.px.length, (p) => ({ px: ref.px[p], py: ref.py[p], vx: ref.vx[p], vy: ref.vy[p] }));
    const f = gpuParticles.floats;
    const actual = binParticles(width, height, gpuParticles.count, (p) => ({
      px: f[p * PARTICLE_STRIDE], py: f[p * PARTICLE_STRIDE + 1], vx: f[p * PARTICLE_STRIDE + 2], vy: f[p * PARTICLE_STRIDE + 3],
    }));
    const countMismatch: number[] = [];
    let worstVelocity = 0;
    for (let c = 0; c < expected.count.length; c++) {
      if (expected.count[c] !== actual.count[c]) {
        countMismatch.push(c);
        continue;
      }
      worstVelocity = Math.max(worstVelocity, Math.abs(expected.meanVx[c] - actual.meanVx[c]), Math.abs(expected.meanVy[c] - actual.meanVy[c]));
    }

    expect(differing.size, 'cells that differ').toBeLessThanOrEqual(2);
    for (const c of countMismatch) expect(differing.has(c), `particle count differs in cell ${c} but its cell type does not`).toBe(true);
    expect(worstVelocity, 'worst mean particle velocity per cell').toBeLessThanOrEqual(1e-4);
  });

  it.each(PARITY_SCENES)('%s: ten steps (with the CA) keep the volumes and nearly all liquid cells', async (name) => {
    const scene = SCENES[name]();
    const { width, height } = scene;

    const cpu = new FlipModel();
    cpu.load(scene);
    cpu.seedVelocities(SEED);
    const sim = createSim(width, height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(SEED);

    cpu.step(10);
    await run(sim, 10);

    const gpuCells = await readCells(sim);
    const cpuCells = cpu.cells();
    const volume = (cells: Uint32Array, type: number): number => cells.filter((c) => (c & 0xff) === type).length;
    for (const type of [T.WATER, T.OIL, T.SAND, T.WALL]) {
      expect(volume(gpuCells, type), `type ${type}`).toBe(volume(cpuCells, type));
    }
    let liquid = 0;
    let differing = 0;
    cpuCells.forEach((c, i) => {
      if (isLiquidType(c) || isLiquidType(gpuCells[i])) liquid++;
      if (c !== gpuCells[i] && (isLiquidType(c) || isLiquidType(gpuCells[i]))) differing++;
    });
    expect(differing / Math.max(1, liquid), 'share of liquid cells that differ').toBeLessThanOrEqual(0.005);
  });
});
