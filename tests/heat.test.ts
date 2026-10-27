import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, elementTemperature, type ElementDef } from '../src/elements';
import { packHalf2 } from '../src/half';
import { ROOM_TEMP, effectiveTemp } from '../src/heat';
import { HEAT_BARS, ICE_LAVA, MOLTEN_METAL, STEAM_CEILING, SCENES } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { cell, cellType, countTypes, createSim, device, idleInput, mulberry32, readCells, run, runMany } from './gpu';
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
    // Conduction only averages, so with every start inside 1 to 99 °C no cell can ever reach a threshold (water's 0 and
    // 100, oil's 250), and no phase change is due.
    const range: Record<number, [number, number]> = {
      [T.METAL]: [1, 99], [T.STONE]: [1, 99], [T.SAND]: [1, 99], [T.WATER]: [1, 99], [T.OIL]: [1, 99],
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

// A grid of `kinds` cells in a row (the cell 0 at the bottom left) at the given stored temperatures, run for one
// superstep (two dispatches); the rest of the row is walls, which neither conduct nor move.
async function oneSuperstep(
  cells: { type: number; temp: number; life?: number }[],
  supersteps = 1,
): Promise<{ kinds: number[]; temps: Float32Array; lives: Uint32Array }> {
  const width = cells.length;
  const sim = createSim(width, 1);
  const kind = new Uint32Array(cells.map((c) => cell(c.type)));
  const temp = uniformTemps(width, 0);
  const life = new Uint32Array(cells.map((c) => c.life ?? 0));
  cells.forEach((c, i) => { tempView({ temp })[i] = c.temp; });
  sim.load({ kind, temp, life });
  await runMany(sim, supersteps);
  return { kinds: [...(await readCells(sim))].map(cellType), temps: await readTemps(sim), lives: await sim.fields.read('life') };
}

describe.skipIf(!device)('M5.4b phase changes', () => {
  const water = elementByKey(ELEMENTS, 'WATER');
  const ice = elementByKey(ELEMENTS, 'ICE');
  const steam = elementByKey(ELEMENTS, 'STEAM');
  const upper = (e: ElementDef): number => e.above!.temp + e.above!.latent! / elementHeatCapacity(e);
  const lower = (e: ElementDef): number => e.below!.temp - e.below!.latent! / elementHeatCapacity(e);

  it('a cell past the top of its latent range becomes the element above, at the threshold plus the overshoot scaled by the capacities', async () => {
    const stored = upper(water) + 50;
    const { kinds, temps } = await oneSuperstep([{ type: T.WATER, temp: stored }, { type: T.WALL, temp: 0 }]);
    expect(kinds).toEqual([T.STEAM, T.WALL]);
    expect(temps[0]).toBeCloseTo(100 + (50 * elementHeatCapacity(water)) / elementHeatCapacity(steam), 3);
  });

  it('a cell under the bottom of its latent range becomes the element below, at the threshold minus the scaled overshoot', async () => {
    const stored = lower(water) - 20;
    const { kinds, temps } = await oneSuperstep([{ type: T.WATER, temp: stored }, { type: T.WALL, temp: 0 }]);
    expect(kinds).toEqual([T.ICE, T.WALL]);
    expect(temps[0]).toBeCloseTo(0 - (20 * elementHeatCapacity(water)) / elementHeatCapacity(ice), 3);
  });

  it('keeps the element while the stored temperature is inside the latent range, edges included', async () => {
    for (const stored of [100, 150, upper(water), lower(water), -20]) {
      const { kinds, temps } = await oneSuperstep([{ type: T.WATER, temp: stored }, { type: T.WALL, temp: 0 }]);
      expect(kinds, `water stored at ${stored}`).toEqual([T.WATER, T.WALL]);
      expect(temps[0], `water stored at ${stored}`).toBe(Math.fround(stored));
    }
  });

  it('carries a large overshoot through the next change in the same direction on the next dispatch', async () => {
    // Ice at 1,000 °C stored becomes water in the first dispatch at 381 °C, past water's 195, then steam in the second.
    const first = (1000 - upper(ice)) * elementHeatCapacity(ice) / elementHeatCapacity(water);
    expect(first, 'the water cell is already past its own latent range').toBeGreaterThan(upper(water));
    const { kinds, temps } = await oneSuperstep([{ type: T.ICE, temp: 1000 }, { type: T.WALL, temp: 0 }]);
    expect(kinds).toEqual([T.STEAM, T.WALL]);
    expect(temps[0]).toBeCloseTo(100 + ((first - upper(water)) * elementHeatCapacity(water)) / elementHeatCapacity(steam), 2);
  });

  it('keeps the heat of a cell through a change: the latent heat and the capacities balance', async () => {
    const stored = upper(water) + 50;
    const { temps } = await oneSuperstep([{ type: T.WATER, temp: stored }, { type: T.WALL, temp: 0 }]);
    // Heat above the water-steam threshold: water holds C·(stored - 100) of which the latent heat is not yet temperature.
    const before = elementHeatCapacity(water) * (stored - 100);
    const after = elementHeatCapacity(steam) * (temps[0] - 100) + water.above!.latent!;
    expect(after).toBeCloseTo(before, 2);
  });

  it('a burning cell starts with the lifetime of fire', async () => {
    const { kinds, lives } = await oneSuperstep([{ type: T.OIL, temp: 300, life: 2 }, { type: T.WALL, temp: 0 }]);
    expect(kinds[0], 'oil at 300 °C ignites').toBe(T.FIRE);
    expect(lives[0], 'fire starts with its lifetime, less one dispatch of decay').toBeGreaterThan(190);
  });

  it('a cell that freezes or condenses keeps no motion, and a liquid starts with no sideways direction', async () => {
    const sim = createSim(2, 1);
    const kind = new Uint32Array([cell(T.WATER), cell(T.WALL)]);
    const temp = uniformTemps(2, 0);
    tempView({ temp })[0] = lower(water) - 5;
    // A moving, left-spreading water cell: freezing must drop both.
    sim.load({ kind, temp, life: new Uint32Array([1, 0]), velocity: new Uint32Array([packHalf2(0.25, -0.25), 0]) });
    await runMany(sim, 1);
    expect([...(await readCells(sim))].map(cellType)).toEqual([T.ICE, T.WALL]);
    expect((await sim.fields.read('velocity'))[0], 'velocity').toBe(0);
    expect((await sim.fields.read('life'))[0], 'life').toBe(0);

    // Steam condenses into a liquid with life 0, and conserves heat in the below direction.
    const stored = steam.below!.temp - steam.below!.latent! / elementHeatCapacity(steam) - 10;
    const { kinds, temps, lives } = await oneSuperstep([{ type: T.STEAM, temp: stored }, { type: T.WALL, temp: 0 }]);
    expect(kinds).toEqual([T.WATER, T.WALL]);
    expect(lives[0]).toBe(0);
    const before = elementHeatCapacity(steam) * (stored - 100);
    const after = elementHeatCapacity(water) * (temps[0] - 100) - steam.below!.latent!;
    expect(after).toBeCloseTo(before, 2);
  });

  it('a fire cell is raised to the flame temperature, and smoke keeps the temperature of the fire it came from', async () => {
    const burning = await oneSuperstep([{ type: T.FIRE, temp: 300, life: 100 }, { type: T.WALL, temp: 0 }]);
    expect(burning.kinds[0]).toBe(T.FIRE);
    expect(burning.temps[0]).toBe(FIRE_TEMP);
    const dying = await oneSuperstep([{ type: T.FIRE, temp: 700, life: 4 }, { type: T.WALL, temp: 0 }]);
    expect(dying.kinds[0]).toBe(T.SMOKE);
    expect(dying.temps[0]).toBe(700);
  });

  it('oil lit by heat burns at the flame temperature from the next dispatch on', async () => {
    const { kinds, temps } = await oneSuperstep([{ type: T.OIL, temp: 260 }, { type: T.WALL, temp: 0 }]);
    expect(kinds[0]).toBe(T.FIRE);
    expect(temps[0]).toBe(FIRE_TEMP);
  });

  it('oil touching fire still ignites at once', async () => {
    const { kinds } = await oneSuperstep([{ type: T.OIL, temp: 20 }, { type: T.FIRE, temp: FIRE_TEMP, life: 100 }]);
    expect(kinds).toEqual([T.FIRE, T.FIRE]);
  });

  // A closed 24×18 box with a 4-row metal floor at `floorTemp` and 3 rows of oil on it.
  function oilOnMetal(floorTemp: number): { sim: Simulation; oil: number } {
    const width = 24;
    const height = 18;
    const kind = new Uint32Array(width * height);
    const temp = uniformTemps(width * height, 20);
    const temps = tempView({ temp });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (y === height - 1 || x === 0 || x === width - 1) kind[i] = cell(T.WALL);
        else if (y < 4) {
          kind[i] = cell(T.METAL);
          temps[i] = floorTemp;
        } else if (y < 7) kind[i] = cell(T.OIL);
      }
    }
    const sim = createSim(width, height);
    sim.load({ kind, temp });
    return { sim, oil: kind.filter((k) => cellType(k) === T.OIL).length };
  }
  const burned = (kinds: Uint32Array): boolean => kinds.some((k) => cellType(k) === T.FIRE || cellType(k) === T.SMOKE);

  it('AC12: oil on metal at 400 °C ignites, within the measured number of supersteps', async () => {
    const { sim } = oilOnMetal(400);
    let supersteps = 0;
    while (supersteps < 2000 && !burned(await readCells(sim))) {
      await runMany(sim, 5);
      supersteps += 5;
    }
    // First run: the first fire showed at the sample of superstep 15 (sampled every 5). Limit with a 30% margin: 20.
    expect(supersteps, 'supersteps until the first fire').toBeLessThanOrEqual(20);
  }, 60_000);

  it('AC12: oil on metal at 100 °C does not ignite in 2,000 supersteps', async () => {
    const { sim, oil } = oilOnMetal(100);
    for (let i = 0; i < 20; i++) {
      await runMany(sim, 100);
      const kinds = await readCells(sim);
      expect(burned(kinds), `after ${(i + 1) * 100} supersteps`).toBe(false);
      expect(kinds.filter((k) => cellType(k) === T.OIL).length).toBe(oil);
    }
  }, 120_000);
});

const count = (kinds: Uint32Array, type: number): number => countTypes(kinds).get(type) ?? 0;

describe.skipIf(!device)('M5.4c phase changes in scenes', () => {
  it('AC9: ice beside lava melts into water first, part of it boils, and the lava that touched water sets into stone', async () => {
    const scene = SCENES.iceLava();
    const { ice } = ICE_LAVA;
    const iceCells = (ice.x1 - ice.x0) * (ice.y1 - ice.y0);
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);

    let firstWater = 0;
    let firstSteam = 0;
    for (let step = 1; step <= 600; step++) {
      await runMany(sim, 1);
      const kinds = await readCells(sim);
      if (!firstWater && count(kinds, T.WATER) > 0) firstWater = step;
      if (!firstSteam && count(kinds, T.STEAM) > 0) firstSteam = step;
    }
    const kinds = await readCells(sim);
    const melted = (iceCells - count(kinds, T.ICE)) / iceCells;
    // First run: water at superstep 2, steam at 4 (the 8 ice cells touching the lava melt together and boil together), and
    // after 600 supersteps a share of 0.36 melted (the steam pushes the lava back, and empty space carries no heat until
    // M6, so the rest of the block stays), 36 steam, 0 water left and 40 stone. Limits: 30% around each.
    expect(firstWater, 'superstep of the first water').toBeGreaterThan(0);
    expect(firstSteam, 'superstep of the first steam, after the first water').toBeGreaterThan(firstWater);
    expect(melted, 'share of the ice melted').toBeGreaterThanOrEqual(0.25);
    expect(melted, 'share of the ice melted').toBeLessThanOrEqual(0.47);
    expect(count(kinds, T.STEAM), 'steam').toBeGreaterThanOrEqual(26);
    expect(count(kinds, T.STEAM), 'steam').toBeLessThanOrEqual(46);
    expect(count(kinds, T.STONE), 'stone').toBeGreaterThanOrEqual(28);
    expect(count(kinds, T.STONE), 'stone').toBeLessThanOrEqual(52);
  }, 60_000);

  function steamCeilingSim(ceilingTemp: number): Simulation {
    const scene = SCENES.steamCeiling();
    const { ceiling } = STEAM_CEILING;
    const temps = tempView(scene.fields);
    for (let y = ceiling.y0; y < ceiling.y1; y++) temps.fill(ceilingTemp, y * scene.width + ceiling.x0, y * scene.width + ceiling.x1);
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);
    return sim;
  }

  it('AC10: steam under a ceiling at -50 °C condenses', async () => {
    const sim = steamCeilingSim(-50);
    const steamCells = count(await readCells(sim), T.STEAM);
    // First run: half of the 160 cells were water at the sample of superstep 20 (sampled every 5), all of them at 60.
    // Limit: 25, a sample after the 20 with a margin of more than 30%.
    await runMany(sim, 25);
    expect(count(await readCells(sim), T.WATER), 'water after 25 supersteps').toBeGreaterThanOrEqual(steamCells / 2);
    await runMany(sim, 175);
    const kinds = await readCells(sim);
    expect(count(kinds, T.STEAM), 'steam left after 200 supersteps').toBe(0);
    expect(count(kinds, T.WATER), 'water after 200 supersteps').toBe(steamCells);
  });

  it('AC10: steam under a ceiling at 150 °C does not', async () => {
    const sim = steamCeilingSim(150);
    const steamCells = count(await readCells(sim), T.STEAM);
    for (let i = 1; i <= 30; i++) {
      await runMany(sim, 100);
      const kinds = await readCells(sim);
      expect(count(kinds, T.WATER), `water after ${i * 100} supersteps`).toBe(0);
      expect(count(kinds, T.STEAM), `steam after ${i * 100} supersteps`).toBe(steamCells);
    }
  }, 60_000);

  it('AC11: metal melts only past the top of its latent range', async () => {
    const metal = elementByKey(ELEMENTS, 'METAL');
    const molten = elementByKey(ELEMENTS, 'MOLTEN_METAL');
    const top = metal.above!.temp + metal.above!.latent! / elementHeatCapacity(metal);
    const below = await oneSuperstep([{ type: T.METAL, temp: top - 1 }, { type: T.WALL, temp: 0 }]);
    expect(below.kinds, `metal stored at ${top - 1}`).toEqual([T.METAL, T.WALL]);
    const past = await oneSuperstep([{ type: T.METAL, temp: top + 1 }, { type: T.WALL, temp: 0 }]);
    expect(past.kinds, `metal stored at ${top + 1}`).toEqual([T.MOLTEN_METAL, T.WALL]);
    expect(past.temps[0]).toBeCloseTo(metal.above!.temp + (elementHeatCapacity(metal) / elementHeatCapacity(molten)), 3);
  });

  it('AC11: molten metal on a thick cold metal floor sets back into metal', async () => {
    const scene = SCENES.moltenMetal();
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);
    const before = countTypes(await readCells(sim));
    expect(before.get(T.MOLTEN_METAL), 'molten metal at the start').toBeGreaterThan(0);
    // First run: the last molten cell set at the sample of superstep 15 (sampled every 5). Limit with a 30% margin: 20.
    await runMany(sim, 20);
    const kinds = await readCells(sim);
    expect(count(kinds, T.MOLTEN_METAL), 'molten metal after 20 supersteps').toBe(0);
    expect(count(kinds, T.METAL), 'metal after 20 supersteps').toBe(before.get(T.METAL)! + before.get(T.MOLTEN_METAL)!);
  });

  it('AC11: lava at 1,300 °C never melts metal', async () => {
    const scene = SCENES.moltenMetal();
    const { pool } = MOLTEN_METAL;
    const temps = tempView(scene.fields);
    for (let y = pool.y0; y < pool.y1; y++) {
      for (let x = pool.x0; x < pool.x1; x++) {
        scene.fields.kind[y * scene.width + x] = cell(T.LAVA);
        temps[y * scene.width + x] = elementTemperature(elementByKey(ELEMENTS, 'LAVA'));
      }
    }
    const sim = createSim(scene.width, scene.height);
    sim.load(scene.fields);
    const metalBefore = count(await readCells(sim), T.METAL);
    for (let step = 0; step < 30; step++) {
      await runMany(sim, 100);
      const kinds = await readCells(sim);
      expect(count(kinds, T.MOLTEN_METAL), `molten metal after ${(step + 1) * 100} supersteps`).toBe(0);
      expect(count(kinds, T.METAL), `metal after ${(step + 1) * 100} supersteps`).toBe(metalBefore);
    }
    // The lava gave its heat up: it set into stone (first run: all 80 cells), so the metal was hot enough to be tested.
    expect(count(await readCells(sim), T.STONE), 'lava set into stone').toBeGreaterThan(0);
  }, 60_000);
});

// A box of walls around layers of one element each (bottom first, 8 cells wide), packed with no empty cell.
function packedBox(layers: { type: number; temp: number; rows: number }[]): { sim: Simulation; kind: Uint32Array; temp: Uint32Array } {
  const inner = 8;
  const rows = layers.reduce((n, l) => n + l.rows, 0);
  const width = inner + 4;
  const height = rows + 4;
  const kind = new Uint32Array(width * height).fill(cell(T.WALL));
  const temp = uniformTemps(width * height, 0);
  const temps = tempView({ temp });
  let y = 2;
  for (const layer of layers) {
    for (let r = 0; r < layer.rows; r++, y++) {
      for (let x = 2; x < 2 + inner; x++) {
        kind[y * width + x] = cell(layer.type);
        temps[y * width + x] = layer.temp;
      }
    }
  }
  const sim = createSim(width, height);
  sim.load({ kind, temp });
  return { sim, kind, temp };
}

describe.skipIf(!device)('M5.4c settling at a threshold', () => {
  // Runs 500 supersteps, one at a time, and fails at the first one that changes any cell's element.
  async function settle(box: ReturnType<typeof packedBox>, threshold: number): Promise<number> {
    for (let step = 1; step <= 500; step++) {
      await runMany(box.sim, 1);
      const kinds = await readCells(box.sim);
      for (let i = 0; i < kinds.length; i++) {
        if (kinds[i] !== box.kind[i]) expect.fail(`cell ${i} changed from element ${cellType(box.kind[i])} to ${cellType(kinds[i])} at superstep ${step}`);
      }
    }
    const temps = tempView({ temp: await box.sim.fields.read('temp') });
    let worst = 0;
    box.kind.forEach((k, i) => {
      if (cellType(k) === T.WALL) return;
      const e = (ELEMENTS as readonly ElementDef[]).find((row) => row.id === cellType(k))!;
      worst = Math.max(worst, Math.abs(effectiveTemp(e, temps[i]) - threshold));
    });
    return worst;
  }

  it('AC13: ice over water settles at 0 °C and changes no cell', async () => {
    // 5 rows of water at 10 °C under 5 rows of ice at -20 °C: the ice needs 1,520 to reach 0 °C and the water gives 1,680,
    // so the 160 left over cannot pay the 300 an ice cell needs to melt. First run: every cell within 0.08 °C of 0 °C.
    const worst = await settle(packedBox([{ type: T.WATER, temp: 10, rows: 5 }, { type: T.ICE, temp: -20, rows: 5 }]), 0);
    expect(worst, 'largest distance of a temperature from 0 °C').toBeLessThan(0.15);
  }, 60_000);

  it('AC13: steam over water settles at 100 °C and changes no cell', async () => {
    // 5 rows of steam at 110 °C over 5 rows of water at 90 °C: the water needs 1,680 to reach 100 °C and the steam gives
    // 800 as steam, the other 880 at most from the 8 cells at the surface (110 each, under the 400 a cell needs to condense).
    // First run: every cell within 0.09 °C of 100 °C.
    const worst = await settle(packedBox([{ type: T.WATER, temp: 90, rows: 5 }, { type: T.STEAM, temp: 110, rows: 5 }]), 100);
    expect(worst, 'largest distance of a temperature from 100 °C').toBeLessThan(0.15);
  }, 60_000);
});

describe.skipIf(!device)('M5.4c total heat', () => {
  it('AC14: a sealed box across all thresholds keeps its total heat, latent heat included, over 2,000 supersteps', async () => {
    const width = 48;
    const height = 40;
    const sim = createSim(width, height, 14);
    const next = mulberry32(14);
    const rand = (): number => next() / 2 ** 32;
    // Start temperatures straddle each element's thresholds (and the latent ends beyond them), so phases change both ways.
    const range: [number, number, number][] = [
      [T.ICE, -100, 300], [T.WATER, -100, 300], [T.STEAM, -150, 300], [T.STONE, 800, 1500],
      [T.LAVA, 900, 1500], [T.METAL, 1300, 1900], [T.MOLTEN_METAL, 1200, 1900], [T.EMPTY, 0, 0],
    ];
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
        const [type, low, high] = range[Math.floor(rand() * range.length)];
        kind[i] = cell(type);
        if (type !== T.EMPTY) temps[i] = low + rand() * (high - low);
      }
    }
    sim.load({ kind, temp });
    const measure = async (): Promise<{ heat: number; types: Map<number, number> }> => {
      const grid = { kind: await readCells(sim), temp: await sim.fields.read('temp') };
      return { heat: heatContent(ELEMENTS, grid, await sim.flyers.read()), types: countTypes(grid.kind) };
    };
    const before = await measure();

    for (let i = 1; i <= 4; i++) {
      await runMany(sim, 500);
      const now = await measure();
      // First run: a relative change of 6e-8 after 2,000 supersteps.
      expect(Math.abs(now.heat - before.heat) / Math.abs(before.heat), `heat after ${i * 500} supersteps, ${before.heat} at the start`).toBeLessThan(1e-4);
    }
    // The elements changed: lava and molten metal set, stone and metal grew, ice and water boiled into steam.
    const after = await measure();
    for (const [type, name] of [[T.STONE, 'stone'], [T.METAL, 'metal'], [T.STEAM, 'steam']] as const) {
      expect(after.types.get(type)!, name).toBeGreaterThan(before.types.get(type)!);
    }
    for (const [type, name] of [[T.LAVA, 'lava'], [T.MOLTEN_METAL, 'molten metal'], [T.ICE, 'ice']] as const) {
      expect(after.types.get(type) ?? 0, name).toBeLessThan(before.types.get(type)!);
    }
  }, 120_000);
});
