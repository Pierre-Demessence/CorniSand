import { describe, expect, it, vi } from 'vitest';
import { ELEMENT as T, ELEMENTS, elementByKey } from '../src/elements';
import { Display } from '../src/display';
import { SCENES } from '../src/scenes';
import { cell, cellType, countTypes, createSim, device, idleInput, loadScene, mulberry32, readCells, run, runMany } from './gpu';
import { columnsWithAbove, flatness } from './metrics';

const FIRE_MAX_LIFE = elementByKey(ELEMENTS, 'FIRE').life!.start;

function emptyGrid(width: number, height: number): Uint32Array<ArrayBuffer> {
  return new Uint32Array(width * height);
}

describe.skipIf(!device)('GPU simulation', () => {
  it('oil beside fire and water ignites, burns for a step and goes out the step after', async () => {
    // A sealed 2x2 chamber (walls all around) so nothing moves: oil bottom-left, water bottom-right, fire above the
    // oil. Water only puts out cells that were fire before the ignition rule ran, so the fire above goes out while
    // the ignited oil burns on.
    const width = 8;
    const height = 8;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (const [x, y] of [[1, 0], [1, 1], [4, 0], [4, 1], [2, 2], [3, 2]]) cells[y * width + x] = cell(T.WALL);
    cells[2] = cell(T.OIL);
    cells[3] = cell(T.WATER);
    cells[width + 2] = cell(T.FIRE);
    const life = emptyGrid(width, height);
    life[width + 2] = FIRE_MAX_LIFE;
    loadScene(sim, cells, life);

    await run(sim, 1);
    expect(cellType((await readCells(sim))[2]), 'the oil cell after one superstep').toBe(T.FIRE);

    await run(sim, 1);
    const after = await readCells(sim);
    expect(cellType(after[2]), 'the burning oil cell after two supersteps').toBe(T.SMOKE);
    expect(cellType(after[3])).toBe(T.WATER);
    expect(countTypes(after).get(T.FIRE) ?? 0).toBe(0);
  });

  it('fire burns oil: the oil count never rises, at least half is gone after 600 supersteps and smoke appears', async () => {
    // A 20x5 oil block resting in a walled tank, a row of fire on top of it.
    const width = 30;
    const height = 24;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < 2 || x < 2 || x >= width - 2) cells[y * width + x] = cell(T.WALL);
      }
    }
    for (let y = 2; y < 7; y++) {
      for (let x = 5; x < 25; x++) cells[y * width + x] = cell(T.OIL);
    }
    const life = emptyGrid(width, height);
    for (let x = 5; x < 25; x++) {
      cells[7 * width + x] = cell(T.FIRE);
      life[7 * width + x] = FIRE_MAX_LIFE;
    }
    loadScene(sim, cells, life);

    const oilCells: number[] = [];
    let smoke = 0;
    for (let step = 0; step <= 600; step += 50) {
      if (step > 0) await runMany(sim, 50);
      const counts = countTypes(await readCells(sim));
      oilCells.push(counts.get(T.OIL) ?? 0);
      smoke = Math.max(smoke, counts.get(T.SMOKE) ?? 0);
    }

    expect(oilCells[0]).toBe(100);
    for (let i = 1; i < oilCells.length; i++) {
      expect(oilCells[i], `oil cells after ${i * 50} supersteps`).toBeLessThanOrEqual(oilCells[i - 1]);
    }
    expect(oilCells.at(-1), `oil cells over time: ${oilCells.join(', ')}`).toBeLessThanOrEqual(50);
    expect(smoke).toBeGreaterThan(0);
  }, 120_000);

  it('water puts out fire: a fire cell beside water is smoke two supersteps later, and burns on without it', async () => {
    const width = 8;
    const height = 8;
    const withWater = createSim(width, height);
    const dry = createSim(width, height);
    const cells = emptyGrid(width, height);
    cells[2] = cell(T.FIRE);
    const life = emptyGrid(width, height);
    life[2] = FIRE_MAX_LIFE;
    loadScene(dry, cells, life);
    cells[3] = cell(T.WATER);
    loadScene(withWater, cells, life);

    await run(withWater, 2);
    await run(dry, 2);

    const wet = countTypes(await readCells(withWater));
    expect(wet.get(T.FIRE) ?? 0, 'fire cells next to water').toBe(0);
    expect(wet.get(T.SMOKE), 'smoke cells next to water').toBe(1);
    expect(wet.get(T.WATER), 'water cells').toBe(1);
    const control = countTypes(await readCells(dry));
    expect(control.get(T.FIRE), 'fire cells without water').toBe(1);
    expect(control.get(T.SMOKE) ?? 0).toBe(0);
  });

  it.each([['water', T.WATER], ['oil', T.OIL]])('AC7: smoke rises through %s: it is above the surface within 40 supersteps and the liquid count is unchanged', async (_name, liquid) => {
    const width = 12;
    const height = 30;
    const depth = 10;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (let y = 0; y < depth; y++) {
      for (let x = 0; x < width; x++) cells[y * width + x] = cell(liquid);
    }
    cells[6] = cell(T.SMOKE);
    loadScene(sim, cells);
    const count = width * depth - 1;

    await runMany(sim, 40);

    const after = await readCells(sim);
    expect(countTypes(after).get(liquid), 'liquid cells').toBe(count);
    const smokeAt = after.findIndex((c) => cellType(c) === T.SMOKE);
    expect(countTypes(after).get(T.SMOKE), 'smoke cells').toBe(1);
    let surfaceRow = 0;
    for (let i = 0; i < after.length; i++) {
      if (cellType(after[i]) === liquid) surfaceRow = Math.max(surfaceRow, Math.floor(i / width));
    }
    expect(Math.floor(smokeAt / width), 'smoke row above the top liquid row').toBeGreaterThan(surfaceRow);
  });

  it('AC5: a dam break keeps its water and levels out to within 1 cell in 2,000 supersteps', async () => {
    const scene = SCENES.damBreak();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.fields.kind);
    const water = countTypes(scene.fields.kind).get(T.WATER);

    await runMany(sim, 2000);

    const after = await readCells(sim);
    expect(countTypes(after).get(T.WATER), 'water cells').toBe(water);
    expect(flatness(after, scene.width, scene.height, scene.chambers[0], scene.floorY), 'flatness').toBeLessThanOrEqual(1);
  }, 120_000);

  it('AC6: oil poured over water ends up on top of it with both counts unchanged after 1,000 supersteps', async () => {
    const scene = SCENES.oilOnWater();
    const sim = createSim(scene.width, scene.height);
    loadScene(sim, scene.fields.kind);
    const before = countTypes(scene.fields.kind);

    await runMany(sim, 1000);

    const after = await readCells(sim);
    expect(columnsWithAbove(after, scene.width, scene.height, T.WATER, T.OIL), 'columns with oil below water').toBe(0);
    expect(countTypes(after).get(T.WATER), 'water cells').toBe(before.get(T.WATER));
    expect(countTypes(after).get(T.OIL), 'oil cells').toBe(before.get(T.OIL));
  }, 120_000);

  it('AC6: water released under oil rises above it', async () => {
    // Oil lying on the floor of a tank with water on top of it: the water has to swap down through it.
    const width = 30;
    const height = 30;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < 2 || x < 2 || x >= width - 2) cells[y * width + x] = cell(T.WALL);
      }
    }
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < width - 2; x++) cells[y * width + x] = cell(T.OIL);
    }
    for (let y = 6; y < 10; y++) {
      for (let x = 2; x < width - 2; x++) cells[y * width + x] = cell(T.WATER);
    }
    loadScene(sim, cells);

    await runMany(sim, 400);

    const after = await readCells(sim);
    expect(columnsWithAbove(after, width, height, T.WATER, T.OIL), 'columns with oil below water').toBe(0);
    expect(countTypes(after).get(T.OIL), 'oil cells').toBe(4 * 26);
    expect(countTypes(after).get(T.WATER), 'water cells').toBe(4 * 26);
  });

  it.each([['water', T.WATER], ['oil', T.OIL]])('AC7: sand dropped into %s sinks to the floor and nothing is lost', async (_name, liquid) => {
    const scene = SCENES.sandIntoPool();
    const sim = createSim(scene.width, scene.height);
    const cells = scene.fields.kind.map((c) => (cellType(c) === T.WATER ? cell(liquid) : c));
    loadScene(sim, cells);
    const before = countTypes(cells);

    await runMany(sim, 600);

    const after = await readCells(sim);
    expect(columnsWithAbove(after, scene.width, scene.height, T.SAND, liquid), 'columns with liquid below sand').toBe(0);
    expect(countTypes(after).get(T.SAND), 'sand cells').toBe(before.get(T.SAND));
    expect(countTypes(after).get(liquid), 'liquid cells').toBe(before.get(liquid));
  }, 120_000);

  it('B5: painting next to falling water loses and duplicates nothing', async () => {
    const width = 16;
    const height = 16;
    const sim = createSim(width, height);
    const cells = emptyGrid(width, height);
    for (const y of [11, 12]) {
      for (const x of [4, 5, 6]) cells[y * width + x] = cell(T.WATER);
    }
    loadScene(sim, cells);

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
    loadScene(sim, cells);
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
    loadScene(sim, cells);

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
    loadScene(sim, cells);

    for (let step = 1; step <= 5; step++) {
      await run(sim, 1);
      const data = await readCells(sim);
      expect(data.indexOf(cell(T.SMOKE)), `after ${step} supersteps`).toBe((2 + 2 * step) * width + 4);
    }
  });

  it('AC9: cells carry every field with them: falling sand grains keep their life word', async () => {
    const width = 40;
    const height = 60;
    const sim = createSim(width, height, 5);
    const kind = emptyGrid(width, height);
    const life = emptyGrid(width, height);
    // Every other cell of two rows, each grain with its own life word.
    let grains = 0;
    for (const y of [50, 51]) {
      for (let x = 1; x < width; x += 2) {
        kind[y * width + x] = cell(T.SAND);
        life[y * width + x] = 1000 + ++grains;
      }
    }
    loadScene(sim, kind, life);

    await runMany(sim, 12);

    const kindAfter = await readCells(sim);
    const lifeAfter = await sim.fields.read('life');
    const lives: number[] = [];
    for (let i = 0; i < kindAfter.length; i++) {
      if (cellType(kindAfter[i]) === T.SAND) lives.push(lifeAfter[i]);
      else expect(lifeAfter[i], `life of the empty cell ${i}`).toBe(0);
    }
    expect(kindAfter, 'the grains moved').not.toEqual(kind);
    expect([...lives].sort((a, b) => a - b)).toEqual(Array.from({ length: grains }, (_, i) => 1001 + i));
  });

  it('AC10: two runs from the same seed are bit-identical in every field', async () => {
    const width = 101;
    const height = 67;
    const rand = mulberry32(21);
    const kind = emptyGrid(width, height);
    const life = emptyGrid(width, height);
    const kinds = [T.EMPTY, T.EMPTY, T.SAND, T.WATER, T.OIL, T.SMOKE, T.FIRE, T.WALL];
    for (let i = 0; i < kind.length; i++) {
      kind[i] = cell(kinds[rand() % kinds.length], rand() & 0xff);
      if (cellType(kind[i]) === T.FIRE) life[i] = FIRE_MAX_LIFE;
    }

    const fieldsAfter = async (): Promise<[Uint32Array, Uint32Array]> => {
      const sim = createSim(width, height, 8);
      loadScene(sim, kind, life);
      await runMany(sim, 100);
      return [await sim.fields.read('kind'), await sim.fields.read('life')];
    };
    const [kindA, lifeA] = await fieldsAfter();
    const [kindB, lifeB] = await fieldsAfter();

    expect(kindA).not.toEqual(kind);
    expect(kindB).toEqual(kindA);
    expect(lifeB).toEqual(lifeA);
  });

  it('D4: a frame (brush, 32 supersteps, render) is recorded into one encoder and one submit', async () => {
    const dev = device!;
    const width = 64;
    const height = 48;
    const sim = createSim(width, height);
    const display = new Display(dev, 'rgba8unorm', width, height, sim.fields, sim.elements);
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
    display.render(encoder, target.createView(), width, height, {
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
