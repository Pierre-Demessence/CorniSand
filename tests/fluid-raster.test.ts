import { describe, expect, it } from 'vitest';
import { oilKey, oilShare, rasterKey } from '../src/fluid-params';
import { PARTICLE_TYPES as T } from '../src/particles';
import { rasterKeys } from './cpu/flip';
import { cell, createSim, device, loadScene, mulberry32, readBuffer, readSelectState, writeSelectState } from './gpu';

const TYPES = [T.EMPTY, T.EMPTY, T.EMPTY, T.WATER, T.OIL, T.SAND, T.WALL, T.SMOKE, T.FIRE];

// Records one hook into its own compute pass and fails on any WebGPU validation error.
async function record(record: (pass: GPUComputePassEncoder) => void): Promise<void> {
  const dev = device!;
  dev.pushErrorScope('validation');
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginComputePass();
  record(pass);
  pass.end();
  dev.queue.submit([encoder.finish()]);
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
}

interface RandomGrid {
  cells: Uint32Array;
  counts: Uint32Array;
  oilCounts: Uint32Array;
}

// Cells of every type, and particle counts in a share of them (also in cells that cannot hold liquid, and above the
// clamp), so the candidates, the padding rings and the side rules are all exercised.
function randomGrid(width: number, height: number, seed: number, particleShare: number): RandomGrid {
  const rand = mulberry32(seed);
  const n = width * height;
  const cells = new Uint32Array(n);
  const counts = new Uint32Array(n);
  const oilCounts = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    cells[i] = cell(TYPES[rand() % TYPES.length]);
    if (rand() / 2 ** 32 < particleShare) {
      counts[i] = 1 + (rand() % 20);
      oilCounts[i] = rand() % (counts[i] + 1);
    }
  }
  return { cells, counts, oilCounts };
}

describe.skipIf(!device)('rasterization keys on the GPU', () => {
  it.each([
    [37, 29, 1, 0.3],
    [37, 29, 2, 0.05],
    [64, 40, 3, 0.01],
    [11, 53, 4, 0.5],
  ])('%ix%i grid, seed %i, %f of the cells hold particles: keys and oil keys match the CPU formulas', async (width, height, seed, share) => {
    const { cells, counts, oilCounts } = randomGrid(width, height, seed, share);
    const sim = createSim(width, height);
    loadScene(sim, cells);
    const dev = device!;
    dev.queue.writeBuffer(sim.fluid.raster.counts, 0, counts);
    dev.queue.writeBuffer(sim.fluid.raster.oilCounts, 0, oilCounts);

    await record((pass) => sim.fluid.recordKeys(pass));
    const keys = await readBuffer(dev, sim.fluid.raster.keys, width * height * 4);
    const expected = rasterKeys(cells, counts, width, height);
    const wrong = Array.from(keys).findIndex((key, i) => key !== expected[i]);
    expect(wrong, wrong < 0 ? '' : `cell ${wrong}: gpu ${keys[wrong]} cpu ${expected[wrong]}`).toBe(-1);
    expect(Array.from(keys).filter((key) => key > 0).length, 'there are candidates').toBeGreaterThan(0);

    // The oil key of the chosen cells: all candidates, then only the better half.
    const candidates = Array.from(expected).filter((key) => key > 0).sort((a, b) => a - b);
    for (const threshold of [1, candidates[Math.floor(candidates.length / 2)]]) {
      await writeSelectState(sim, { none: 0, threshold });
      await record((pass) => sim.fluid.recordOilKeys(pass));
      const oilKeys = await readBuffer(dev, sim.fluid.raster.oilKeys, width * height * 4);
      const expectedOil = expected.map((key, c) => (key > 0 && key >= threshold ? oilKey(oilShare(oilCounts[c], counts[c]), c) : 0));
      const bad = Array.from(oilKeys).findIndex((key, i) => key !== expectedOil[i]);
      expect(bad, bad < 0 ? '' : `cell ${bad} (threshold ${threshold}): gpu ${oilKeys[bad]} cpu ${expectedOil[bad]}`).toBe(-1);
    }
  });

  it('a particle cell on the grid edge counts its own particles for the missing side', async () => {
    const sim = createSim(5, 3);
    const cells = new Uint32Array(15);
    cells[0] = cell(T.WATER);
    loadScene(sim, cells);
    const counts = new Uint32Array(15);
    counts[0] = 4;
    device!.queue.writeBuffer(sim.fluid.raster.counts, 0, counts);

    await record((pass) => sim.fluid.recordKeys(pass));
    const keys = await readBuffer(device!, sim.fluid.raster.keys, 15 * 4);
    // Own count 4, the missing left side reads as 4, the empty right neighbor as 0: 10 * 4 + 5 * (4 + 0) + 3 (water now).
    expect(keys[0]).toBe(rasterKey(40 + 20 + 3, 0));
  });
});

describe.skipIf(!device)('radix select on the GPU', () => {
  const width = 97;
  const height = 61;

  // Unique keys like the real ones (quality in the high byte, inverted index below), a third of them 0.
  function randomKeys(seed: number, qualities: number[]): Uint32Array {
    const rand = mulberry32(seed);
    const keys = new Uint32Array(width * height);
    for (let i = 0; i < keys.length; i++) {
      if (rand() % 3 === 0) continue;
      keys[i] = rasterKey(qualities[rand() % qualities.length], i);
    }
    return keys;
  }

  const wide = Array.from({ length: 243 }, (_, i) => i + 1);

  it.each([
    ['wide quality range', 11, wide],
    ['three qualities, so the first bytes tie', 12, [10, 20, 30]],
    ['one quality, so only the index decides', 13, [77]],
  ])('%s: the chosen set is the top `wanted` keys', async (_name, seed, qualities) => {
    const keys = randomKeys(seed, qualities);
    const candidates = keys.filter((key) => key > 0).length;
    const sorted = Array.from(keys).filter((key) => key > 0).sort((a, b) => b - a);
    const sim = createSim(width, height);
    const dev = device!;
    dev.queue.writeBuffer(sim.fluid.raster.keys, 0, keys);

    // One state buffer serves every case in turn: the last round of a selection leaves it ready for the next.
    for (const wanted of [0, 1, Math.floor(candidates / 2), candidates - 1, candidates, candidates + 5]) {
      await writeSelectState(sim, { wanted });
      await record((pass) => sim.fluid.recordSelect(pass));
      const state = await readSelectState(sim);

      const take = Math.min(wanted, candidates);
      const chosen = Array.from(keys).filter((key) => key > 0 && state.none === 0 && key >= state.threshold);
      expect(chosen.sort((a, b) => b - a), `wanted ${wanted} of ${candidates}`).toEqual(sorted.slice(0, take));
      expect(state.shortfall, `shortfall for wanted ${wanted}`).toBe(wanted - take);
      expect(state.chosen).toBe(take);
      expect(state.none).toBe(wanted === 0 ? 1 : 0);
      expect(state.round, 'the selection leaves the round at 0').toBe(0);
      const bins = await readBuffer(dev, sim.fluid.raster.histogram, 256 * 4);
      expect(bins.every((n) => n === 0), 'the histogram is empty again').toBe(true);
    }
    expect((await readSelectState(sim)).maxShortfall).toBe(5);
  });
});
