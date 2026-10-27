import { describe, expect, it } from 'vitest';
import { type CellData, tempView } from '../src/cell-fields';
import { ELEMENT as T } from '../src/elements';
import { packHalf2 } from '../src/half';
import type { PassTimer } from '../src/passes';
import { Simulation } from '../src/simulation';
import { cell, createDevice, idleInput } from './gpu';
import { mulberry32 } from '../src/random';

// GPU time per frame at 2560x1340, the screen-sized grid, from timestamp queries. Run with `npm run bench`; only
// numbers from the RTX 4080 count, the machine also has an Intel iGPU. The element engine stays under 4 ms per 1x
// frame (docs/powder-toy.md, "Frame budget").
// BENCH_SCENES=mix75,blast runs only those scenes; BENCH_SPLIT_ONLY=1 only the 1x breakdown by pass.

const WIDTH = 2560;
const HEIGHT = 1340;
const WALL = 2;
const SAND_SIZE = 200;
// 1x, 2x, 4x and 8x: supersteps per frame.
const SPEEDS = [4, 8, 16, 32];
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 60;
// The GPU clocks down when idle: spend this long at full load before each measurement, or it measures the clock ramp.
const BURN_IN_MS = 1000;

type Fields = Partial<CellData>;

function frame(cells: Uint32Array, width: number, height: number): void {
  const fill = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) cells.fill(cell(T.WALL), y * width + x0, y * width + x1);
  };
  fill(0, WALL, 0, height);
  fill(width - WALL, width, 0, height);
  fill(0, width, 0, WALL);
}

// A tank with 2-cell walls and floor, water in the bottom quarter of its interior, a sand block just above the water.
function tankScene(): Fields {
  const cells = new Uint32Array(WIDTH * HEIGHT);
  const fill = (type: number, x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) cells.fill(cell(type), y * WIDTH + x0, y * WIDTH + x1);
  };
  frame(cells, WIDTH, HEIGHT);
  const waterTop = WALL + Math.floor((HEIGHT - WALL) / 4);
  fill(T.WATER, WALL, WIDTH - WALL, WALL, waterTop);
  const sandX = (WIDTH - SAND_SIZE) / 2;
  const sandY = waterTop + 8;
  fill(T.SAND, sandX, sandX + SAND_SIZE, sandY, sandY + SAND_SIZE);
  return { kind: cells };
}

const MIX = [T.SAND, T.WATER, T.OIL, T.SMOKE];

// 75% of the cells a random mix of sand, water, oil and smoke, the rest empty, so everything keeps moving.
function mix75Scene(): Fields {
  const rand = mulberry32(7);
  const cells = new Uint32Array(WIDTH * HEIGHT);
  for (let i = 0; i < cells.length; i++) {
    if (rand() % 4 !== 0) cells[i] = cell(MIX[rand() % MIX.length]);
  }
  return { kind: cells };
}

// Every cell inside a wall frame a random mix of sand, water, oil and smoke: no empty cell, only density swaps.
function full100Scene(): Fields {
  const rand = mulberry32(8);
  const cells = new Uint32Array(WIDTH * HEIGHT);
  for (let i = 0; i < cells.length; i++) cells[i] = cell(MIX[rand() % MIX.length]);
  frame(cells, WIDTH, HEIGHT);
  for (let x = 0; x < WIDTH; x++) {
    for (let y = HEIGHT - WALL; y < HEIGHT; y++) cells[y * WIDTH + x] = cell(T.WALL);
  }
  return { kind: cells };
}

const THERMAL_MIX = [T.METAL, T.STONE, T.WATER, T.ICE, T.LAVA, T.SAND];
const HOT = 1300;
const COLD = -20;

// Every cell inside a wall frame a random mix of metal, stone, water, ice, lava and sand, the top half at 1,300 C and
// the bottom half at -20 C, so heat flows and phases change (water boils, lava sets, ice melts) through the frames.
function thermalScene(): Fields {
  const rand = mulberry32(9);
  const kind = new Uint32Array(WIDTH * HEIGHT);
  for (let i = 0; i < kind.length; i++) kind[i] = cell(THERMAL_MIX[rand() % THERMAL_MIX.length]);
  frame(kind, WIDTH, HEIGHT);
  for (let x = 0; x < WIDTH; x++) {
    for (let y = HEIGHT - WALL; y < HEIGHT; y++) kind[y * WIDTH + x] = cell(T.WALL);
  }
  const data = { temp: new Uint32Array(WIDTH * HEIGHT) };
  tempView(data).forEach((_, i, temps) => {
    temps[i] = i < (WIDTH * HEIGHT) / 2 ? COLD : HOT;
  });
  return { kind, temp: data.temp };
}

// The `blast` scene at screen size: a sand layer a fifth of the height deep, hit by five blasts along its surface at
// once, each throwing every grain within BLAST_RADIUS away from its center (BLAST_SPEED cells per dispatch at the
// center, falling to 0 at the edge), as `src/scenes.ts` does for one.
const BLAST_RADIUS = 64;
const BLAST_SPEED = 8;
const BLASTS = 5;
function blastScene(): Fields {
  const kind = new Uint32Array(WIDTH * HEIGHT);
  const velocity = new Uint32Array(WIDTH * HEIGHT);
  frame(kind, WIDTH, HEIGHT);
  const depth = Math.floor(HEIGHT / 5);
  for (let y = WALL; y < WALL + depth; y++) kind.fill(cell(T.SAND), y * WIDTH + WALL, y * WIDTH + WIDTH - WALL);
  const cy = WALL + depth - BLAST_RADIUS / 2;
  for (let b = 0; b < BLASTS; b++) {
    const cx = (WIDTH * (b + 0.5)) / BLASTS;
    for (let y = Math.max(0, Math.floor(cy - BLAST_RADIUS)); y < cy + BLAST_RADIUS; y++) {
      for (let x = Math.floor(cx - BLAST_RADIUS); x < cx + BLAST_RADIUS; x++) {
        const i = y * WIDTH + x;
        if (kind[i] !== cell(T.SAND)) continue;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        if (dist >= BLAST_RADIUS) continue;
        const push = dist > 0 ? (BLAST_SPEED * (1 - dist / BLAST_RADIUS)) / dist : 0;
        velocity[i] = packHalf2(dx * push, dist > 0 ? dy * push : BLAST_SPEED);
      }
    }
  }
  return { kind, velocity };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const round = (x: number, digits = 2): number => Number(x.toFixed(digits));

const device = await createDevice({ powerPreference: 'high-performance' }, ['timestamp-query']);

// Per frame, the GPU milliseconds of each label: the sum over that label's passes ('frame' for the whole frame when
// `perPass` is false). Frames are submitted back to back, as a game does; waiting after each frame lets the GPU clock
// down and inflates the times up to 3x.
async function timeFrames(sim: Simulation, supersteps: number, count: number, perPass: boolean): Promise<Map<string, number>[]> {
  const dev = device!;
  // Brush, then per superstep two CA dispatches and eight flyer passes, plus one spare.
  const maxPasses = 1 + supersteps * 11;
  const pending: { labels: string[]; staging: GPUBuffer; destroy: GPUBuffer[]; querySet: GPUQuerySet }[] = [];
  for (let f = 0; f < count; f++) {
    const querySet = dev.createQuerySet({ type: 'timestamp', count: 2 * maxPasses });
    const resolved = dev.createBuffer({ size: 16 * maxPasses, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const staging = dev.createBuffer({ size: 16 * maxPasses, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const labels: string[] = [];
    const timer: PassTimer = {
      perPass,
      stamp: (label) => {
        const at = labels.push(label) - 1;
        return { querySet, beginningOfPassWriteIndex: 2 * at, endOfPassWriteIndex: 2 * at + 1 };
      },
    };
    const encoder = dev.createCommandEncoder();
    sim.simulate(encoder, supersteps, idleInput, timer);
    encoder.resolveQuerySet(querySet, 0, 2 * labels.length, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, staging, 0, 16 * labels.length);
    dev.queue.submit([encoder.finish()]);
    pending.push({ labels, staging, destroy: [resolved, staging], querySet });
  }
  const result: Map<string, number>[] = [];
  for (const { labels, staging, destroy, querySet } of pending) {
    await staging.mapAsync(GPUMapMode.READ);
    const stamps = new BigUint64Array(staging.getMappedRange().slice(0, 16 * labels.length));
    staging.unmap();
    const times = new Map<string, number>();
    labels.forEach((label, k) => times.set(label, (times.get(label) ?? 0) + Number(stamps[2 * k + 1] - stamps[2 * k]) / 1e6));
    result.push(times);
    for (const buffer of destroy) buffer.destroy();
    querySet.destroy();
  }
  return result;
}

describe.skipIf(!device)('bench', () => {
  it('times the CA at 2560x1340', async () => {
    const dev = device!;
    const { vendor, architecture, description } = dev.adapterInfo;
    console.log(`Adapter: vendor="${vendor}" architecture="${architecture}" description="${description}"`);
    if (!/nvidia/i.test(`${vendor} ${description}`)) {
      console.log('WARNING: the adapter is not the NVIDIA RTX 4080; these numbers do not count.');
    }
    expect(dev.features.has('timestamp-query')).toBe(true);

    // `warmup` frames after each load before the measured ones; none for the blast, whose debris lands within about
    // 60 frames at 1x.
    const scenes: { name: string; build: () => Fields; warmup: number }[] = [
      { name: 'tank', build: tankScene, warmup: WARMUP_FRAMES },
      { name: 'mix75', build: mix75Scene, warmup: WARMUP_FRAMES },
      { name: 'full100', build: full100Scene, warmup: WARMUP_FRAMES },
      { name: 'blast', build: blastScene, warmup: 0 },
      { name: 'thermal', build: thermalScene, warmup: WARMUP_FRAMES },
    ];
    const only = process.env.BENCH_SCENES?.split(',');
    const splitOnly = process.env.BENCH_SPLIT_ONLY === '1';
    const burner = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(2) });
    burner.load(full100Scene());
    const burnIn = async (): Promise<void> => {
      for (const start = performance.now(); performance.now() - start < BURN_IN_MS;) await timeFrames(burner, 32, 4, false);
    };

    const rows: Record<string, string | number>[] = [];
    const breakdown: Record<string, Record<string, number>> = {};
    for (const { name, build, warmup } of scenes) {
      if (only && !only.includes(name)) continue;
      const fields = build();
      const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1) });
      // Dawn compiles a pipeline on its first use: not inside a measured frame.
      sim.load(fields);
      await timeFrames(sim, 1, 2, true);

      const measure = async (supersteps: number, perPass: boolean): Promise<Map<string, number>[]> => {
        await burnIn();
        sim.load(fields);
        if (warmup > 0) await timeFrames(sim, supersteps, warmup, perPass);
        return timeFrames(sim, supersteps, MEASURED_FRAMES, perPass);
      };

      for (const supersteps of splitOnly ? [] : SPEEDS) {
        const times = (await measure(supersteps, false)).map((t) => t.get('frame')!);
        const stats = supersteps === SPEEDS[0] && name === 'blast' ? await sim.flyers.readStats() : undefined;
        rows.push({
          scene: name,
          speed: `${supersteps / SPEEDS[0]}x`,
          msMedian: round(median(times)),
          msMax: round(Math.max(...times)),
          msPerSuperstep: round(median(times) / supersteps, 3),
          ...(stats && { launched: stats.launched }),
        });
      }

      // Every pass in a compute pass of its own at 1x: the mean per frame of each label, and their sum.
      const split = await measure(SPEEDS[0], true);
      const labels = [...split[0].keys()];
      const perLabel = Object.fromEntries(labels.map((label) => [label, round(mean(split.map((t) => t.get(label) ?? 0)), 3)]));
      perLabel.sum = round(mean(split.map((t) => [...t.values()].reduce((a, b) => a + b, 0))), 3);
      breakdown[name] = perLabel;
    }
    console.log('GPU ms per frame (one compute pass, as the game records it):');
    console.table(rows);
    console.log('GPU ms per 1x frame by pass (mean of the frames, every pass split into its own compute pass):');
    console.table(breakdown);
    if (!only && !splitOnly) expect(rows).toHaveLength(SPEEDS.length * scenes.length);
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
