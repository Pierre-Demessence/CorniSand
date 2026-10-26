import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { MovementProto } from '../src/proto/movement';
import type { MovementModel } from '../src/proto/params';
import { blastScene, pourScene, windScene, type ProtoScene } from '../src/proto/scenes';
import { device } from './gpu';
import { countSand, grainCount } from './proto-metrics';

// Correctness of the M4.1 movement prototype on small grids (docs/plans/m4-element-engine.md, AC2 and determinism).

const MODELS: MovementModel[] = ['baseline', 'a', 'c'];
const W = 256;
const H = 128;

const SCENES: (() => ProtoScene)[] = [
  () => pourScene(W, H, 300, 100),
  () => blastScene(W, H, 30, 16, 8, 120),
  () => windScene(W, H, 10, 200),
];

function setUp(model: MovementModel, scene: ProtoScene, options: { maxFlyers?: number } = {}): MovementProto {
  const proto = new MovementProto(device!, scene.width, scene.height, { model, seed: 3, ...options });
  proto.load(scene.cells);
  proto.setSource(scene.source ?? null);
  if (scene.wind) proto.setWind(...scene.wind);
  if (scene.blast) proto.blast(scene.blast.x, scene.blast.y, scene.blast.radius, scene.blast.speed);
  return proto;
}

async function run(proto: MovementProto, supersteps: number): Promise<void> {
  const dev = device!;
  dev.pushErrorScope('validation');
  for (let left = supersteps; left > 0; left -= 32) {
    const encoder = dev.createCommandEncoder();
    proto.simulate(encoder, Math.min(32, left));
    dev.queue.submit([encoder.finish()]);
  }
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
}

describe.skipIf(!device)('movement prototype', () => {
  for (const model of MODELS) {
    for (const makeScene of SCENES) {
      const scene = makeScene();
      it(`AC2: ${model} keeps every grain in ${scene.name}`, async () => {
        const proto = setUp(model, scene);
        const initial = countSand(scene.cells);
        const counts: number[] = [];
        for (let done = 0; done < scene.supersteps; done += 50) {
          await run(proto, Math.min(50, scene.supersteps - done));
          counts.push((await grainCount(proto)) - (await proto.readStats()).emitted);
        }
        expect(counts, 'grains in the grid and in the air, minus the ones the source added').toEqual(counts.map(() => initial));
        if (scene.source) expect((await proto.readStats()).emitted).toBeGreaterThan(0);
        if (model === 'c' && scene.blast) expect((await proto.readStats()).launched).toBeGreaterThan(0);
      });
    }

    it(`${model} reruns bit-identically from the same seed`, async () => {
      const scene = blastScene(W, H, 30, 16, 8, 120);
      const snapshots: Uint32Array[] = [];
      for (let k = 0; k < 2; k++) {
        const proto = setUp(model, scene);
        await run(proto, 60);
        snapshots.push(await proto.snapshot());
      }
      expect(snapshots[0].length).toBe(snapshots[1].length);
      let mismatches = 0;
      for (let i = 0; i < snapshots[0].length; i++) if (snapshots[0][i] !== snapshots[1][i]) mismatches++;
      expect(mismatches).toBe(0);
    });
  }

  it.each(['a', 'c'] as const)('%s: a grain at 8 cells/dispatch never passes a wall one cell thick', async (model) => {
    const width = 128;
    const height = 64;
    const wallX = 60;
    const cells = new Uint32Array(width * height);
    for (let y = 0; y < height; y++) cells[y * width + wallX] = T.WALL;
    const start = 40 * width + 20;
    cells[start] = T.SAND;
    const motion = new Float32Array(width * height * 4);
    motion[start * 4] = 8;
    motion[start * 4 + 1] = 0.5;
    const proto = new MovementProto(device!, width, height, { model, seed: 1 });
    proto.load(cells, motion);
    for (let k = 0; k < 6; k++) {
      await run(proto, 10);
      const after = await proto.readCells();
      const flyers = await proto.readFlyers();
      expect(countSand(after) + flyers.length).toBe(1);
      for (let i = 0; i < after.length; i++) {
        if (after[i] === T.SAND) expect(i % width, 'the grain in the grid').toBeLessThan(wallX);
      }
      for (const f of flyers) expect(f.x, 'the grain in flight').toBeLessThan(wallX);
    }
    if (model === 'c') expect((await proto.readStats()).launched, 'it flew at least once').toBeGreaterThan(0);
  });

  it('c: launches past the cap stay in the grid, slowed, and nothing is lost', async () => {
    const scene = blastScene(W, H, 30, 24, 8, 0);
    const maxFlyers = 64;
    const proto = setUp('c', scene, { maxFlyers });
    const initial = countSand(scene.cells);
    await run(proto, 1);
    const first = await proto.readStats();
    expect(first.live).toBeLessThanOrEqual(maxFlyers);
    expect(first.launched).toBe(maxFlyers);
    expect(first.capped).toBeGreaterThan(0);
    expect(await grainCount(proto)).toBe(initial);
    await run(proto, 200);
    const later = await proto.readStats();
    expect(later.live).toBeLessThanOrEqual(maxFlyers);
    expect(await grainCount(proto)).toBe(initial);
  });
});
