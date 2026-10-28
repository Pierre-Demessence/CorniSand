import { describe, expect, it } from 'vitest';
import { AIR, windVelocity } from '../src/air';
import { ELEMENT as T } from '../src/elements';
import type { Simulation, SimulationInput } from '../src/simulation';
import { airWords, cell, cellType, createSim, device, idleInput, readCells, run, runMany } from './gpu';

// The Wind tool (M6.6a): a stroke with the tool selected moves the air under the brush along the pointer's movement.

describe('M6 AC20: the stroke to air speed rule', () => {
  it('M6 AC20: is zero for a pointer that did not move and points along the stroke', () => {
    expect(windVelocity({ x: 5, y: 5 }, { x: 5, y: 5 }, 8)).toEqual({ x: 0, y: 0 });
    const right = windVelocity({ x: 0, y: 0 }, { x: 4, y: 0 }, 8);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBe(0);
    const diagonal = windVelocity({ x: 0, y: 0 }, { x: -3, y: 3 }, 8);
    expect(diagonal.x).toBeLessThan(0);
    expect(diagonal.y).toBeGreaterThan(0);
    expect(diagonal.x).toBeCloseTo(-diagonal.y, 6);
  });

  it('M6 AC20: grows with the stroke speed and is capped at AIR.maxSpeed', () => {
    const speeds = [1, 2, 4, 8].map((d) => windVelocity({ x: 0, y: 0 }, { x: d, y: 0 }, 8).x);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i], `stroke ${i}`).toBeGreaterThan(speeds[i - 1]);
    expect(speeds[1] / speeds[0], 'proportional below the cap').toBeCloseTo(2, 6);
    const fast = windVelocity({ x: 0, y: 0 }, { x: 3000, y: 4000 }, 2);
    expect(Math.hypot(fast.x, fast.y)).toBeCloseTo(AIR.maxSpeed, 6);
    expect(fast.x / fast.y, 'the direction survives the cap').toBeCloseTo(0.75, 6);
  });

  it('M6 AC20: depends on the frame length, so a slow-motion frame blows as hard as a fast one', () => {
    const quick = windVelocity({ x: 0, y: 0 }, { x: 4, y: 0 }, 2).x;
    const slow = windVelocity({ x: 0, y: 0 }, { x: 4, y: 0 }, 8).x;
    expect(quick / slow).toBeCloseTo(4, 6);
  });
});

const WIDTH = 128;
const HEIGHT = 96;

const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, extra: Partial<SimulationInput> = {}): SimulationInput => ({
  ...idleInput,
  mouseActive: true,
  wind: true,
  brushSize: 8,
  prevMousePos: from,
  mousePos: to,
  ...extra,
});

// The air cell index of the grid cell (x, y).
const airCell = (sim: Simulation, x: number, y: number): number => Math.floor(y / sim.air.cellSize) * sim.air.columns + Math.floor(x / sim.air.cellSize);

describe.skipIf(!device)('M6 AC20: the Wind tool', () => {
  it('M6 AC20: a stroke dragged rightward blows the air under the brush to the right and leaves the air far from it at rest', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    await run(sim, 1, stroke({ x: 40, y: 48 }, { x: 46, y: 48 }));
    const air = await sim.air.read();
    expect(air.velocityX[airCell(sim, 44, 48)], 'under the brush').toBeGreaterThan(0.05);
    expect(Math.abs(air.velocityY[airCell(sim, 44, 48)]), 'sideways wind has no vertical part there').toBeLessThan(air.velocityX[airCell(sim, 44, 48)]);
    for (const [x, y] of [[100, 48], [44, 90], [44, 4], [4, 48]]) {
      expect(Math.abs(air.velocityX[airCell(sim, x, y)]), `at (${x}, ${y})`).toBeLessThan(0.01);
    }
  });

  it.each([
    ['leftward', { x: 46, y: 48 }, { x: 40, y: 48 }, 'velocityX', -1],
    ['upward', { x: 44, y: 42 }, { x: 44, y: 48 }, 'velocityY', 1],
    ['downward', { x: 44, y: 54 }, { x: 44, y: 48 }, 'velocityY', -1],
  ] as const)('M6 AC20: a stroke dragged %s blows that way', async (_name, from, to, axis, sign) => {
    const sim = createSim(WIDTH, HEIGHT);
    await run(sim, 1, stroke(from, to));
    const air = await sim.air.read();
    expect(air[axis][airCell(sim, 44, 48)] * sign, 'speed along the stroke').toBeGreaterThan(0.05);
  });

  it('M6 AC20: a faster stroke blows harder, up to AIR.maxSpeed and no further', async () => {
    const peaks: number[] = [];
    for (const length of [1, 2, 4, 400]) {
      const sim = createSim(WIDTH, HEIGHT);
      await run(sim, 1, stroke({ x: 20, y: 48 }, { x: 20 + length, y: 48 }, { brushSize: 400 }));
      const air = await sim.air.read();
      peaks.push(Math.max(...air.velocityX.map((v) => Math.abs(v))));
    }
    // Doubling the stroke doubles the air speed while the cap is out of reach; a very long stroke is held at the cap.
    expect(peaks[1]).toBeGreaterThan(peaks[0] * 1.5);
    expect(peaks[2]).toBeGreaterThan(peaks[1] * 1.5);
    for (const peak of peaks) expect(peak).toBeLessThanOrEqual(AIR.maxSpeed);
    expect(peaks[3]).toBeGreaterThan(peaks[2]);
    expect(peaks[3]).toBeGreaterThan(0.4 * AIR.maxSpeed);
  });

  it('M6 AC20: a still pointer blows nothing: every air word and cell stays as it was', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const kind = new Uint32Array(WIDTH * HEIGHT);
    kind[20 * WIDTH + 30] = cell(T.WALL);
    sim.load({ kind });
    const before = airWords(await sim.air.read());
    await run(sim, 1, stroke({ x: 44, y: 48 }, { x: 44, y: 48 }, { brushSize: 400 }));
    expect(airWords(await sim.air.read())).toEqual(before);
    expect(await readCells(sim)).toEqual(kind);
  });

  it('M6 AC20: the stroke paints nothing, whatever element is selected', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    await run(sim, 1, stroke({ x: 40, y: 48 }, { x: 60, y: 48 }, { particleType: T.SAND, replacing: true }));
    expect((await readCells(sim)).every((k) => cellType(k) === T.EMPTY)).toBe(true);
  });

  it('M6 AC20: the right button still erases, and blows nothing', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const kind = new Uint32Array(WIDTH * HEIGHT).fill(cell(T.SAND));
    sim.load({ kind });
    const before = airWords(await sim.air.read());
    await run(sim, 1, stroke({ x: 40, y: 48 }, { x: 60, y: 48 }, { erasing: true }));
    const after = await readCells(sim);
    expect(after[48 * WIDTH + 50], 'erased under the brush').not.toBe(cell(T.SAND));
    expect(cellType(after[48 * WIDTH + 50])).toBe(T.EMPTY);
    expect(airWords(await sim.air.read()).velocityX).toEqual(before.velocityX);
  });

  it('M6 AC20: the face on a wall stays closed while the faces beside it blow', async () => {
    const sim = createSim(WIDTH, HEIGHT);
    const kind = new Uint32Array(WIDTH * HEIGHT);
    // A wall column from the floor to the ceiling, at x = 60.
    for (let y = 0; y < HEIGHT; y++) kind[y * WIDTH + 60] = cell(T.WALL);
    sim.load({ kind });
    // The stroke ends 4 cells short of the wall, whose face (the right face of the air cell over x 56 to 59) it reaches.
    await run(sim, 1, stroke({ x: 40, y: 48 }, { x: 56, y: 48 }));
    const air = await sim.air.read();
    expect(air.velocityX[airCell(sim, 50, 48)], 'in front of the wall').toBeGreaterThan(0.05);
    expect(Math.abs(air.velocityX[airCell(sim, 58, 48)]), 'the face on the wall').toBeLessThan(0.01);
  });

  it('M6 AC20: a stroke dragged rightward through a smoke cloud moves its centroid right by at least the measured distance', async () => {
    const width = 256;
    const height = 160;
    const frames = 8;
    const supersteps = 4;
    const cloud = (): Uint32Array<ArrayBuffer> => {
      const kind = new Uint32Array(width * height);
      for (let y = 20; y < 50; y++) {
        for (let x = 100; x < 160; x++) if ((x * 7 + y * 13 + ((x * y) % 5)) % 4 === 0) kind[y * width + x] = cell(T.SMOKE);
      }
      return kind;
    };
    const centroid = async (sim: Simulation): Promise<number> => {
      const kind = await readCells(sim);
      let sum = 0;
      let seen = 0;
      for (let i = 0; i < kind.length; i++) {
        if (cellType(kind[i]) === T.SMOKE) {
          sum += (i % width) + 0.5;
          seen++;
        }
      }
      return sum / seen;
    };
    const drag = async (blow: boolean, direction: 1 | -1): Promise<number> => {
      const sim = createSim(width, height, 3);
      sim.load({ kind: cloud() });
      const before = await centroid(sim);
      for (let f = 0; f < frames; f++) {
        // The pointer moves 10 cells a frame (a quick drag at 1x), through the cloud at its middle height.
        const x = 130 - direction * 40 + direction * 10 * f;
        const input = blow ? stroke({ x, y: 50 }, { x: x + direction * 10, y: 50 }, { brushSize: 40 }) : idleInput;
        await run(sim, supersteps, input);
      }
      return (await centroid(sim)) - before;
    };
    const still = await drag(false, 1);
    const right = await drag(true, 1);
    const left = await drag(true, -1);
    expect(Math.abs(still), 'smoke left alone does not drift sideways').toBeLessThan(3);
    expect(right - still, 'centroid moved right by').toBeGreaterThan(MEASURED_SMOKE_SHIFT * 0.7);
    expect(left - still, 'centroid moved left by').toBeLessThan(-MEASURED_SMOKE_SHIFT * 0.7);
  });
});

// Measured (27.4 right, 27.4 left, 0.06 with no stroke) with the constants of AIR in M6.6a: the shift of the smoke's centroid in the test above, in cells.
const MEASURED_SMOKE_SHIFT = 27;

describe.skipIf(!device)('M6 AC26: the air after a Wind stroke', () => {
  const width = 512;
  const height = 320;
  // A broad stroke swung left and right through the middle, 10 times 6 frames of 40 cells, so the air under it runs at
  // about the top speed (B12: a region of air at the top speed used to grow without end once the stroke stopped).
  const swing = async (sim: Simulation): Promise<void> => {
    let x = width / 2 - 120;
    let direction = 1;
    for (let s = 0; s < 10; s++) {
      for (let f = 0; f < 6; f++) {
        await run(sim, 4, stroke({ x, y: height / 2 }, { x: x + direction * 40, y: height / 2 }, { brushSize: 60 }));
        x += direction * 40;
      }
      direction = -direction;
    }
  };
  const largest = (values: Float32Array): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it.each([
    [4, false],
    [2, false],
    [4, true],
  ] as const)('M6 AC26: at air cell size %i (sand floor: %s) the air is at rest 800 supersteps after the stroke', async (airCellSize, sand) => {
    const sim = createSim(width, height, 1, { airCellSize });
    if (sand) {
      const kind = new Uint32Array(width * height);
      kind.fill(cell(T.SAND), 0, 16 * width);
      sim.load({ kind });
    }
    await swing(sim);
    const during = await sim.air.read();
    expect(Math.max(largest(during.velocityX), largest(during.velocityY)), 'the stroke drives the air near its top speed').toBeGreaterThan(0.75 * AIR.maxSpeed);
    await runMany(sim, 800);
    const after = await sim.air.read();
    // Friction alone leaves 0.995^1600, 0.03%, of a speed after 800 supersteps, and the open edges only take more.
    expect(Math.max(largest(after.velocityX), largest(after.velocityY)), 'fastest face').toBeLessThan(0.02);
    expect(largest(after.pressure), 'largest |pressure|').toBeLessThan(0.01);
  });
});
