import { describe, expect, it } from 'vitest';
import { type CellData, tempView } from '../src/cell-fields';
import { ELEMENT as T } from '../src/elements';
import { packHalf2 } from '../src/half';
import { AIR_CELL_SIZES, type AirCellSize } from '../src/air';
import type { PassTimer } from '../src/passes';
import { Display } from '../src/display';
import { LOOK, type Look } from '../src/look';
import { Simulation } from '../src/simulation';
import { cell, createDevice, idleInput } from './gpu';
import { mulberry32 } from '../src/random';

// GPU time per frame at 2560x1340, the screen-sized grid, from timestamp queries. Run with `npm run bench`; only
// numbers from the RTX 4080 count, the machine also has an Intel iGPU. The element engine stays under 4 ms per 1x
// frame (docs/powder-toy.md, "Frame budget").
// BENCH_SCENES=mix75,blast runs only those scenes; BENCH_SPLIT_ONLY=1 only the 1x breakdown by pass. BENCH_AIR=1,2,4,8
// runs every scene at each of those air cell sizes (`off` for no air); the default is the simulation's own. The air
// passes show in the breakdown under their own labels, and their sum in the `air` column. Every measured frame also
// renders into a screen-sized texture after the simulation; the render passes show under `render:` labels, their sum
// in the `render` column (the `sum` column is the simulation's alone). Every scene runs in the finished and in the cells
// look (the `look` column); BENCH_LOOKS=cells narrows it to one.

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
// The renderer's passes, for the timestamp query count: coverage, a down and an up pass per glow level, the shadow pass and
// the composite.
const RENDER_PASSES = 3 + 2 * LOOK.glowLevels;
const isRenderLabel = (label: string): boolean => label.startsWith('render:');

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

const POT_PLATE_ROWS = 8;
const POT_PLATE_TEMP = 700;
const ROOM = 20;

// A screen-wide tank, water in the bottom quarter of its interior on a metal plate at 700 C (the `physics` scene's
// pot, scaled up): the plate heats the water from below, which convects and boils at the plate.
function potScene(): Fields {
  const kind = new Uint32Array(WIDTH * HEIGHT);
  const fill = (type: number, x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) kind.fill(cell(type), y * WIDTH + x0, y * WIDTH + x1);
  };
  frame(kind, WIDTH, HEIGHT);
  const plateTop = WALL + POT_PLATE_ROWS;
  fill(T.METAL, WALL, WIDTH - WALL, WALL, plateTop);
  fill(T.WATER, WALL, WIDTH - WALL, plateTop, WALL + Math.floor((HEIGHT - WALL) / 4));
  const data = { temp: new Uint32Array(WIDTH * HEIGHT) };
  tempView(data).forEach((_, i, temps) => {
    temps[i] = i < plateTop * WIDTH ? POT_PLATE_TEMP : ROOM;
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
const sumLabels = (times: Map<string, number>, wanted: (label: string) => boolean): number =>
  [...times].filter(([label]) => wanted(label)).reduce((a, [, ms]) => a + ms, 0);
const round = (x: number, digits = 2): number => Number(x.toFixed(digits));

const device = await createDevice({ powerPreference: 'high-performance' }, ['timestamp-query']);

interface Renderer {
  display: Display;
  target: GPUTexture;
  look: Look;
}

const RENDER_OPTIONS = { mousePos: { x: 0, y: 0 }, brushSize: 0, showBrush: false, erasing: false, replacing: false };

const LOOKS: Look[] = ['finished', 'cells'];

// Per frame, the GPU milliseconds of each label: the sum over that label's passes ('frame' for the whole frame when
// `perPass` is false). Frames are submitted back to back, as a game does; waiting after each frame lets the GPU clock
// down and inflates the times up to 3x.
async function timeFrames(
  sim: Simulation,
  renderer: Renderer,
  supersteps: number,
  count: number,
  perPass: boolean,
): Promise<Map<string, number>[]> {
  const dev = device!;
  // Brush, then per superstep two CA dispatches and eight flyer passes, plus one spare.
  // The air adds its mask pass and, per superstep, five passes per air step (up to four at 1x1).
  const maxPasses = 2 + supersteps * (11 + 5 * 4) + RENDER_PASSES;
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
    sim.recordOverlay(encoder);
    renderer.display.render(encoder, renderer.target.createView(), WIDTH, HEIGHT, { ...RENDER_OPTIONS, look: renderer.look }, timer);
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
      // The plate starts convection at once; 100 frames let the plumes and the boiling at the plate develop.
      { name: 'pot', build: potScene, warmup: 100 },
    ];
    const only = process.env.BENCH_SCENES?.split(',');
    const splitOnly = process.env.BENCH_SPLIT_ONLY === '1';
    const airRuns = (process.env.BENCH_AIR?.split(',') ?? [undefined]).map((entry): { label: string; options: { air?: boolean; airCellSize?: AirCellSize } } => {
      if (entry === undefined) return { label: 'default', options: {} };
      if (entry === 'off') return { label: 'off', options: { air: false } };
      const size = AIR_CELL_SIZES.find((candidate) => String(candidate) === entry);
      if (size === undefined) throw new Error(`BENCH_AIR: "${entry}" is not off or one of ${AIR_CELL_SIZES.join(', ')}`);
      return { label: entry, options: { airCellSize: size } };
    });
    const looks = (process.env.BENCH_LOOKS?.split(',') ?? LOOKS).map((entry) => {
      const look = LOOKS.find((candidate) => candidate === entry);
      if (look === undefined) throw new Error(`BENCH_LOOKS: "${entry}" is not one of ${LOOKS.join(', ')}`);
      return look;
    });
    const burner = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(2) });
    burner.load(full100Scene());
    const burnerRenderer: Renderer = {
      display: new Display(dev, 'bgra8unorm', WIDTH, HEIGHT, burner.fields, burner.elements, burner.flyers.overlay, { air: burner.air }),
      target: dev.createTexture({ size: [WIDTH, HEIGHT], format: 'bgra8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }),
      look: 'finished',
    };
    const burnIn = async (): Promise<void> => {
      for (const start = performance.now(); performance.now() - start < BURN_IN_MS;) await timeFrames(burner, burnerRenderer, 32, 4, false);
    };

    const rows: Record<string, string | number>[] = [];
    const breakdown: Record<string, Record<string, number>> = {};
    for (const { label: air, options: airOptions } of airRuns) for (const { name, build, warmup } of scenes) {
      if (only && !only.includes(name)) continue;
      const fields = build();
      const sim = new Simulation(dev, WIDTH, HEIGHT, { seedSource: mulberry32(1), ...airOptions });
      // Dawn compiles a pipeline on its first use: not inside a measured frame.
      sim.load(fields);
      const renderer: Renderer = {
        display: new Display(dev, 'bgra8unorm', WIDTH, HEIGHT, sim.fields, sim.elements, sim.flyers.overlay, { air: sim.air }),
        target: dev.createTexture({ size: [WIDTH, HEIGHT], format: 'bgra8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT }),
        look: looks[0],
      };
      await timeFrames(sim, renderer, 1, 2, true);

      const measure = async (supersteps: number, perPass: boolean): Promise<Map<string, number>[]> => {
        await burnIn();
        sim.load(fields);
        if (warmup > 0) await timeFrames(sim, renderer, supersteps, warmup, perPass);
        return timeFrames(sim, renderer, supersteps, MEASURED_FRAMES, perPass);
      };

      for (const look of looks) {
        renderer.look = look;
        for (const supersteps of splitOnly ? [] : SPEEDS) {
          const measured = await measure(supersteps, false);
          const times = measured.map((t) => t.get('frame')!);
          const renderTimes = measured.map((t) => sumLabels(t, isRenderLabel));
          const stats = supersteps === SPEEDS[0] && name === 'blast' ? await sim.flyers.readStats() : undefined;
          rows.push({
            scene: name,
            air,
            look,
            speed: `${supersteps / SPEEDS[0]}x`,
            msMedian: round(median(times)),
            msMax: round(Math.max(...times)),
            renderMs: round(median(renderTimes)),
            msPerSuperstep: round(median(times) / supersteps, 3),
            ...(stats && { launched: stats.launched }),
          });
        }

        // Every pass in a compute pass of its own at 1x: the mean per frame of each label, and their sum.
        const split = await measure(SPEEDS[0], true);
        const labels = [...split[0].keys()];
        const perLabel = Object.fromEntries(labels.map((label) => [label, round(mean(split.map((t) => t.get(label) ?? 0)), 3)]));
        perLabel.air = round(mean(split.map((t) => sumLabels(t, (label) => label.startsWith('air')))), 3);
        perLabel.render = round(mean(split.map((t) => sumLabels(t, isRenderLabel))), 3);
        perLabel.sum = round(mean(split.map((t) => sumLabels(t, (label) => !isRenderLabel(label)))), 3);
        breakdown[`${name} (air ${air}, ${look} look)`] = perLabel;
      }
    }
    console.log('GPU ms per frame (one compute pass, as the game records it):');
    console.table(rows);
    console.log('GPU ms per 1x frame by pass (mean of the frames, every pass split into its own compute pass):');
    console.table(breakdown);
    if (!only && !splitOnly) expect(rows).toHaveLength(SPEEDS.length * scenes.length * airRuns.length * looks.length);
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
