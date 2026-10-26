import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { Simulation } from '../src/simulation';
import { cell, createDevice, idleInput } from './gpu';
import { mulberry32 } from '../src/random';

// GPU time per frame at 2560x1340, the screen-sized grid. Run with `npm run bench`; only numbers from the RTX 4080
// count, the machine also has an Intel iGPU.

const WIDTH = 2560;
const HEIGHT = 1340;
const WALL = 2;
const SAND_SIZE = 200;
// 1x, 2x, 4x and 8x: supersteps per frame.
const SPEEDS = [4, 8, 16, 32];
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 60;
// The GPU clocks down when idle: spend this long at full load first, or the first speed measures the clock ramp.
const BURN_IN_MS = 2000;

// A tank with 2-cell walls and floor, water in the bottom quarter of its interior, a sand block just above the water.
function tankScene(): Uint32Array<ArrayBuffer> {
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

// 75% of the cells a random mix of sand, water, oil and smoke, the rest empty, so everything keeps moving.
function mix75Scene(): Uint32Array<ArrayBuffer> {
  const rand = mulberry32(7);
  const kinds = [T.SAND, T.WATER, T.OIL, T.SMOKE];
  const cells = new Uint32Array(WIDTH * HEIGHT);
  for (let i = 0; i < cells.length; i++) {
    if (rand() % 4 !== 0) cells[i] = cell(kinds[rand() % kinds.length]);
  }
  return cells;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const device = await createDevice({ powerPreference: 'high-performance' });

describe.skipIf(!device)('bench', () => {
  it('times the CA at 2560x1340', async () => {
    const dev = device!;
    const { vendor, architecture, description } = dev.adapterInfo;
    console.log(`Adapter: vendor="${vendor}" architecture="${architecture}" description="${description}"`);
    if (!/nvidia/i.test(`${vendor} ${description}`)) {
      console.log('WARNING: the adapter is not the NVIDIA RTX 4080; these numbers do not count.');
    }

    const scenes: { name: string; build: () => Uint32Array<ArrayBuffer> }[] = [
      { name: 'tank', build: tankScene },
      { name: 'mix75', build: mix75Scene },
    ];
    const rows: { scene: string; supersteps: number; msPerFrame: number; msPerSuperstep: number }[] = [];
    for (const { name, build } of scenes) {
      const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1) });
      sim.load({ kind: build() });

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
          scene: name,
          supersteps,
          msPerFrame: Number(msPerFrame.toFixed(2)),
          msPerSuperstep: Number((msPerFrame / supersteps).toFixed(3)),
        });
      }
    }
    console.table(rows);
    expect(rows).toHaveLength(SPEEDS.length * scenes.length);
  });

  // Backlog D17: what `main.ts` waits for before the first frame. Pipelines are created on the first call (Dawn
  // caches the compiled shaders, so the second call of the same size shows the cost of the buffers alone).
  it('times the simulation creation', async () => {
    const dev = device!;
    const timeOnce = async (width: number, height: number): Promise<{ grid: string; createMs: number; firstFrameMs: number }> => {
      const created = performance.now();
      const sim = new Simulation(dev, width, height, { seedSource: mulberry32(1) });
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
