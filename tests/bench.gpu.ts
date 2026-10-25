import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { Simulation } from '../src/simulation';
import { cell, createDevice, idleInput } from './gpu';
import type { FluidStage } from '../src/fluid';
import { mulberry32 } from '../src/random';

// GPU time per frame at 2560x1340, the screen-sized grid of AC14. Run with `npm run bench`; only numbers from the
// RTX 4080 count, the machine also has an Intel iGPU.

const WIDTH = 2560;
const HEIGHT = 1340;
const WALL = 2;
const SAND_SIZE = 200;
const SPEEDS = [4, 8, 16, 32];
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 60;
// The GPU clocks down when idle: spend this long at full load first, or the first speed measures the clock ramp.
const BURN_IN_MS = 2000;

// A tank with 2-cell walls and floor, water in the bottom quarter of its interior, a sand block just above the water.
function benchScene(): Uint32Array<ArrayBuffer> {
  const cells = new Uint32Array(WIDTH * HEIGHT);
  const fill = (type: number, x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) cells.fill(cell(type), y * WIDTH + x0, y * WIDTH + x1);
  };
  const waterTop = WALL + Math.floor((HEIGHT - WALL) / 4);
  fill(T.WALL, 0, WALL, 0, HEIGHT);
  fill(T.WALL, WIDTH - WALL, WIDTH, 0, HEIGHT);
  fill(T.WALL, 0, WIDTH, 0, WALL);
  fill(T.WATER, WALL, WIDTH - WALL, WALL, waterTop);
  const sandX = (WIDTH - SAND_SIZE) / 2;
  const sandY = waterTop + 8;
  fill(T.SAND, sandX, sandX + SAND_SIZE, sandY, sandY + SAND_SIZE);
  return cells;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const device = await createDevice({ powerPreference: 'high-performance' });

describe.skipIf(!device)('bench', () => {
  it('times the simulation at 2560x1340', async () => {
    const dev = device!;
    const { vendor, architecture, description } = dev.adapterInfo;
    console.log(`Adapter: vendor="${vendor}" architecture="${architecture}" description="${description}"`);
    if (!/nvidia/i.test(`${vendor} ${description}`)) {
      console.log('WARNING: the adapter is not the NVIDIA RTX 4080; these numbers do not count.');
    }

    // `iterations` is the number of pressure sweep pairs per step: the full-solver run minus the `iterations: 0` run is
    // the solver's cost, and the half run shows whether that cost scales with the sweep count.
    const variants = [
      { name: 'full solver', iterations: undefined },
      { name: 'iterations 20', iterations: 20 },
      { name: 'iterations 0', iterations: 0 },
    ];
    const rows: { variant: string; supersteps: number; msPerFrame: number; msPerSuperstep: number }[] = [];
    for (const { name, iterations } of variants) {
      const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), iterations });
      sim.load(benchScene());

      const frame = async (supersteps: number): Promise<number> => {
        const start = performance.now();
        const encoder = dev.createCommandEncoder();
        sim.simulate(encoder, supersteps, idleInput);
        dev.queue.submit([encoder.finish()]);
        await dev.queue.onSubmittedWorkDone();
        return performance.now() - start;
      };

      for (const start = performance.now(); performance.now() - start < BURN_IN_MS;) await frame(Math.max(...SPEEDS));

      for (const supersteps of SPEEDS) {
        for (let i = 0; i < WARMUP_FRAMES; i++) await frame(supersteps);
        const times: number[] = [];
        for (let i = 0; i < MEASURED_FRAMES; i++) times.push(await frame(supersteps));
        const msPerFrame = median(times);
        rows.push({
          variant: name,
          supersteps,
          msPerFrame: Number(msPerFrame.toFixed(2)),
          msPerSuperstep: Number((msPerFrame / supersteps).toFixed(3)),
        });
      }
    }
    console.table(rows);
    expect(rows).toHaveLength(SPEEDS.length * variants.length);
  });

  // Where the time of a 1x frame (4 fluid steps) goes, with no CA: each row records the fluid passes alone, so the
  // differences between rows are the cost of the passes that one row has and the other lacks.
  it('splits a 1x frame by pass group at 2560x1340', async () => {
    const dev = device!;
    const steps = 4;
    const sims = {
      full: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1) }),
      noSweeps: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), iterations: 0 }),
    };
    for (const sim of Object.values(sims)) sim.load(benchScene());

    const rowsToMeasure: { name: string; sim: Simulation; steps: number; stage: FluidStage }[] = [
      { name: 'frame start only', sim: sims.noSweeps, steps: 0, stage: 'grid' },
      { name: 'grid passes 1-13, no sweeps', sim: sims.noSweeps, steps, stage: 'grid' },
      { name: 'grid passes 1-13, 40 sweep pairs', sim: sims.full, steps, stage: 'grid' },
      { name: 'passes 1-19, no sweeps', sim: sims.noSweeps, steps, stage: 'full' },
      { name: 'passes 1-19, 40 sweep pairs', sim: sims.full, steps, stage: 'full' },
    ];
    const measureRow = async (row: (typeof rowsToMeasure)[number]): Promise<number> => {
      const frame = async (): Promise<number> => {
        const start = performance.now();
        const encoder = dev.createCommandEncoder();
        const pass = encoder.beginComputePass();
        row.sim.fluid.recordFrameStart(pass, null);
        for (let s = 0; s < row.steps; s++) row.sim.fluid.recordStep(pass, row.stage);
        pass.end();
        dev.queue.submit([encoder.finish()]);
        await dev.queue.onSubmittedWorkDone();
        return performance.now() - start;
      };
      for (let i = 0; i < WARMUP_FRAMES; i++) await frame();
      const times: number[] = [];
      for (let i = 0; i < MEASURED_FRAMES; i++) times.push(await frame());
      return Number(median(times).toFixed(2));
    };

    // The heaviest row first, so the GPU is at full clock when the lighter rows are timed.
    await measureRow(rowsToMeasure[4]);
    const rows: { passes: string; msPerFrame: number }[] = [];
    for (const row of rowsToMeasure) rows.push({ passes: row.name, msPerFrame: await measureRow(row) });
    console.table(rows);
    expect(rows).toHaveLength(rowsToMeasure.length);
  });

  // Backlog D17: what `main.ts` waits for before the first frame. Pipelines are created on the first call (Dawn
  // caches the compiled shaders, so the second call of the same size shows the cost of the buffers alone).
  it('times the simulation creation', async () => {
    const dev = device!;
    const timeOnce = async (width: number, height: number): Promise<{ grid: string; createMs: number; firstFrameMs: number }> => {
      const created = performance.now();
      const sim = await Simulation.create(dev, width, height, { seedSource: mulberry32(1) });
      const createMs = performance.now() - created;
      const encoder = dev.createCommandEncoder();
      sim.simulate(encoder, 2, idleInput);
      dev.queue.submit([encoder.finish()]);
      await dev.queue.onSubmittedWorkDone();
      return {
        grid: `${width}x${height}`,
        createMs: Math.round(createMs),
        firstFrameMs: Math.round(performance.now() - created - createMs),
      };
    };
    console.table([await timeOnce(64, 64), await timeOnce(64, 64), await timeOnce(1920, 898), await timeOnce(1920, 898)]);
  });
});
