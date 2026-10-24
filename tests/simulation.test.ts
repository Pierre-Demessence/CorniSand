import { describe, expect, it, vi } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { Display } from '../src/display';
import { cell, countTypes, createSim, device, idleInput, loadCells, mulberry32, readCells, run, runMany } from './gpu';

function emptyGrid(width: number, height: number): Uint32Array<ArrayBuffer> {
  return new Uint32Array(width * height);
}

describe.skipIf(!device)('GPU simulation', () => {
  it('B2: isolated droplets spread sideways without a net drift in either direction', async () => {
    // Per-droplet displacement after 200 supersteps has a standard deviation of ~19 cells,
    // so the mean needs ~1000 droplets to stay inside +-2 reliably. The old fixed-by-parity
    // rule moved every droplet ~400 cells the same way.
    const droplets = 1000;
    const spacing = 256;
    const width = spacing * droplets + 100;
    const sim = createSim(width, 4, 7);
    const cells = emptyGrid(width, 4);
    const starts: number[] = [];
    for (let i = 0; i < droplets; i++) {
      const x = 40 + spacing * i;
      starts.push(x);
      cells[x] = cell(T.WATER); // row 0: the grid edge is the floor
    }
    loadCells(sim, cells);

    await runMany(sim, 200);

    const finals: number[] = [];
    (await readCells(sim)).forEach((c, i) => {
      if (c !== 0) finals.push(i % width);
    });
    expect(finals).toHaveLength(droplets);
    // Droplets stay far apart, so sorted order pairs each one with its start.
    finals.sort((a, b) => a - b);
    const displacements = finals.map((x, i) => x - starts[i]);
    const mean = displacements.reduce((a, b) => a + b, 0) / displacements.length;

    expect(Math.abs(mean)).toBeLessThanOrEqual(2);
    expect(displacements.some((d) => d < 0)).toBe(true);
    expect(displacements.some((d) => d > 0)).toBe(true);
  });

  it('B5: painting next to falling water loses and duplicates nothing', async () => {
    const width = 16;
    const height = 16;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (const y of [11, 12]) {
      for (const x of [4, 5, 6]) cells[y * width + x] = cell(T.WATER);
    }
    loadCells(sim, cells);

    await run(sim, 1, {
      ...idleInput,
      mousePos: { x: 5, y: 10 },
      prevMousePos: { x: 5, y: 10 },
      mouseActive: true,
      particleType: T.WALL,
    });

    const counts = countTypes(await readCells(sim));
    expect(counts.get(T.WATER)).toBe(6);
    expect(counts.get(T.WALL)).toBe(1);
  });

  it('D5: a random scene on an odd-sized grid conserves every particle type', async () => {
    const width = 101;
    const height = 67;
    const sim = createSim(width, height, 3);
    const rand = mulberry32(99);
    const kinds = [T.EMPTY, T.EMPTY, T.SAND, T.WATER, T.OIL, T.SMOKE, T.WALL];
    const cells = emptyGrid(width, height);
    for (let i = 0; i < cells.length; i++) cells[i] = cell(kinds[rand() % kinds.length]);
    loadCells(sim, cells);
    const before = countTypes(cells);

    await runMany(sim, 100);

    const after = countTypes(await readCells(sim));
    for (const type of [T.SAND, T.WATER, T.OIL, T.SMOKE, T.WALL]) {
      expect(after.get(type), `type ${type}`).toBe(before.get(type));
    }
    expect(after.get(T.FIRE) ?? 0).toBe(0);
  });

  it('D5: a sand grain over empty space falls two cells per superstep', async () => {
    const width = 9;
    const height = 65;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    cells[61 * width + 4] = cell(T.SAND);
    loadCells(sim, cells);

    for (let step = 1; step <= 5; step++) {
      await run(sim, 1);
      const data = await readCells(sim);
      expect(data.indexOf(cell(T.SAND)), `after ${step} supersteps`).toBe((61 - 2 * step) * width + 4);
    }
  });

  it('D5: smoke rises two cells per superstep', async () => {
    const width = 9;
    const height = 65;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    cells[2 * width + 4] = cell(T.SMOKE);
    loadCells(sim, cells);

    for (let step = 1; step <= 5; step++) {
      await run(sim, 1);
      const data = await readCells(sim);
      expect(data.indexOf(cell(T.SMOKE)), `after ${step} supersteps`).toBe((2 + 2 * step) * width + 4);
    }
  });

  it('D4: a frame (brush, 32 supersteps, render) is recorded into one encoder and one submit', async () => {
    const dev = device!;
    const width = 64;
    const height = 48;
    const sim = createSim(width, height);
    const display = new Display(dev, 'rgba8unorm', width, height, sim.bufferA, sim.bufferB);
    const target = dev.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const submit = vi.spyOn(dev.queue, 'submit');

    dev.pushErrorScope('validation');
    const encoder = dev.createCommandEncoder();
    sim.simulate(encoder, 32, {
      ...idleInput,
      mousePos: { x: 30, y: 30 },
      prevMousePos: { x: 20, y: 30 },
      mouseActive: true,
      brushSize: 4,
    });
    display.render(encoder, target.createView(), sim.currentBuffer, width, height, {
      mousePos: { x: 30, y: 30 },
      brushSize: 4,
      showBrush: true,
      erasing: false,
      replacing: false,
    });
    expect(submit).not.toHaveBeenCalled();
    dev.queue.submit([encoder.finish()]);
    const error = await dev.popErrorScope();

    expect(error).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
    target.destroy();
  });
});
