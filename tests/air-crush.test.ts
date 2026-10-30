import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, crushPressure, elementByKey, elementHeatCapacity, type ElementDef } from '../src/elements';
import { caWGSL } from '../src/shaders/ca.wgsl';
import { RULES } from '../src/shaders/rules';
import type { AirCellSize } from '../src/air';
import { FRAME_SUPERSTEPS, cell, cellType, createSim, device, loadScene, readCells, run, runMany } from './gpu';
import { NO_SHOCK_TABLE } from './no-shock-table';

// Pressure transitions (M6.5): a cell whose air cell is above its element's crush pressure (`crushPressure`) becomes the target
// element in that dispatch, keeping its temperature. STONE (basalt) is crushed into GRAVEL.

const STONE = elementByKey(ELEMENTS, 'STONE');
const GRAVEL = elementByKey(ELEMENTS, 'GRAVEL');
const LIMIT = crushPressure(STONE)!;
// What 500 °C of basalt becomes as gravel: the same heat.
const GRAVEL_TEMP = (500 * elementHeatCapacity(STONE)) / elementHeatCapacity(GRAVEL);

// A charge of 8x6 gunpowder cells on a wall platform in the middle of an open grid, lit by a fire cell on its left; a row
// of single stone cells (one cell does not seal an air cell) every 3 cells to its right, from the charge's right edge.
const WIDTH = 192;
const HEIGHT = 128;
const CHARGE = { x0: 60, x1: 68, y0: 60, y1: 66 };
const STONE_ROW = { y: 62, from: 69, to: 130, step: 3 };
const SUPERSTEPS = 40;

function blast(wall: boolean, type: number = T.STONE): { kind: Uint32Array<ArrayBuffer>; life: Uint32Array<ArrayBuffer>; stones: number[] } {
  const kind = new Uint32Array(WIDTH * HEIGHT);
  const life = new Uint32Array(WIDTH * HEIGHT);
  const fill = (x0: number, y0: number, x1: number, y1: number, type: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) kind[y * WIDTH + x] = cell(type);
  };
  fill(40, 56, 140, 60, T.WALL);
  fill(CHARGE.x0, CHARGE.y0, CHARGE.x1, CHARGE.y1, T.GUNPOWDER);
  const stones: number[] = [];
  for (let x = STONE_ROW.from; x < STONE_ROW.to; x += STONE_ROW.step) {
    kind[STONE_ROW.y * WIDTH + x] = cell(type);
    stones.push(x);
  }
  // A wall two cells thick, 40 tall, 4 cells from the charge: the stones behind it are within the reach of the blast.
  if (wall) fill(72, 60, 74, 100, T.WALL);
  kind[62 * WIDTH + CHARGE.x0 - 1] = cell(T.FIRE);
  life[62 * WIDTH + CHARGE.x0 - 1] = elementByKey(ELEMENTS, 'FIRE').life!.start;
  return { kind, life, stones };
}

// The stones of the row, by their distance from the charge's right edge, split into those that are not stone any more
// after the blast and those that still are.
async function crushedAt(options: { wall: boolean; air?: boolean; type?: number; elements?: readonly ElementDef[] }): Promise<{ crushed: number[]; standing: number[] }> {
  const type = options.type ?? T.STONE;
  const { kind, life, stones } = blast(options.wall, type);
  const sim = createSim(WIDTH, HEIGHT, 3, { air: options.air ?? true, ...(options.elements && { elements: options.elements }) });
  sim.load({ kind, life });
  await runMany(sim, SUPERSTEPS);
  const cells = await readCells(sim);
  const crushed: number[] = [];
  const standing: number[] = [];
  for (const x of stones) {
    if (kind[STONE_ROW.y * WIDTH + x] !== cell(type)) continue; // the wall stands there
    (cellType(cells[STONE_ROW.y * WIDTH + x]) === type ? standing : crushed).push(x - CHARGE.x1);
  }
  return { crushed, standing };
}

describe.skipIf(!device)('M6 pressure transitions', () => {
  describe('AC18: one cell', () => {
    // Three stones at 500 °C, in three air cells whose pressures are below, exactly at and above the limit. The air is at
    // the temperature of the stones, so the air exchange (before the dispatch) moves no heat.
    it('M6 AC18: a cell becomes gravel in the dispatch its air cell passes the limit, and keeps its heat, not its temperature', async () => {
      const width = 64;
      const sim = createSim(width, 64, 3);
      const kind = new Uint32Array(width * 64);
      const temp = new Uint32Array(width * 64);
      tempView({ temp }).fill(500);
      const at = (airX: number): number => (9 * 4 + 1) * width + airX * 4 + 1;
      const pressures: [number, number][] = [[3, LIMIT * 0.95], [8, LIMIT], [13, LIMIT * 1.05]];
      for (const [airX] of pressures) kind[at(airX)] = cell(T.STONE);
      sim.load({ kind, temp });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      for (const [airX, p] of pressures) pressure[9 * columns + airX] = Math.fround(p);
      sim.air.load({ pressure, temperature: new Float32Array(columns * rows).fill(500) });
      await run(sim, 1);
      const cells = await readCells(sim);
      expect(cellType(cells[at(3)]), 'below the limit').toBe(T.STONE);
      expect(cellType(cells[at(8)]), 'exactly at the limit').toBe(T.STONE);
      expect(cellType(cells[at(13)]), 'above the limit').toBe(T.GRAVEL);
      const temps = tempView({ temp: await sim.fields.read('temp') });
      // Gravel keeps its parent's capacity (a cell is one unit of matter), so the crushed cell keeps the temperature too.
      expect(temps[at(13)], 'the gravel starts at the temperature that holds the heat of the basalt').toBeCloseTo(GRAVEL_TEMP, 0);
      expect(temps[at(13)] * elementHeatCapacity(GRAVEL), 'heat of the crushed cell').toBeCloseTo(500 * elementHeatCapacity(STONE), 0);
    });

    it('M6 AC18: the temperature threshold wins over the pressure limit in the same dispatch: hot stone in high pressure melts', async () => {
      const width = 64;
      const sim = createSim(width, 64, 3);
      const kind = new Uint32Array(width * 64);
      const temp = new Uint32Array(width * 64);
      // Past the melting point by the whole latent heat (1,200 °C plus latent / capacity), and 100 °C more.
      const melting = STONE.above!.temp + (STONE.above!.latent ?? 0) / elementHeatCapacity(STONE) + 100;
      tempView({ temp }).fill(melting);
      const at = (9 * 4 + 1) * width + 3 * 4 + 1;
      kind[at] = cell(T.STONE);
      sim.load({ kind, temp });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      pressure[9 * columns + 3] = Math.fround(LIMIT * 5);
      sim.air.load({ pressure, temperature: new Float32Array(columns * rows).fill(melting) });
      await run(sim, 1);
      const cells = await readCells(sim);
      expect(cellType(cells[at]), 'stone past its melting point and over the limit').toBe(T.LAVA);
    });

    it('M6 AC18: stone does not change in air at rest, and a cell of another element is not crushed by the same pressure', async () => {
      const width = 64;
      const kind = new Uint32Array(width * 64);
      const at = (airX: number): number => (9 * 4 + 1) * width + airX * 4 + 1;
      kind[at(3)] = cell(T.STONE);
      kind[at(8)] = cell(T.METAL);
      const sim = createSim(width, 64, 3);
      sim.load({ kind });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows).fill(0);
      pressure[9 * columns + 8] = 5 * LIMIT;
      sim.air.load({ pressure });
      await run(sim, 1);
      const cells = await readCells(sim);
      expect(cellType(cells[at(3)]), 'stone at 0 pressure').toBe(T.STONE);
      expect(cellType(cells[at(8)]), 'metal at 5 times the limit').toBe(T.METAL);
    });
  });

  describe('AC18: a gunpowder charge', () => {
    it('M6 AC18: stone near a lit charge is crushed into gravel, stone far from it is not, and a wall shields the stone behind it', async () => {
      const open = await crushedAt({ wall: false });
      // Measured: the stones up to 16 cells from the charge's right edge are crushed, those from 19 on stand.
      expect(open.crushed.length, 'stones crushed in the open').toBeGreaterThanOrEqual(4);
      expect(Math.max(...open.crushed), 'the farthest crushed stone, cells from the charge').toBeGreaterThanOrEqual(10);
      expect(Math.max(...open.crushed), 'the farthest crushed stone, cells from the charge').toBeLessThanOrEqual(20);
      expect(Math.min(...open.standing), 'the nearest stone left standing').toBeGreaterThan(Math.max(...open.crushed));
      expect(open.standing.filter((d) => d <= 10), 'stones within 10 cells that stand').toEqual([]);
      expect(open.crushed.filter((d) => d > 20), 'stones past 20 cells that were crushed').toEqual([]);

      // The same stones behind a wall: those the open blast crushed past the wall (it stands at 4 to 5) all stand.
      const shielded = await crushedAt({ wall: true });
      const behind = open.crushed.filter((d) => d > 6);
      expect(behind.length, 'stones the wall shields in the control').toBeGreaterThanOrEqual(2);
      expect(shielded.crushed.filter((d) => d > 6), 'crushed behind the wall').toEqual([]);
      expect(shielded.crushed, 'the stone in front of the wall').toEqual(expect.arrayContaining([1]));
    }, 60_000);

    it('M6 AC18: without air nothing is crushed, and the CA source has the pressure code only with air', async () => {
      // Without thermal shock: the stone beside the burning charge would crack from the heat (tests/shock.test.ts), which is no crush.
      const dry = await crushedAt({ wall: false, air: false, elements: NO_SHOCK_TABLE });
      expect(dry.crushed, 'crushed stones').toEqual([]);
      const shape = { cellSize: 4, columns: 16, rows: 16 };
      expect(caWGSL(64, 64, ELEMENTS, RULES, 1024), 'without air').not.toContain('> elPressureAbove(t)');
      expect(caWGSL(64, 64, ELEMENTS, RULES, 1024, shape), 'with air').toContain('> elPressureAbove(t)');
    }, 60_000);

    it('M6 AC18: two runs from the same seed crush the same cells', async () => {
      const once = async (): Promise<Uint32Array> => {
        const { kind, life } = blast(false);
        const sim = createSim(WIDTH, HEIGHT, 3);
        sim.load({ kind, life });
        await runMany(sim, SUPERSTEPS);
        return readCells(sim);
      };
      expect(await once()).toEqual(await once());
    }, 60_000);
  });

  // The M6.6 gate: a ring of stone 3 cells thick filled with gunpowder kept most of its stone, because a cell inside a wall
  // read only the air cell it sits in, which the wall closes off, and because at air cell size 2 a burst raised the pressure
  // a quarter as much (AC29 in tests/air-burst.test.ts). Measured before the fix: 30% (size 4) and 72% (size 2) of the
  // stone left; after: 5.9% and none (the walls break open where they are crushed first and the rest of the blast vents
  // there; with rings of radius 50 and 80, 1.5% and none).
  describe('AC29: a sealed charge', () => {
    it.each([4, 2] as AirCellSize[])('M6 AC29: two rings of stone 3 cells thick with gunpowder between them break when it is lit (air cell size %i)', async (airCellSize) => {
      const size = 192;
      const kind = new Uint32Array(size * size);
      const life = new Uint32Array(size * size);
      const ring = new Uint8Array(size * size);
      let stone = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const r = Math.hypot(x + 0.5 - 96, y + 0.5 - 96);
          const k = y * size + x;
          if (Math.abs(r - 30) <= 1.5 || Math.abs(r - 50) <= 1.5) {
            kind[k] = cell(T.STONE);
            ring[k] = 1;
            stone++;
          } else if (r > 30 && r < 50) {
            kind[k] = cell(T.GUNPOWDER);
          }
        }
      }
      const fire = 96 * size + 136;
      kind[fire] = cell(T.FIRE);
      life[fire] = elementByKey(ELEMENTS, 'FIRE').life!.start;
      const sim = createSim(size, size, 5, { airCellSize });
      loadScene(sim, kind, life);
      await runMany(sim, 30 * FRAME_SUPERSTEPS, FRAME_SUPERSTEPS);
      const cells = await readCells(sim);
      let left = 0;
      for (let k = 0; k < cells.length; k++) if (ring[k] && cellType(cells[k]) === T.STONE) left++;
      expect(left / stone, 'share of the stone left').toBeLessThan(0.08);
    }, 60_000);

    // A stone cell reads the air cell of a neighbor only when that neighbor is open to the air: a wall 1 cell thick in the
    // last column of an air cell leaves that air cell open on the blast side, and the stone touching the wall's far side
    // must not feel it. Air column 0 holds 5 times the limit; the stone column is x = 4, in air column 1.
    it.each([true, false])('M6 AC29: stone behind a wall 1 cell thick on an air-cell boundary is not crushed by the blast beyond it (wall: %s)', async (wall) => {
      const width = 64;
      const kind = new Uint32Array(width * 64);
      for (let y = 0; y < 64; y++) {
        if (wall) kind[y * width + 3] = cell(T.WALL);
        if (y >= 20 && y < 40) kind[y * width + 4] = cell(T.STONE);
      }
      const sim = createSim(width, 64, 3);
      sim.load({ kind });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      for (let j = 0; j < rows; j++) pressure[j * columns] = Math.fround(LIMIT * 5);
      sim.air.load({ pressure });
      await run(sim, 1);
      const cells = await readCells(sim);
      let standing = 0;
      for (let y = 20; y < 40; y++) if (cellType(cells[y * width + 4]) === T.STONE) standing++;
      // Without the wall the stone touches the open air cell and is crushed: the control.
      expect(standing, 'stone cells left of 20').toBe(wall ? 20 : 0);
    });
  });

  // M8.1 AC15: the same charge among the materials that break, each as the row of single cells of the stone test (same cells,
  // same seed): the less tough a material, the farther out it breaks. Ceramic and diamond never break.
  describe('M8.1 AC15: what a blast breaks', () => {
    const farthest = async (type: number): Promise<number> => {
      const { crushed, standing } = await crushedAt({ wall: false, type });
      expect(Math.min(...standing, Infinity), 'a cell left standing nearer than the farthest crushed one').toBeGreaterThan(Math.max(...crushed, 0));
      return Math.max(...crushed, 0);
    };

    it('M8.1 AC15: basalt, brick, glass and ice break out to radii in the order of their toughness, glass farther out than basalt', async () => {
      // Measured, in cells from the charge's right edge (the row's cells are 3 apart): basalt 16, brick 28, glass 46, ice 61 (the end of the row).
      const radius = { basalt: await farthest(T.STONE), brick: await farthest(T.BRICK), glass: await farthest(T.GLASS), ice: await farthest(T.ICE) };
      expect(radius.basalt, 'basalt').toBeGreaterThanOrEqual(10);
      expect(radius.basalt, 'basalt').toBeLessThanOrEqual(20);
      expect(radius.brick, 'brick, between basalt and glass').toBeGreaterThan(radius.basalt);
      expect(radius.glass, 'glass farther out than brick').toBeGreaterThan(radius.brick);
      expect(radius.glass, 'glass, in the open').toBeLessThanOrEqual(55);
      expect(radius.ice, 'ice, the most brittle, farthest').toBeGreaterThan(radius.glass);
    }, 120_000);

    it('M8.1 AC15: ceramic and diamond do not change anywhere in the row, nor under five times the pressure that crushes ice', async () => {
      for (const type of [T.CERAMIC, T.DIAMOND]) {
        const { crushed, standing } = await crushedAt({ wall: false, type });
        expect(crushed, `${type === T.CERAMIC ? 'ceramic' : 'diamond'} cells changed by the blast`).toEqual([]);
        expect(standing.length, 'cells standing').toBeGreaterThanOrEqual(15);
      }
      const width = 64;
      const sim = createSim(width, 64, 3);
      const kind = new Uint32Array(width * 64);
      const at = (airX: number): number => (9 * 4 + 1) * width + airX * 4 + 1;
      kind[at(3)] = cell(T.CERAMIC);
      kind[at(8)] = cell(T.DIAMOND);
      sim.load({ kind });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      const hard = Math.fround(crushPressure(elementByKey(ELEMENTS, 'ICE'))! * 5);
      pressure[9 * columns + 3] = hard;
      pressure[9 * columns + 8] = hard;
      sim.air.load({ pressure });
      await run(sim, 1);
      const cells = await readCells(sim);
      expect([cellType(cells[at(3)]), cellType(cells[at(8)])], 'ceramic and diamond at five times the limit of ice').toEqual([T.CERAMIC, T.DIAMOND]);
    });

    it('M8.1 AC15: each breaks into its broken form, keeping its heat', async () => {
      const forms: [string, string][] = [['STONE', 'GRAVEL'], ['BRICK', 'GRAVEL'], ['GLASS', 'BROKEN_GLASS'], ['ICE', 'SNOW']];
      const width = 64;
      const sim = createSim(width, 64, 3);
      const kind = new Uint32Array(width * 64);
      const temp = new Uint32Array(width * 64);
      tempView({ temp }).fill(-5);
      const at = (airX: number): number => (9 * 4 + 1) * width + airX * 4 + 1;
      forms.forEach(([key], i) => { kind[at(2 + 3 * i)] = cell(T[key as keyof typeof T]); });
      sim.load({ kind, temp });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      forms.forEach(([key], i) => { pressure[9 * columns + 2 + 3 * i] = Math.fround(crushPressure(elementByKey(ELEMENTS, key))! * 1.5); });
      sim.air.load({ pressure, temperature: new Float32Array(columns * rows).fill(-5) });
      await run(sim, 1);
      const cells = await readCells(sim);
      const temps = tempView({ temp: await sim.fields.read('temp') });
      forms.forEach(([key, form], i) => {
        const x = at(2 + 3 * i);
        expect(cellType(cells[x]), `${key} past its limit`).toBe(T[form as keyof typeof T]);
        expect(temps[x] * elementHeatCapacity(elementByKey(ELEMENTS, form)), `heat of the ${form}`).toBeCloseTo(-5 * elementHeatCapacity(elementByKey(ELEMENTS, key)), 0);
      });
    });
  });
});
