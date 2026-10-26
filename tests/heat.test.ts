import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementTemperature } from '../src/elements';
import { ROOM_TEMP } from '../src/heat';
import { SCENES } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { cell, cellType, createSim, device, idleInput, readCells, run, runMany } from './gpu';

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
    const sim = createSim(width, height, 5);
    const kind = new Uint32Array(width * height);
    // Empty cells at 0, as after Clear or the eraser: a grain at -0 moving into one must keep its sign bit.
    const temp = uniformTemps(width * height, 0);
    const temps = tempView({ temp });
    const marked: number[] = [];
    for (const y of [50, 51]) {
      for (let x = 1; x < width; x += 2) {
        const i = y * width + x;
        kind[i] = cell(T.SAND);
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
      if (cellType(kindAfter[i]) === T.SAND) carried.push(tempAfter[i]);
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
