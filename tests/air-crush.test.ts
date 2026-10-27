import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementHeatCapacity } from '../src/elements';
import { caWGSL } from '../src/shaders/ca.wgsl';
import { RULES } from '../src/shaders/rules';
import { cell, cellType, createSim, device, readCells, run, runMany } from './gpu';

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
    // the temperature the crushed sand starts at, so the air exchange (after the dispatch) moves no heat.
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
      sim.air.load({ pressure, temperature: new Float32Array(columns * rows).fill(SAND_TEMP) });
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
      tempView({ temp }).fill(1600);
      const at = (9 * 4 + 1) * width + 3 * 4 + 1;
      kind[at] = cell(T.STONE);
      sim.load({ kind, temp });
      const { columns, rows } = sim.air;
      const pressure = new Float32Array(columns * rows);
      pressure[9 * columns + 3] = Math.fround(LIMIT * 5);
      sim.air.load({ pressure, temperature: new Float32Array(columns * rows).fill(1600) });
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
});
