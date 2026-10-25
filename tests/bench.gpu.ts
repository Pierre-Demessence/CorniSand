import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { Simulation, type SimulationOptions } from '../src/simulation';
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
// The scene keeps evolving (sand falls into the water), and the cost of a step depends on it: measure the per-pass split
// after the same run time as the other tests' later rows.
const TIMED_BURN_IN_MS = 20_000;

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

const device = await createDevice({ powerPreference: 'high-performance' }, ['timestamp-query']);

describe.skipIf(!device)('bench', () => {
  it('times the simulation at 2560x1340', async () => {
    const dev = device!;
    const { vendor, architecture, description } = dev.adapterInfo;
    console.log(`Adapter: vendor="${vendor}" architecture="${architecture}" description="${description}"`);
    if (!/nvidia/i.test(`${vendor} ${description}`)) {
      console.log('WARNING: the adapter is not the NVIDIA RTX 4080; these numbers do not count.');
    }

    // Solver cost per frame before and after M1.5c.3, in one run: the default multigrid solve against the plain 40 sweep
    // pairs it replaces, and against no solve at all (the difference to either row is that solver's cost). The all tiles
    // row runs every pass over the whole grid, the cost before the active tiles of M1.5c lever 1.
    const variants: { name: string; options: Pick<SimulationOptions, 'activeTiles' | 'iterations' | 'solver'> }[] = [
      { name: 'multigrid', options: {} },
      { name: 'multigrid, all tiles', options: { activeTiles: false } },
      { name: 'sor 40 pairs', options: { solver: 'sor' } },
      { name: 'no solver', options: { solver: 'sor', iterations: 0 } },
    ];
    const rows: { variant: string; supersteps: number; msPerFrame: number; msPerSuperstep: number }[] = [];
    for (const { name, options } of variants) {
      const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), ...options });
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
      multigrid: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1) }),
      allTiles: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), activeTiles: false }),
      sor: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), solver: 'sor' }),
      noSolver: new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), solver: 'sor', iterations: 0 }),
    };
    for (const sim of Object.values(sims)) sim.load(benchScene());

    const rowsToMeasure: { name: string; sim: Simulation; steps: number; stage: FluidStage }[] = [
      { name: 'frame start only', sim: sims.noSolver, steps: 0, stage: 'grid' },
      { name: 'grid passes, no solver', sim: sims.noSolver, steps, stage: 'grid' },
      { name: 'grid passes, 40 sweep pairs', sim: sims.sor, steps, stage: 'grid' },
      { name: 'grid passes, multigrid', sim: sims.multigrid, steps, stage: 'grid' },
      { name: 'all passes, no solver', sim: sims.noSolver, steps, stage: 'full' },
      { name: 'all passes, 40 sweep pairs', sim: sims.sor, steps, stage: 'full' },
      { name: 'all passes, multigrid', sim: sims.multigrid, steps, stage: 'full' },
      { name: 'all passes, multigrid, all tiles', sim: sims.allTiles, steps, stage: 'full' },
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
    await measureRow(rowsToMeasure[5]);
    const rows: { passes: string; msPerFrame: number }[] = [];
    for (const row of rowsToMeasure) rows.push({ passes: row.name, msPerFrame: await measureRow(row) });
    console.table(rows);
    expect(rows).toHaveLength(rowsToMeasure.length);
  });

  // M1.5c lever 0: GPU time of every pass of a 1x frame (frame start plus 4 fluid steps), from timestamp queries.
  it.each([true, false])('times every fluid pass of a 1x frame at 2560x1340 (active tiles: %s)', async (activeTiles) => {
    const dev = device!;
    if (!dev.features.has('timestamp-query')) {
      console.log('timestamp-query is not available on this adapter; skipping the per-pass timing.');
      return;
    }
    const steps = 4;
    const frames = 15;
    const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), activeTiles });
    sim.load(benchScene());

    const maxPasses = 2048;
    const querySet = dev.createQuerySet({ type: 'timestamp', count: 2 * maxPasses });
    const resolved = dev.createBuffer({ size: 2 * maxPasses * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const staging = dev.createBuffer({ size: 2 * maxPasses * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // One frame: the frame start, then `steps` fluid updates without the CA. Returns ms per "group/pass" summed over the frame.
    let encodeMs = 0;
    let wallMs = 0;
    let spanMs = 0;
    const timedFrame = async (): Promise<Map<string, number>> => {
      const wallStart = performance.now();
      const keys: string[] = [];
      const stamp = (key: string): GPUComputePassTimestampWrites => {
        keys.push(key);
        const i = keys.length - 1;
        if (keys.length > maxPasses) throw new RangeError('raise maxPasses');
        return { querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
      };
      const encoder = dev.createCommandEncoder();
      sim.fluid.recordFrameStartTimed(encoder, stamp('frameStart'));
      for (let s = 0; s < steps; s++) sim.fluid.recordStepTimed(encoder, 'full', (group, label) => stamp(`${group}/${label}`));
      encoder.resolveQuerySet(querySet, 0, 2 * keys.length, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, staging, 0, 2 * keys.length * 8);
      dev.queue.submit([encoder.finish()]);
      encodeMs = performance.now() - wallStart;
      await staging.mapAsync(GPUMapMode.READ, 0, 2 * keys.length * 8);
      const stamps = new BigUint64Array(staging.getMappedRange(0, 2 * keys.length * 8).slice(0));
      staging.unmap();
      wallMs = performance.now() - wallStart;
      spanMs = Number(stamps[2 * keys.length - 1] - stamps[0]) / 1e6;
      const perKey = new Map<string, number>();
      keys.forEach((key, i) => perKey.set(key, (perKey.get(key) ?? 0) + Number(stamps[2 * i + 1] - stamps[2 * i]) / 1e6));
      return perKey;
    };

    for (const start = performance.now(); performance.now() - start < TIMED_BURN_IN_MS;) await timedFrame();
    const samples: Map<string, number>[] = [];
    const encodeTimes: number[] = [];
    const wallTimes: number[] = [];
    const spanTimes: number[] = [];
    for (let i = 0; i < frames; i++) {
      samples.push(await timedFrame());
      encodeTimes.push(encodeMs);
      wallTimes.push(wallMs);
      spanTimes.push(spanMs);
    }

    const rows = [...samples[0].keys()].map((key) => ({
      pass: key,
      msPerFrame: Number(median(samples.map((sample) => sample.get(key) ?? 0)).toFixed(2)),
    }));
    const total = rows.reduce((sum, row) => sum + row.msPerFrame, 0);
    // The same samples by pass group (the solver's levels and kernels collapse into a few rows).
    const groupOf = (key: string): string => key.slice(0, key.indexOf('/') < 0 ? undefined : key.indexOf('/'));
    const groups = [...new Set([...samples[0].keys()].map(groupOf))];
    console.log(`Active tiles: ${activeTiles}`);
    console.table(groups.map((group) => ({
      group,
      msPerFrame: Number(median(samples.map((sample) => [...sample].reduce((sum, [key, ms]) => sum + (groupOf(key) === group ? ms : 0), 0))).toFixed(2)),
    })));
    console.table([
      ...rows,
      { pass: 'TOTAL (sum of medians)', msPerFrame: Number(total.toFixed(2)) },
      { pass: 'GPU span: first pass begins to last pass ends', msPerFrame: Number(median(spanTimes).toFixed(2)) },
      { pass: 'CPU: record and submit', msPerFrame: Number(median(encodeTimes).toFixed(2)) },
      { pass: 'wall: record to results read', msPerFrame: Number(median(wallTimes).toFixed(2)) },
    ]);
    expect(rows.length).toBeGreaterThan(10);
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
