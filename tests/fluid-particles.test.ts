import { describe, expect, it } from 'vitest';
import { FLUID, PARTICLE_KIND, PARTICLE_STRIDE, spawnParticles } from '../src/fluid-params';
import { PARTICLE_TYPES as T } from '../src/particles';
import { SCENES } from '../src/scenes';
import type { SimulationInput } from '../src/simulation';
import { FlipModel } from './cpu/flip';
import {
  cell,
  createSim,
  device,
  idleInput,
  loadScene,
  particleRows,
  readBuffer,
  readCells,
  readFluidState,
  readParticles,
  run,
  type ParticleRecords,
} from './gpu';

const WIDTH = 40;
const HEIGHT = 24;

function emptyGrid(width = WIDTH, height = HEIGHT): Uint32Array<ArrayBuffer> {
  return new Uint32Array(width * height);
}

function fill(cells: Uint32Array, width: number, type: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) cells.fill(cell(type), y * width + x0, y * width + x1);
}

// A brush stroke from (x0, y) to (x1, y); a point when x1 is omitted.
function stroke(type: number, x0: number, y: number, radius: number, extra: Partial<SimulationInput> = {}, x1 = x0): SimulationInput {
  return {
    ...idleInput,
    mousePos: { x: x1, y },
    prevMousePos: { x: x0, y },
    mouseActive: true,
    brushSize: radius,
    particleType: type,
    ...extra,
  };
}

function typeCount(cells: Uint32Array, type: number): number {
  return cells.reduce((n, c) => n + ((c & 0xff) === type ? 1 : 0), 0);
}

// The particles of `particles` whose cell satisfies `keep` on the given cells.
function particlesWhere(particles: ParticleRecords, width: number, cells: Uint32Array, keep: (type: number) => boolean): number[][] {
  return particleRows(particles).filter(([x, y]) => keep(cells[Math.floor(y) * width + Math.floor(x)] & 0xff));
}

async function readArgs(buffer: GPUBuffer): Promise<number[]> {
  return Array.from(await readBuffer(device!, buffer, 12));
}

describe.skipIf(!device)('GPU particle store', () => {
  it('load: the small U-tube gets the particles and totals of spawnParticles', async () => {
    const scene = SCENES.uTube();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.cells);
    const spawned = spawnParticles(scene.cells, scene.width, scene.height);

    const loaded = await readParticles(sim);
    expect(loaded.count).toBe(spawned.count);
    expect(particleRows(loaded)).toEqual(particleRows(spawned));
    expect(await readFluidState(sim)).toEqual({
      count: spawned.count,
      spawnCursor: spawned.count,
      compactCursor: 0,
      water: spawned.water,
      oil: 0,
    });

    // The first frame start recounts everything from the particles themselves.
    await run(sim, 0);
    expect(particleRows(await readParticles(sim))).toEqual(particleRows(spawned));
    expect(await readFluidState(sim)).toEqual({
      count: spawned.count,
      spawnCursor: spawned.count,
      compactCursor: spawned.count,
      water: spawned.water,
      oil: 0,
    });
    expect(await readArgs(sim.fluid.particleArgs)).toEqual([Math.ceil(spawned.count / 256), 1, 1]);
    expect(await readArgs(sim.fluid.gridArgs)).toEqual([Math.ceil((scene.width + 1) / 8), Math.ceil((scene.height + 1) / 8), 1]);
  });

  it('load: oil particles carry their kind and the totals split water from oil', async () => {
    const scene = SCENES.oilOnWater();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.cells);
    const spawned = spawnParticles(scene.cells, scene.width, scene.height);
    expect(spawned.oil).toBeGreaterThan(0);

    await run(sim, 0);

    expect(particleRows(await readParticles(sim))).toEqual(particleRows(spawned));
    const state = await readFluidState(sim);
    expect([state.water, state.oil]).toEqual([spawned.water, spawned.oil]);
  });

  it('seedVelocities: matches the CPU reference particle for particle', async () => {
    const scene = SCENES.uTube();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(5);

    const cpu = new FlipModel();
    cpu.load(scene);
    cpu.seedVelocities(5);
    const expected = cpu.debugState();

    const gpu = await readParticles(sim);
    expect(gpu.count).toBe(expected.px.length);
    const velocities = (get: (i: number) => number): number[] => Array.from({ length: gpu.count }, (_, i) => get(i));
    expect(velocities((i) => gpu.floats[i * PARTICLE_STRIDE + 2])).toEqual(Array.from(expected.vx));
    expect(velocities((i) => gpu.floats[i * PARTICLE_STRIDE + 3])).toEqual(Array.from(expected.vy));
    expect(velocities((i) => gpu.floats[i * PARTICLE_STRIDE])).toEqual(Array.from(expected.px));
    expect(velocities((i) => gpu.floats[i * PARTICLE_STRIDE + 1])).toEqual(Array.from(expected.py));
  });

  it('paint: water with radius 5 adds 4 particles per new cell, at rest on the lattice', async () => {
    const sim = createSim(WIDTH, HEIGHT);

    await run(sim, 0, stroke(T.WATER, 20, 12, 5));

    const cells = await readCells(sim);
    const painted = typeCount(cells, T.WATER);
    expect(painted).toBeGreaterThan(50);
    const particles = await readParticles(sim);
    expect(particles.count).toBe(FLUID.perCell * painted);
    // Every particle is a lattice point of a water cell, at rest, and every water cell holds all four.
    expect(particleRows(particles)).toEqual(particleRows(spawnParticles(cells, WIDTH, HEIGHT)));
    expect(particles.words.filter((_, i) => i % PARTICLE_STRIDE === 4).every((kind) => kind === PARTICLE_KIND.WATER)).toBe(true);
    expect(particleRows(particles).every(([, , vx, vy]) => vx === 0 && vy === 0)).toBe(true);
    const state = await readFluidState(sim);
    expect([state.count, state.water, state.oil]).toEqual([particles.count, particles.count, 0]);
  });

  it('paint: oil particles have the oil kind, and painting over liquid without Shift adds nothing', async () => {
    const sim = createSim(WIDTH, HEIGHT);

    await run(sim, 0, stroke(T.OIL, 20, 12, 3));
    const cells = await readCells(sim);
    const oilCells = typeCount(cells, T.OIL);
    expect((await readParticles(sim)).count).toBe(FLUID.perCell * oilCells);

    await run(sim, 0, stroke(T.OIL, 20, 12, 3));
    await run(sim, 0, stroke(T.WATER, 20, 12, 3));
    const particles = await readParticles(sim);
    expect(particles.count).toBe(FLUID.perCell * oilCells);
    expect(particleRows(particles)).toEqual(particleRows(spawnParticles(cells, WIDTH, HEIGHT)));
    expect((await readFluidState(sim)).oil).toBe(particles.count);
  });

  it('erase: removes the particles of the erased cells only', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const cells = emptyGrid();
    fill(cells, WIDTH, T.WATER, 0, WIDTH, 0, 10);
    loadScene(sim, cells);
    await sim.fluid.seedVelocities(11);
    const before = await readParticles(sim);

    await run(sim, 0, stroke(T.SAND, 20, 5, 3, { erasing: true }));

    const after = await readCells(sim);
    const erased = FLUID.perCell * (typeCount(cells, T.WATER) - typeCount(after, T.WATER));
    expect(erased).toBeGreaterThan(0);
    const survivors = await readParticles(sim);
    expect(survivors.count).toBe(before.count - erased);
    // The rest are untouched, velocities included.
    expect(particleRows(survivors)).toEqual(particlesWhere(before, WIDTH, after, (type) => type === T.WATER));
  });

  it('erase: also removes particles over cells that hold no liquid cell', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const cells = emptyGrid();
    fill(cells, WIDTH, T.WATER, 10, 20, 5, 10);
    loadScene(sim, cells);
    // The cells turn to air under the particles, as after the fluid moves a cell without its particles.
    fill(cells, WIDTH, T.EMPTY, 10, 20, 5, 10);
    device!.queue.writeBuffer(sim.currentBuffer, 0, cells);

    await run(sim, 0, stroke(T.SAND, 15, 7, 20, { erasing: true }));

    expect((await readParticles(sim)).count).toBe(0);
    expect((await readFluidState(sim)).count).toBe(0);
  });

  it('Shift paint: sand over water removes the particles of the overwritten cells, but not those of walls', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const cells = emptyGrid();
    fill(cells, WIDTH, T.WATER, 10, 30, 4, 14);
    loadScene(sim, cells);
    await sim.fluid.seedVelocities(3);
    // Walls over some of the water cells, which keep their particles (they stand for a body the solid grew into).
    fill(cells, WIDTH, T.WALL, 14, 16, 4, 14);
    device!.queue.writeBuffer(sim.currentBuffer, 0, cells);
    const before = await readParticles(sim);

    await run(sim, 0, stroke(T.SAND, 15, 9, 4, { replacing: true }));

    const after = await readCells(sim);
    expect(typeCount(after, T.SAND)).toBeGreaterThan(0);
    expect(typeCount(after, T.WALL)).toBe(typeCount(cells, T.WALL));
    const survivors = await readParticles(sim);
    expect(survivors.count).toBeLessThan(before.count);
    expect(particleRows(survivors)).toEqual(particlesWhere(before, WIDTH, after, (type) => type !== T.SAND));
    // The particles in the walled cells inside the stroke are all still there.
    const walled = particlesWhere(survivors, WIDTH, after, (type) => type === T.WALL);
    expect(walled).toHaveLength(FLUID.perCell * typeCount(after, T.WALL));
  });

  it('Shift paint: water over water replaces its particles with fresh ones at rest', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const cells = emptyGrid();
    fill(cells, WIDTH, T.WATER, 10, 30, 4, 14);
    loadScene(sim, cells);
    await sim.fluid.seedVelocities(3);
    const before = await readParticles(sim);

    await run(sim, 0, stroke(T.WATER, 20, 9, 3, { replacing: true }));

    const after = await readCells(sim);
    expect(typeCount(after, T.WATER)).toBe(typeCount(cells, T.WATER));
    const survivors = await readParticles(sim);
    expect(survivors.count).toBe(before.count);
    // The seeded velocities are never exactly zero, so the particles at rest are the fresh ones, 4 per replaced cell.
    const fresh = particleRows(survivors).filter(([, , vx, vy]) => vx === 0 && vy === 0).length;
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThan(survivors.count);
    expect(fresh % FLUID.perCell).toBe(0);
  });

  it('full store: with a capacity of 40, painting 20 cells of water paints exactly 10', async () => {
    const sim = createSim(32, 8, 1, { particleCapacity: 40 });

    await run(sim, 0, stroke(T.WATER, 5, 4, 0.5, {}, 24));

    const cells = await readCells(sim);
    expect(typeCount(cells, T.WATER)).toBe(10);
    const particles = await readParticles(sim);
    expect(particles.count).toBe(40);
    for (let i = 0; i < particles.count; i++) {
      expect([PARTICLE_KIND.WATER, PARTICLE_KIND.OIL]).toContain(particles.words[i * PARTICLE_STRIDE + 4]);
    }
    expect(particleRows(particles)).toEqual(particleRows(spawnParticles(cells, 32, 8)));

    // Further painting changes nothing, and frames with no input keep the store as it is.
    await run(sim, 0, stroke(T.WATER, 5, 4, 3));
    await run(sim, 3);
    expect(typeCount(await readCells(sim), T.WATER)).toBe(10);
    expect((await readParticles(sim)).count).toBe(40);
  });

  it('full store: erasing frees room for new liquid in the next frame', async () => {
    const sim = createSim(32, 8, 1, { particleCapacity: 40 });
    await run(sim, 0, stroke(T.WATER, 5, 4, 0.5, {}, 24));

    await run(sim, 0, stroke(T.SAND, 5, 4, 0.5, { erasing: true }, 9));
    await run(sim, 0, stroke(T.WATER, 5, 2, 0.5, {}, 24));

    const cells = await readCells(sim);
    expect(typeCount(cells, T.WATER)).toBe(10);
    expect(particleRows(await readParticles(sim))).toEqual(particleRows(spawnParticles(cells, 32, 8)));
  });

  it('compaction: keeps exactly the live set over many frames and swaps the buffers each one', async () => {
    const scene = SCENES.oilOnWater();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.cells);
    await sim.fluid.seedVelocities(7);
    await run(sim, 0, stroke(T.SAND, 30, 12, 6, { erasing: true }));
    const expected = particleRows(await readParticles(sim));
    expect(expected.length).toBeLessThan(spawnParticles(scene.cells, scene.width, scene.height).count);

    const buffers = new Set<GPUBuffer>();
    for (let frame = 0; frame < 7; frame++) {
      await run(sim, 0);
      buffers.add(sim.fluid.particleBuffer);
      expect(particleRows(await readParticles(sim)), `after frame ${frame + 1}`).toEqual(expected);
    }
    expect(buffers.size).toBe(2);
    const state = await readFluidState(sim);
    expect(state.count).toBe(expected.length);
    expect(state.spawnCursor).toBe(expected.length);
    expect(state.water + state.oil).toBe(expected.length);
    expect(state.oil).toBe(expected.filter(([, , , , kind]) => kind === PARTICLE_KIND.OIL).length);
  });

  it('empty world: no particles, no work for the particle and grid passes; clear empties the store', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    await run(sim, 0);
    expect((await readParticles(sim)).count).toBe(0);
    expect(await readArgs(sim.fluid.particleArgs)).toEqual([0, 1, 1]);
    expect(await readArgs(sim.fluid.gridArgs)).toEqual([0, 0, 0]);

    await run(sim, 0, stroke(T.WATER, 20, 12, 3));
    expect((await readParticles(sim)).count).toBeGreaterThan(0);
    expect((await readArgs(sim.fluid.gridArgs))[0]).toBeGreaterThan(0);

    sim.clear();
    expect((await readParticles(sim)).count).toBe(0);
    expect(await readArgs(sim.fluid.gridArgs)).toEqual([0, 0, 0]);
    await run(sim, 0);
    expect((await readParticles(sim)).count).toBe(0);
  });

  it('load: rejects a scene of the wrong size or one the store cannot hold', () => {
    const sim = createSim(8, 8, 1, { particleCapacity: 8 });
    expect(() => sim.load(new Uint32Array(10))).toThrow(RangeError);
    const flood = new Uint32Array(64).fill(cell(T.WATER));
    expect(() => sim.load(flood)).toThrow(RangeError);
  });
});
