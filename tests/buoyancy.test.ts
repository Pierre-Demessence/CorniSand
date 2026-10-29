import { describe, expect, it } from 'vitest';
import { emptyCellData, tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, densityAt, elementByKey, type ElementDef } from '../src/elements';
import { ROOM_TEMP } from '../src/heat';
import type { Simulation } from '../src/simulation';
import { cell, cellType, createSim, device, readCells, runMany } from './gpu';

const SMOKE = elementByKey(ELEMENTS, 'SMOKE');
const STEAM = elementByKey(ELEMENTS, 'STEAM');
const EMPTY = elementByKey(ELEMENTS, 'EMPTY');

// Test gases that hold no heat of their own to speak of: a cell stays at the temperature it is loaded at.
const GAS = (id: number, key: string, density: number): ElementDef => ({
  key, id, label: key, color: [0.5, 0.5, 0.5], state: 'gas', density, conductivity: 0.04, heatCapacity: 1,
});
const HEAVY_ID = 220;
const HEAVY = GAS(HEAVY_ID, 'HEAVY_GAS', 2);
const LIGHT_ID = 221;
const LIGHT = GAS(LIGHT_ID, 'LIGHT_GAS', 1);
const SLIGHTLY_ID = 222;
// Heavier than the air by a twelfth: a slow sinker.
const SLIGHTLY = GAS(SLIGHTLY_ID, 'SLIGHTLY_HEAVY_GAS', 1.3);
const TABLE = [...ELEMENTS, HEAVY, LIGHT, SLIGHTLY];

const WIDTH = 20;
const FLOOR = 2;

interface Box {
  height: number;
  kind: Uint32Array<ArrayBuffer>;
  temp: Uint32Array<ArrayBuffer>;
  set(type: number, x: number, y: number, temp?: number): void;
}

// A sealed box (walls 2 cells thick on every side) of room-temperature empty space; cells added with `set`.
function box(height: number): Box {
  const data = emptyCellData(WIDTH * height);
  const temps = tempView(data);
  temps.fill(ROOM_TEMP);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (y < FLOOR || y >= height - FLOOR || x < FLOOR || x >= WIDTH - FLOOR) data.kind[y * WIDTH + x] = cell(T.WALL);
    }
  }
  return {
    height,
    kind: data.kind,
    temp: data.temp,
    set(type, x, y, temp = ROOM_TEMP) {
      data.kind[y * WIDTH + x] = cell(type);
      temps[y * WIDTH + x] = temp;
    },
  };
}

function simOf(b: Box, options: { air: boolean }): Simulation {
  const sim = createSim(WIDTH, b.height, 3, { elements: TABLE, air: options.air });
  sim.load({ kind: b.kind, temp: b.temp });
  return sim;
}

// The rows (y, bottom = 0) of every cell of `type`.
async function rowsOf(sim: Simulation, type: number): Promise<number[]> {
  const kinds = await readCells(sim);
  const rows: number[] = [];
  for (let i = 0; i < kinds.length; i++) if (cellType(kinds[i]) === type) rows.push(Math.floor(i / WIDTH));
  return rows;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

describe.skipIf(!device)('M8.8 AC13: gas buoyancy', () => {
  // Cells of a gas on a shelf of rows [y0, y1), the whole width of the box's inside.
  function shelf(type: number, y0: number, y1: number, height: number): Box {
    const b = box(height);
    for (let y = y0; y < y1; y++) for (let x = FLOOR; x < WIDTH - FLOOR; x++) b.set(type, x, y);
    return b;
  }

  it.each([['with air', true], ['without air', false]])('M8.8 AC13: a gas of 2 kg/m³ at 20 °C settles to the floor of a box (%s)', async (_name, air) => {
    const sim = simOf(shelf(HEAVY_ID, 20, 25, 40), { air });
    await runMany(sim, 400);
    const rows = await rowsOf(sim, HEAVY_ID);
    expect(rows, 'gas cells').toHaveLength(5 * (WIDTH - 2 * FLOOR));
    expect(Math.max(...rows), 'highest gas cell').toBeLessThanOrEqual(FLOOR + 6);
    expect(mean(rows), 'mean height').toBeLessThanOrEqual(FLOOR + 3.5);
  });

  it.each([['with air', true], ['without air', false]])('M8.8 AC13: a gas of 1 kg/m³ at 20 °C rises to the ceiling of a box (%s)', async (_name, air) => {
    const sim = simOf(shelf(LIGHT_ID, 6, 11, 40), { air });
    await runMany(sim, 400);
    const rows = await rowsOf(sim, LIGHT_ID);
    expect(rows).toHaveLength(5 * (WIDTH - 2 * FLOOR));
    expect(Math.min(...rows), 'lowest gas cell').toBeGreaterThanOrEqual(40 - FLOOR - 6);
  });

  it('M8.8 AC13: steam at 110 °C rises to the ceiling', async () => {
    const b = box(60);
    for (let x = FLOOR; x < WIDTH - FLOOR; x += 2) b.set(T.STEAM, x, 10, 110);
    const sim = simOf(b, { air: true });
    await runMany(sim, 60);
    const rows = await rowsOf(sim, T.STEAM);
    expect(rows).toHaveLength(8);
    expect(Math.min(...rows), 'lowest steam cell after 60 supersteps').toBeGreaterThanOrEqual(60 - FLOOR - 2);
    expect(densityAt(STEAM, 110)).toBeLessThan(densityAt(EMPTY, ROOM_TEMP));
  });

  // The mean distance, in rows, that a sparse row of gas cells at `height` falls (or rises) in `supersteps`.
  async function travelled(type: number, temp: number, supersteps: number, airTemp?: number): Promise<number> {
    const height = 400;
    const start = 200;
    const b = box(height);
    for (let x = FLOOR; x < WIDTH - FLOOR; x += 2) b.set(type, x, start, temp);
    const sim = simOf(b, { air: true });
    if (airTemp !== undefined) sim.air.load({ temperature: new Float32Array(sim.air.columns * sim.air.rows).fill(airTemp) });
    await runMany(sim, supersteps);
    const rows = await rowsOf(sim, type);
    expect(rows).toHaveLength(8);
    return mean(rows) - start;
  }

  it('M8.8 AC13: a gas falls faster the heavier it is than the air', async () => {
    const dense = await travelled(HEAVY_ID, ROOM_TEMP, 40);
    const slight = await travelled(SLIGHTLY_ID, ROOM_TEMP, 40);
    expect(dense, 'a gas twice the air, 40 supersteps').toBeLessThan(-60);
    expect(slight, 'a gas a twelfth heavier than the air, 40 supersteps').toBeLessThan(-10);
    expect(slight, 'against the gas twice the air').toBeGreaterThan(dense * 0.8);
  });

  it('M8.8 AC13: smoke leaves the flame rising at the top speed and, within 5 °C of the air, rises less than 45 cells per 100 supersteps', async () => {
    const hot = await travelled(T.SMOKE, 150, 100);
    expect(hot, 'smoke at 150 °C, 100 supersteps').toBeGreaterThan(150);
    // Measured: 197 for the hot smoke (it reaches the ceiling), 25.5 for 5 °C over the air, 0 at the air temperature.
    const warm = await travelled(T.SMOKE, ROOM_TEMP + 5, 100);
    expect(warm, 'smoke 5 °C over the air, 100 supersteps').toBeGreaterThan(0);
    expect(warm, 'smoke 5 °C over the air, 100 supersteps').toBeLessThan(45);
    const cool = await travelled(T.SMOKE, ROOM_TEMP, 100);
    expect(Math.abs(cool), 'smoke at the air temperature, 100 supersteps').toBeLessThan(2);
  });

  it('M8.8 AC13: smoke is weighed against the air at its air cell, so smoke as hot as the air around it stays', async () => {
    const hotAir = await travelled(T.SMOKE, 150, 100, 150);
    expect(Math.abs(hotAir), 'smoke at 150 °C in air at 150 °C, 100 supersteps').toBeLessThan(10);
    expect(densityAt(SMOKE, ROOM_TEMP)).toBeCloseTo(densityAt(EMPTY, ROOM_TEMP), 9);
  });
});
