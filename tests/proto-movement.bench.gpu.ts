import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/random';
import { MovementProto } from '../src/proto/movement';
import type { MovementModel } from '../src/proto/params';
import { blastScene, bottomHalfScene, fullScene, pourScene, topHalfScene, windScene, type ProtoScene } from '../src/proto/scenes';
import { createDevice } from './gpu';
import { centerOfMassX, countSand, debrisDistance, grainCount, pileAngle, readGrains } from './proto-metrics';

// M4.1 measurements (docs/plans/m4-element-engine.md): the physics of P1-P3 on a 1024x512 tank and the GPU time of
// T1-T4 at 2560x1340. Only numbers from the RTX 4080 count. Run with `npx vitest run --config vitest.bench.config.ts proto`.

const WIDTH = 2560;
const HEIGHT = 1340;
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 60;
const BURN_IN_MS = 1000;
const FLYER_TARGET = 100_000;
const T3_RADIUS = 128;
const T3_RAMP_FRAMES = 300;
const T3_MAX_BLASTS = 32;

const device = await createDevice({ powerPreference: 'high-performance' }, ['timestamp-query']);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const round = (x: number, digits = 2): number => Number(x.toFixed(digits));

function setUp(model: MovementModel, scene: ProtoScene, timeScale = 1): MovementProto {
  const proto = new MovementProto(device!, scene.width, scene.height, { model, seed: 11, timeScale });
  proto.load(scene.cells);
  proto.setSource(scene.source ?? null);
  if (scene.wind) proto.setWind(...scene.wind);
  if (scene.blast) proto.blast(scene.blast.x, scene.blast.y, scene.blast.radius, scene.blast.speed);
  return proto;
}

async function run(proto: MovementProto, supersteps: number): Promise<void> {
  for (let left = supersteps; left > 0; left -= 32) {
    const encoder = device!.createCommandEncoder();
    proto.simulate(encoder, Math.min(32, left));
    device!.queue.submit([encoder.finish()]);
  }
  await device!.queue.onSubmittedWorkDone();
}

// GPU times of `count` frames of `supersteps`, submitted back to back as a game does (waiting after each frame lets
// the GPU clock down and inflates the times up to 3x). `beforeFrame` may queue work, such as a blast, before frame i.
async function frames(proto: MovementProto, supersteps: number, count: number, beforeFrame?: (i: number) => void): Promise<number[]> {
  const dev = device!;
  const querySet = dev.createQuerySet({ type: 'timestamp', count: 2 * count });
  const resolved = dev.createBuffer({ size: 16 * count, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const staging = dev.createBuffer({ size: 16 * count, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  for (let i = 0; i < count; i++) {
    beforeFrame?.(i);
    const encoder = dev.createCommandEncoder();
    proto.simulate(encoder, supersteps, { querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 });
    dev.queue.submit([encoder.finish()]);
  }
  const encoder = dev.createCommandEncoder();
  encoder.resolveQuerySet(querySet, 0, 2 * count, resolved, 0);
  encoder.copyBufferToBuffer(resolved, 0, staging, 0, 16 * count);
  dev.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const stamps = new BigUint64Array(staging.getMappedRange().slice(0));
  staging.unmap();
  for (const buffer of [resolved, staging]) buffer.destroy();
  querySet.destroy();
  return Array.from({ length: count }, (_, i) => Number(stamps[2 * i + 1] - stamps[2 * i]) / 1e6);
}

// Keeps the GPU at its working clock right before a measurement, on a throwaway grid, so the measured scene starts
// from load.
const burner = (): MovementProto => setUp('a', fullScene(WIDTH, HEIGHT));
async function burnIn(proto: MovementProto): Promise<void> {
  for (const start = performance.now(); performance.now() - start < BURN_IN_MS;) await frames(proto, 16, 10);
}

// Median GPU time of the measured frames that follow the warm-up frames.
async function timeFrames(burn: MovementProto, proto: MovementProto, supersteps: number, beforeFrame?: (i: number) => void, warmup = WARMUP_FRAMES): Promise<number> {
  await burnIn(burn);
  const times = await frames(proto, supersteps, warmup + MEASURED_FRAMES, beforeFrame);
  return median(times.slice(warmup));
}

describe.skipIf(!device)('movement prototype bench', () => {
  it('measures the physics of P1-P3 and determinism', async () => {
    const { vendor, architecture, description } = device!.adapterInfo;
    console.log(`Adapter: vendor="${vendor}" architecture="${architecture}" description="${description}"`);

    const rows: Record<string, number | string | boolean>[] = [];
    const variants: { name: string; model: MovementModel; timeScale: number }[] = [
      { name: 'baseline', model: 'baseline', timeScale: 1 },
      { name: 'A', model: 'a', timeScale: 1 },
      { name: 'C', model: 'c', timeScale: 1 },
      { name: 'A at 4x steps', model: 'a', timeScale: 4 },
    ];
    for (const { name, model, timeScale } of variants) {
      const pour = pourScene();
      const p1 = setUp(model, pour, timeScale);
      await run(p1, pour.pourSupersteps * timeScale);
      p1.setSource(null);
      await run(p1, (pour.supersteps - pour.pourSupersteps) * timeScale);
      const angle = pileAngle(await p1.readCells(), pour.width, pour.height);
      const p1Stats = await p1.readStats();
      const p1Conserved = (await grainCount(p1)) === p1Stats.emitted;

      const blast = blastScene();
      const snapshots: Uint32Array[] = [];
      let distance = 0;
      let p2Conserved = true;
      let launched = 0;
      let jammed = 0;
      let maxRetries = 0;
      const initial = countSand(blast.cells);
      for (let k = 0; k < 2; k++) {
        const p2 = setUp(model, blast, timeScale);
        await run(p2, blast.supersteps * timeScale);
        snapshots.push(await p2.snapshot());
        if (k === 0) {
          distance = debrisDistance(await readGrains(p2), blast.blast!.x, blast.blast!.y);
          p2Conserved = (await grainCount(p2)) === initial;
          const stats = await p2.readStats();
          launched = stats.launched;
          jammed = stats.jammed;
          maxRetries = stats.maxRetries;
        }
      }
      const identical = snapshots[0].length === snapshots[1].length && snapshots[0].every((w, i) => w === snapshots[1][i]);

      const wind = windScene();
      const p3 = setUp(model, wind, timeScale);
      const before = centerOfMassX(await readGrains(p3));
      await run(p3, wind.supersteps * timeScale);
      const drift = centerOfMassX(await readGrains(p3)) - before;

      rows.push({
        model: name,
        'P1 pile angle (deg)': round(angle, 1),
        'P1 grains': p1Stats.emitted,
        'P2 debris p99 (cells)': round(distance, 1),
        'P3 wind drift (cells)': round(drift, 2),
        'P2 launched': launched,
        'P2 jammed (>=8 retries)': jammed,
        'P2 max retries': maxRetries,
        conserved: p1Conserved && p2Conserved,
        'bit-identical rerun': identical,
      });
    }
    console.table(rows);
    expect(rows).toHaveLength(variants.length);
  }, 600_000);

  it('times T1-T4 at 2560x1340', async () => {
    expect(device!.features.has('timestamp-query')).toBe(true);
    const rows: Record<string, number | string>[] = [];
    const burn = burner();

    for (const model of ['baseline', 'a', 'c'] as const) {
      for (const make of [fullScene, topHalfScene]) {
        const speeds = model === 'a' ? [4, 8, 16] : [4];
        for (const supersteps of speeds) {
          const scene = make(WIDTH, HEIGHT);
          const proto = setUp(model, scene);
          const ms = await timeFrames(burn, proto, supersteps);
          const stats = await proto.readStats();
          rows.push({ test: scene.name === 'full' ? 'T1 full, at rest' : 'T2 top half falling', model, speed: `${supersteps / 4}x`, msPerFrame: round(ms), flyers: stats.live });
        }
      }
    }

    // T3: blasts under the surface of a half-full screen keep about FLYER_TARGET flyers in the air under C. The
    // schedule comes from a closed-loop run (reading the flyer count each frame, untimed), then C and A replay it.
    const ground = bottomHalfScene(WIDTH, HEIGHT);
    const blastY = HEIGHT / 2 - T3_RADIUS / 2;
    const random = mulberry32(5);
    const ramp = setUp('c', ground);
    const schedule: number[][] = [];
    const liveCounts: number[] = [];
    for (let i = 0; i < T3_RAMP_FRAMES + MEASURED_FRAMES; i++) {
      const { live } = await ramp.readStats();
      // About one blast per 5k missing flyers, at most T3_MAX_BLASTS a frame.
      const count = live < FLYER_TARGET ? Math.min(T3_MAX_BLASTS, Math.ceil((FLYER_TARGET - live) / 5_000)) : 0;
      const xs = Array.from({ length: count }, () => T3_RADIUS + Math.floor((random() / 2 ** 32) * (WIDTH - 2 * T3_RADIUS)));
      for (const x of xs) ramp.blast(x, blastY, T3_RADIUS, 8);
      schedule.push(xs);
      if (i >= T3_RAMP_FRAMES) liveCounts.push(live);
      await run(ramp, 4);
    }
    const replay = (proto: MovementProto) => (i: number): void => {
      for (const x of schedule[i]) proto.blast(x, blastY, T3_RADIUS, 8);
    };
    for (const model of ['c', 'a'] as const) {
      const proto = setUp(model, ground);
      const ms = await timeFrames(burn, proto, 4, replay(proto), T3_RAMP_FRAMES);
      rows.push({ test: model === 'c' ? `T3 blasts, ~${FLYER_TARGET / 1000}k flyers` : 'T3 blasts (same blasts)', model, speed: '1x', msPerFrame: round(ms), flyers: model === 'c' ? median(liveCounts) : 0 });
    }

    // T3 at the cap: one blast that launches more grains than the flyer list holds.
    const capped = setUp('c', ground);
    await burnIn(burn);
    const capTimes = await frames(capped, 4, 20, (i) => {
      if (i === 0) capped.blast(WIDTH / 2, HEIGHT / 2, 700, 8);
    });
    const capStats = await capped.readStats();
    rows.push({ test: 'T3 one blast past the cap (20 frames)', model: 'c', speed: '1x', msPerFrame: round(median(capTimes)), flyers: capStats.live });
    rows.push({ test: `T3 past the cap, slowest frame (${capStats.capped} launches refused)`, model: 'c', speed: '1x', msPerFrame: round(Math.max(...capTimes)), flyers: capStats.live });

    console.table(rows);
    expect(rows.length).toBeGreaterThan(8);
  }, 600_000);
});
