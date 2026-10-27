import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, elementTemperature, type ElementDef } from '../src/elements';
import { ROOM_TEMP, effectiveTemp } from '../src/heat';
import { HEAT_BARS, SCENES } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { cell, cellType, createSim, device, idleInput, mulberry32, readCells, run, runMany } from './gpu';
import { heatContent } from './metrics';

const FIRE_TEMP = 1000;

// The `temp` words of a grid where every cell holds `temp` °C.
function uniformTemps(cellCount: number, temp: number): Uint32Array<ArrayBuffer> {
  const data = { temp: new Uint32Array(cellCount) };
  tempView(data).fill(temp);
  return data.temp;
}

// The `temp` word of a temperature: what a cell carries bit for bit.
function tempWord(temp: number): number {
  return uniformTemps(1, temp)[0];
}

async function readTemps(sim: Simulation): Promise<Float32Array> {
  return tempView({ temp: await sim.fields.read('temp') });
}

describe.skipIf(!device)('M5 heat', () => {
  it('AC3: a painted cell starts at its element temperature, also where it replaces a cell', async () => {
    const width = 16;
    const height = 16;
    const sim = createSim(width, height);
    sim.load({ kind: new Uint32Array(width * height).fill(cell(T.WATER)), temp: uniformTemps(width * height, 55) });

    // The brush alone: the CA would turn fire beside water into smoke.
    await run(sim, 0, {
      ...idleInput,
      mousePos: { x: 8, y: 8 },
      prevMousePos: { x: 8, y: 8 },
      mouseActive: true,
      replacing: true,
      brushSize: 2,
      particleType: T.FIRE,
    });

    const kinds = await readCells(sim);
    const temps = await readTemps(sim);
    let painted = 0;
    for (let i = 0; i < kinds.length; i++) {
      if (cellType(kinds[i]) === T.FIRE) {
        painted++;
        expect(temps[i], `painted cell ${i}`).toBe(FIRE_TEMP);
      } else {
        expect(temps[i], `water cell ${i}`).toBe(55);
      }
    }
    expect(painted, 'cells painted').toBeGreaterThan(4);
  });

  it('AC3: a scene loaded without temperatures starts every cell at its element temperature', async () => {
    const width = 16;
    const height = 8;
    const sim = createSim(width, height);
    const kinds = [T.EMPTY, T.SAND, T.WATER, T.OIL, T.SMOKE, T.FIRE, T.WALL];
    const kind = new Uint32Array(width * height).map((_, i) => cell(kinds[i % kinds.length]));
    sim.load({ kind });

    const temps = await readTemps(sim);
    const expected = new Map(ELEMENTS.map((e) => [e.id as number, elementTemperature(e)]));
    for (let i = 0; i < kind.length; i++) expect(temps[i], `cell ${i}`).toBe(expected.get(cellType(kind[i])));
    expect(temps).toContain(FIRE_TEMP);
  });

  it('AC3: ?scene=damBreak loads its water at room temperature', async () => {
    const scene = SCENES.damBreak();
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);

    const kinds = await readCells(sim);
    const temps = await readTemps(sim);
    let water = 0;
    for (let i = 0; i < kinds.length; i++) {
      if (cellType(kinds[i]) !== T.WATER) continue;
      water++;
      expect(temps[i], `water cell ${i}`).toBe(ROOM_TEMP);
    }
    expect(water).toBe(30 * 40);
  });

  it('AC4: falling grains carry their temperatures bit for bit, -0 included, and the empty cells keep theirs', async () => {
    const width = 40;
    const height = 60;
    // Grains that conduct would even out their marks where they touch; this powder holds no heat, so it only carries them.
    const DUST = 200;
    const dust: ElementDef = { key: 'DUST', id: DUST, label: 'Dust', color: [0.5, 0.5, 0.5], state: 'powder', density: 1600 };
    const sim = createSim(width, height, 5, { elements: [...ELEMENTS, dust] });
    const kind = new Uint32Array(width * height);
    // Empty cells at 0, as after Clear or the eraser: a grain at -0 moving into one must keep its sign bit.
    const temp = uniformTemps(width * height, 0);
    const temps = tempView({ temp });
    const marked: number[] = [];
    for (const y of [50, 51]) {
      for (let x = 1; x < width; x += 2) {
        const i = y * width + x;
        kind[i] = cell(DUST);
        temps[i] = marked.length === 0 ? -0 : marked.length * 37.77 - 300;
        marked.push(temp[i]);
      }
    }
    sim.load({ kind, temp });

    await runMany(sim, 12);

    const kindAfter = await readCells(sim);
    const tempAfter = await sim.fields.read('temp');
    const carried: number[] = [];
    for (let i = 0; i < kindAfter.length; i++) {
      if (cellType(kindAfter[i]) === DUST) carried.push(tempAfter[i]);
      else expect(tempAfter[i], `temp word of the empty cell ${i}`).toBe(0);
    }
    expect(kindAfter, 'the grains moved').not.toEqual(kind);
    const sorted = (words: number[]): number[] => [...words].sort((a, b) => a - b);
    expect(sorted(carried)).toEqual(sorted(marked));
  });

  it('AC4: a flyer carries its temperature through the air and lands with it', async () => {
    const width = 9;
    const height = 200;
    const sim = createSim(width, height);
    const kind = new Uint32Array(width * height);
    const temp = uniformTemps(width * height, 0);
    const marked = tempWord(1234.5678);
    kind[190 * width + 4] = cell(T.SAND);
    temp[190 * width + 4] = marked;
    sim.load({ kind, temp });

    await runMany(sim, 30);
    const flyers = await sim.flyers.read();
    expect(flyers, 'the grain is in the air').toHaveLength(1);
    expect(flyers[0].cell.temp, 'the temp word it carries').toBe(marked);

    await runMany(sim, 120);
    expect((await sim.flyers.readStats()).landed, 'it landed').toBe(1);
    expect(cellType((await readCells(sim))[4]), 'the grain rests on the floor').toBe(T.SAND);
    expect((await sim.fields.read('temp'))[4], 'its temp word came along').toBe(marked);
  });
});

// Variance along x of the heat above `base`, averaged over the rows of each column.
function excessVariance(temps: Float32Array, width: number, height: number, base: number): number {
  let weight = 0;
  let first = 0;
  let second = 0;
  for (let x = 0; x < width; x++) {
    let column = 0;
    for (let y = 0; y < height; y++) column += (temps[y * width + x] - base) / height;
    weight += column;
    first += column * x;
    second += column * x * x;
  }
  return second / weight - (first / weight) ** 2;
}

// The mean temperature of columns [x0, x1) and rows [y0, y1).
function meanTemp(temps: Float32Array, width: number, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += temps[y * width + x];
  return sum / ((x1 - x0) * (y1 - y0));
}

describe.skipIf(!device)('M5.3 conduction', () => {
  it.each(['METAL', 'STONE'])('AC5: the heat of a hot line in a %s slab spreads at the rate its conductivity gives', async (key) => {
    const element = elementByKey(ELEMENTS, key);
    const kappa = elementConductivity(element);
    const width = 256;
    const height = 8;
    const kind = new Uint32Array(width * height).fill(cell(element.id));
    const temp = uniformTemps(width * height, 20);
    const temps = tempView({ temp });
    for (let y = 0; y < height; y++) for (let x = 126; x < 130; x++) temps[y * width + x] = 500;
    const sim = createSim(width, height);
    sim.load({ kind, temp });

    await runMany(sim, 100);
    const before = excessVariance(await readTemps(sim), width, height, 20);
    await runMany(sim, 300);
    const after = excessVariance(await readTemps(sim), width, height, 20);

    // 300 supersteps are 600 dispatches; each adds kappa / (2 - kappa) cells² along x.
    const ratio = (after - before) / ((600 * kappa) / (2 - kappa));
    expect(ratio, `variance growth over the formula's, ${key}`).toBeGreaterThan(0.95);
    expect(ratio, `variance growth over the formula's, ${key}`).toBeLessThan(1.05);
  }, 60_000);

  it('AC6: heat crosses a metal bar at least 5 times faster than a stone bar of the same size', async () => {
    const scene = SCENES.heatBars();
    const { width, x1, cold, metalY0, stoneY0, barHeight } = HEAT_BARS;
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);

    const reached: Record<string, number | undefined> = {};
    const step = 10;
    const cap = 6000;
    for (let supersteps = step; supersteps <= cap && (reached.metal === undefined || reached.stone === undefined); supersteps += step) {
      await runMany(sim, step);
      const temps = await readTemps(sim);
      for (const [name, y0] of [['metal', metalY0], ['stone', stoneY0]] as const) {
        if (reached[name] === undefined && meanTemp(temps, width, x1 - 4, x1, y0, y0 + barHeight) > cold + 10) reached[name] = supersteps;
      }
    }

    expect(reached.metal, 'superstep the far end of the metal bar passed 30 °C').toBeDefined();
    expect(reached.stone, 'superstep the far end of the stone bar passed 30 °C (cap 6,000)').toBeDefined();
    expect(reached.stone! / reached.metal!, `metal at ${reached.metal}, stone at ${reached.stone}`).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('AC7: hot cells touching only empty space and walls keep their temperatures, and so do the words of those empty and wall cells', async () => {
    const width = 24;
    const height = 16;
    const sim = createSim(width, height);
    const kind = new Uint32Array(width * height);
    for (let i = 0; i < 2 * width; i++) kind[i] = cell(T.WALL);
    for (let y = 2; y < 9; y++) for (let x = 8; x < 16; x++) kind[y * width + x] = cell(T.METAL);
    // Distinct words everywhere, so a write of any kind shows: those of empty and wall cells mean nothing.
    const temp = new Uint32Array(width * height);
    const temps = tempView({ temp });
    const next = mulberry32(7);
    for (let i = 0; i < temp.length; i++) temps[i] = (next() / 2 ** 32) * 1000 - 100;
    for (let y = 2; y < 9; y++) for (let x = 8; x < 16; x++) temps[y * width + x] = 500;
    sim.load({ kind, temp });

    await runMany(sim, 500);

    expect(await readCells(sim), 'the cells').toEqual(kind);
    expect(await sim.fields.read('temp'), 'the temp words').toEqual(temp);
  });

  it('AC7: two touching blocks settle at their capacity-weighted mean temperature', async () => {
    const width = 20;
    const height = 12;
    const sim = createSim(width, height);
    const kind = new Uint32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y < 2 || y >= height - 2 || x < 2 || x >= width - 2) kind[y * width + x] = cell(T.WALL);
        else kind[y * width + x] = cell(x < 10 ? T.METAL : T.STONE);
      }
    }
    const temp = uniformTemps(width * height, 20);
    const temps = tempView({ temp });
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < 10; x++) temps[y * width + x] = 500;
    sim.load({ kind, temp });
    const capacityMetal = elementHeatCapacity(elementByKey(ELEMENTS, 'METAL'));
    const capacityStone = elementHeatCapacity(elementByKey(ELEMENTS, 'STONE'));
    const mean = (capacityMetal * 500 + capacityStone * 20) / (capacityMetal + capacityStone);

    await runMany(sim, 2500);

    const after = await readTemps(sim);
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        expect(Math.abs(after[y * width + x] - mean), `cell (${x}, ${y}) at ${after[y * width + x]} °C, mean ${mean}`).toBeLessThan(0.5);
      }
    }
  }, 60_000);

  it('AC7: a metal and a stone cell meet at the harmonic mean of their conductivities', async () => {
    // Two cells in a row: at offset 0 they are one pair, at offset 1 each is alone with the world's edge, so one
    // superstep is exactly one exchange.
    const sim = createSim(2, 1);
    const kind = new Uint32Array([cell(T.METAL), cell(T.STONE)]);
    const temp = uniformTemps(2, 20);
    tempView({ temp })[0] = 500;
    sim.load({ kind, temp });
    const metal = elementByKey(ELEMENTS, 'METAL');
    const stone = elementByKey(ELEMENTS, 'STONE');
    const [km, ks] = [elementConductivity(metal), elementConductivity(stone)];
    const [cm, cs] = [elementHeatCapacity(metal), elementHeatCapacity(stone)];
    const flow = ((2 * km * ks) / (km + ks)) * 480 / (cm + cs);

    await runMany(sim, 1);

    const after = await readTemps(sim);
    expect(after[0], 'metal').toBeCloseTo(500 - flow * cs, 3);
    expect(after[1], 'stone').toBeCloseTo(20 + flow * cm, 3);
  });

  it('AC8: a sealed box of moving and fixed materials keeps its total heat over 2,000 supersteps', async () => {
    const width = 48;
    const height = 40;
    const sim = createSim(width, height, 8);
    const next = mulberry32(8);
    const rand = (): number => next() / 2 ** 32;
    const kinds = [T.METAL, T.STONE, T.SAND, T.WATER, T.OIL, T.EMPTY];
    // Each element inside its own range, so no phase change can be due once M5.4 adds them.
    const range: Record<number, [number, number]> = {
      [T.METAL]: [0, 600], [T.STONE]: [0, 600], [T.SAND]: [0, 600], [T.WATER]: [1, 99], [T.OIL]: [0, 249],
    };
    const kind = new Uint32Array(width * height);
    const temp = uniformTemps(width * height, 0);
    const temps = tempView({ temp });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (y < 2 || x < 2 || x >= width - 2) {
          kind[i] = cell(T.WALL);
          continue;
        }
        const type = kinds[Math.floor(rand() * kinds.length)];
        kind[i] = cell(type);
        if (type !== T.EMPTY) temps[i] = range[type][0] + rand() * (range[type][1] - range[type][0]);
      }
    }
    sim.load({ kind, temp });
    const measure = async (): Promise<{ heat: number; spread: number }> => {
      const grid = { kind: await readCells(sim), temp: await sim.fields.read('temp') };
      const view = tempView(grid);
      const solids: number[] = [];
      grid.kind.forEach((k, i) => {
        if (cellType(k) === T.METAL || cellType(k) === T.STONE) solids.push(view[i]);
      });
      return { heat: heatContent(ELEMENTS, grid, await sim.flyers.read()), spread: Math.max(...solids) - Math.min(...solids) };
    };
    const before = await measure();

    await runMany(sim, 2000);
    const after = await measure();

    expect(Math.abs(after.heat - before.heat) / before.heat, `heat ${before.heat} before, ${after.heat} after`).toBeLessThan(1e-4);
    // The heat did flow: the metal and stone ended much closer to each other than they started.
    expect(after.spread, 'spread of the metal and stone temperatures').toBeLessThan(before.spread / 2);
  }, 120_000);
});

describe.skipIf(!device)('M5.4 temperature', () => {
  it('a cell conducts at its stored temperature clamped to its thresholds', async () => {
    // SLUSH stores 40 °C but has taken in only part of the latent heat it needs to melt at 0 °C: it is at 0 °C and must
    // draw heat from the 20 °C metal beside it. Unclamped, it would give heat to the metal instead.
    const slush: ElementDef = {
      key: 'SLUSH', id: 201, label: 'Slush', color: [0.8, 0.9, 1], state: 'solid', density: 917, temperature: -20, conductivity: 0.2, heatCapacity: 2,
      above: { temp: 0, becomes: 'METAL', latent: 300 },
    };
    const table = [...ELEMENTS, slush];
    // Two cells in a row: one superstep is exactly one exchange (see the metal and stone test above).
    const sim = createSim(2, 1, 1, { elements: table });
    const temp = uniformTemps(2, 20);
    tempView({ temp })[0] = 40;
    sim.load({ kind: new Uint32Array([cell(201), cell(T.METAL)]), temp });
    const metal = elementByKey(ELEMENTS, 'METAL');
    const [ks, km] = [elementConductivity(slush), elementConductivity(metal)];
    const [cs, cm] = [elementHeatCapacity(slush), elementHeatCapacity(metal)];
    const flow = ((2 * ks * km) / (ks + km)) * (effectiveTemp(slush, 40) - 20) / (cs + cm);

    await runMany(sim, 1);

    const after = await readTemps(sim);
    expect(flow, 'the slush is colder than the metal').toBeLessThan(0);
    expect(after[0], 'slush').toBeCloseTo(40 - flow * cm, 3);
    expect(after[1], 'metal').toBeCloseTo(20 + flow * cs, 3);
    expect((await readCells(sim)).map(cellType), 'no phase change yet').toEqual(new Uint32Array([201, T.METAL]));
  });
});
