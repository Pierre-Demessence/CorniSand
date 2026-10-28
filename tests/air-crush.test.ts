import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementHeatCapacity } from '../src/elements';
import { caWGSL } from '../src/shaders/ca.wgsl';
import { RULES } from '../src/shaders/rules';
import type { AirCellSize } from '../src/air';
import { FRAME_SUPERSTEPS, cell, cellType, createSim, device, loadScene, readCells, run, runMany } from './gpu';

// Pressure transitions (M6.5): a cell whose air cell is above its element's `pressureAbove.pressure` becomes the target
// element in that dispatch, keeping its temperature. STONE is crushed into SAND.

const STONE = elementByKey(ELEMENTS, 'STONE');
const SAND = elementByKey(ELEMENTS, 'SAND');
const LIMIT = STONE.pressureAbove!.pressure;
// What 500 °C of stone becomes as sand: the same heat.
const SAND_TEMP = (500 * elementHeatCapacity(STONE)) / elementHeatCapacity(SAND);

// A charge of 8x6 gunpowder cells on a wall platform in the middle of an open grid, lit by a fire cell on its left; a row
// of single stone cells (one cell does not seal an air cell) every 3 cells to its right, from the charge's right edge.
const WIDTH = 192;
const HEIGHT = 128;
const CHARGE = { x0: 60, x1: 68, y0: 60, y1: 66 };
const STONE_ROW = { y: 62, from: 69, to: 130, step: 3 };
const SUPERSTEPS = 40;

function blast(wall: boolean): { kind: Uint32Array<ArrayBuffer>; life: Uint32Array<ArrayBuffer>; stones: number[] } {
  const kind = new Uint32Array(WIDTH * HEIGHT);
  const life = new Uint32Array(WIDTH * HEIGHT);
  const fill = (x0: number, y0: number, x1: number, y1: number, type: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) kind[y * WIDTH + x] = cell(type);
  };
  fill(40, 56, 140, 60, T.WALL);
  fill(CHARGE.x0, CHARGE.y0, CHARGE.x1, CHARGE.y1, T.GUNPOWDER);
  const stones: number[] = [];
  for (let x = STONE_ROW.from; x < STONE_ROW.to; x += STONE_ROW.step) {
    kind[STONE_ROW.y * WIDTH + x] = cell(T.STONE);
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
async function crushedAt(options: { wall: boolean; air?: boolean }): Promise<{ crushed: number[]; standing: number[] }> {
  const { kind, life, stones } = blast(options.wall);
  const sim = createSim(WIDTH, HEIGHT, 3, { air: options.air ?? true });
  sim.load({ kind, life });
  await runMany(sim, SUPERSTEPS);
  const cells = await readCells(sim);
  const crushed: number[] = [];
  const standing: number[] = [];
  for (const x of stones) {
    if (kind[STONE_ROW.y * WIDTH + x] !== cell(T.STONE)) continue; // the wall stands there
    (cellType(cells[STONE_ROW.y * WIDTH + x]) === T.STONE ? standing : crushed).push(x - CHARGE.x1);
  }
  return { crushed, standing };
}

describe.skipIf(!device)('M6 pressure transitions', () => {
  describe('AC18: one cell', () => {
    // Three stones at 500 °C, in three air cells whose pressures are below, exactly at and above the limit. The air is at
    // the temperature of the stones, so the air exchange (before the dispatch) moves no heat.
    it('M6 AC18: a cell becomes sand in the dispatch its air cell passes the limit, and keeps its heat, not its temperature', async () => {
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
      expect(cellType(cells[at(13)]), 'above the limit').toBe(T.SAND);
      const temps = tempView({ temp: await sim.fields.read('temp') });
      // Stone holds 2.2 per degree and sand 1.3: 500 degrees of stone are 846 degrees of sand, the same heat.
      expect(temps[at(13)], 'the sand starts at the temperature that holds the heat of the stone').toBeCloseTo(SAND_TEMP, 0);
      expect(temps[at(13)] * elementHeatCapacity(SAND), 'heat of the crushed cell').toBeCloseTo(500 * elementHeatCapacity(STONE), 0);
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
    it('M6 AC18: stone near a lit charge is crushed into sand, stone far from it is not, and a wall shields the stone behind it', async () => {
      const open = await crushedAt({ wall: false });
      // Measured: the stones up to 13 cells from the charge's right edge are crushed, those from 16 on stand.
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
      const dry = await crushedAt({ wall: false, air: false });
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
});
