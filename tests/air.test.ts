import { describe, expect, it } from 'vitest';
import { AIR, AIR_CELL_SIZES, type AirCellSize } from '../src/air';
import type { AirData } from '../src/air-grid';
import { CELL_FIELDS } from '../src/cell-fields';
import { ELEMENT as T } from '../src/elements';
import { ROOM_TEMP } from '../src/heat';
import { SCENES } from '../src/scenes';
import type { PassTimer } from '../src/passes';
import type { Simulation } from '../src/simulation';
import { gaussian, peakAt } from './air-pulse';
import { airWords, cell, createSim, device, idleInput, loadScene, mulberry32, readCells, run, runMany } from './gpu';

// Dispatches (CA passes) in a superstep: the air constants are per dispatch.
const DISPATCHES = 2;

const SIZES: readonly AirCellSize[] = [2, 4];

function expectAirBitIdentical(a: AirData, b: AirData): void {
  const [wordsA, wordsB] = [airWords(a), airWords(b)];
  for (const name of ['pressure', 'velocityX', 'velocityY', 'temperature'] as const) {
    expect(wordsB[name], `air ${name}`).toEqual(wordsA[name]);
  }
}

// The labels of the compute passes a simulate call records.
function recordedPasses(sim: Simulation, supersteps: number): string[] {
  const labels: string[] = [];
  const timer: PassTimer = {
    perPass: true,
    stamp: (label) => {
      labels.push(label);
      // No timestamp query is needed: only the labels count.
      return undefined as unknown as GPUComputePassTimestampWrites;
    },
  };
  const encoder = device!.createCommandEncoder();
  sim.simulate(encoder, supersteps, idleInput, timer);
  encoder.finish();
  return labels;
}

describe.skipIf(!device)('M6 air', () => {
  describe('AC2: the state', () => {
    it.each(AIR_CELL_SIZES)('M6 AC2: at size %i it has a cell per s x s grid cells, at rest', async (size) => {
      // Not a multiple of any size: the last air cells hang over the edge.
      const sim = createSim(101, 67, 1, { airCellSize: size });
      const { columns, rows } = sim.air;
      expect(columns).toBe(Math.ceil(101 / size));
      expect(rows).toBe(Math.ceil(67 / size));

      const air = await sim.air.read();
      expect(air.pressure).toHaveLength(columns * rows);
      expect(air.pressure.every((p) => p === 0), 'pressure').toBe(true);
      expect(air.velocityX.every((v) => v === 0), 'velocity x').toBe(true);
      expect(air.velocityY.every((v) => v === 0), 'velocity y').toBe(true);
      expect(air.temperature.every((t) => t === ROOM_TEMP), 'temperature').toBe(true);
    });

    it('M6 AC2: the default size is 4', () => {
      const sim = createSim(64, 64);
      expect(sim.air.enabled).toBe(true);
      expect(sim.air.cellSize).toBe(4);
    });

    it('M6 AC2: load and clear return the air to rest; air.load sets what it is given', async () => {
      const sim = createSim(64, 48, 1, { airCellSize: 4 });
      const { columns, rows } = sim.air;
      const n = columns * rows;
      sim.air.load({
        pressure: new Float32Array(n).fill(3),
        velocityX: new Float32Array(n).fill(0.5),
        velocityY: new Float32Array(n).fill(-0.25),
        temperature: new Float32Array(n).fill(300),
      });
      const set = await sim.air.read();
      expect(set.pressure.every((p) => p === 3)).toBe(true);
      expect(set.velocityX.every((v) => v === 0.5)).toBe(true);
      expect(set.velocityY.every((v) => v === -0.25)).toBe(true);
      expect(set.temperature.every((t) => t === 300)).toBe(true);

      // A given array is set and the others are at rest.
      sim.air.load({ pressure: new Float32Array(n).fill(1) });
      const partial = await sim.air.read();
      expect(partial.pressure.every((p) => p === 1)).toBe(true);
      expect(partial.temperature.every((t) => t === ROOM_TEMP)).toBe(true);
      expect(() => sim.air.load({ pressure: new Float32Array(n - 1) })).toThrow(RangeError);

      const atRest = async (): Promise<void> => {
        const air = await sim.air.read();
        expect(air.pressure.every((p) => p === 0), 'pressure').toBe(true);
        expect(air.velocityX.every((v) => v === 0), 'velocity x').toBe(true);
        expect(air.velocityY.every((v) => v === 0), 'velocity y').toBe(true);
        expect(air.temperature.every((t) => t === ROOM_TEMP), 'temperature').toBe(true);
      };
      sim.air.clear();
      await atRest();

      sim.air.load({ pressure: new Float32Array(n).fill(2), temperature: new Float32Array(n).fill(80) });
      sim.load({ kind: new Uint32Array(64 * 48) });
      await atRest();

      sim.air.load({ pressure: new Float32Array(n).fill(2), temperature: new Float32Array(n).fill(80) });
      sim.clear();
      await atRest();
    });

    it('M6 AC2: with air: false it records no air pass, allocates no air and has nothing to read', async () => {
      const on = createSim(32, 32, 1);
      const off = createSim(32, 32, 1, { air: false });
      expect(off.air.enabled).toBe(false);
      expect(recordedPasses(on, 2).filter((label) => label.startsWith('air')), 'passes with air').toContain('air mask');
      expect(recordedPasses(off, 2).filter((label) => label.startsWith('air')), 'passes without air').toEqual([]);
      await expect(off.air.read()).rejects.toThrow();
      // load, clear and the superstep still work.
      off.air.load({ pressure: new Float32Array(8 * 8) });
      off.clear();
      await run(off, 2);
    });

    it('M6 AC2: rejects an air cell size other than 1, 2, 4 and 8', () => {
      expect(() => createSim(32, 32, 1, { airCellSize: 3 as AirCellSize })).toThrow(RangeError);
    });
  });

  describe('AC3: a pulse spreads as a ring', () => {
    // A Gaussian pulse in the middle of an open grid: where its pressure peaks along the four axes after FIRST and
    // after LAST supersteps. The grid is large enough for the wave not to reach the edge.
    const SIZE = 512;
    const SIGMA = 12;
    const FIRST = 15;
    const LAST = 60;

    it.each(SIZES)('M6 AC3: at size %i the ring grows at AIR.waveSpeed, the same in all four directions', async (size) => {
      const sim = createSim(SIZE, SIZE, 1, { airCellSize: size });
      const { columns, rows } = sim.air;
      const i0 = columns / 2;
      const j0 = rows / 2;
      sim.air.load({ pressure: gaussian(sim, i0, j0, SIGMA) });

      // The radii of the pressure peak along +x, -x, +y, -y, in grid cells.
      const radii = async (): Promise<number[]> => {
        const { pressure } = await sim.air.read();
        const lines = [
          Array.from({ length: columns - i0 }, (_, k) => pressure[j0 * columns + i0 + k]),
          Array.from({ length: i0 + 1 }, (_, k) => pressure[j0 * columns + i0 - k]),
          Array.from({ length: rows - j0 }, (_, k) => pressure[(j0 + k) * columns + i0]),
          Array.from({ length: j0 + 1 }, (_, k) => pressure[(j0 - k) * columns + i0]),
        ];
        // Not the middle: only the ring.
        return lines.map((line) => peakAt(line, Math.ceil(8 / size)) * size);
      };

      await runMany(sim, FIRST);
      const early = await radii();
      await runMany(sim, LAST - FIRST);
      const late = await radii();

      const speeds = late.map((r, k) => (r - early[k]) / ((LAST - FIRST) * DISPATCHES));
      for (const speed of speeds) {
        expect(speed / AIR.waveSpeed, 'ring speed over AIR.waveSpeed').toBeGreaterThan(0.85);
        expect(speed / AIR.waveSpeed, 'ring speed over AIR.waveSpeed').toBeLessThan(1.15);
      }
      expect(Math.max(...late) - Math.min(...late), 'radius spread between directions, in grid cells').toBeLessThanOrEqual(size);
    });
  });

  describe('AC4: a pulse leaves through an open edge', () => {
    // The same pulse in a small grid and in one so large that its wave does not reach the edge in time: the difference
    // between the two is the echo of the small grid's edge.
    const SMALL = 128;
    const LARGE = 512;
    const SIGMA = 12;
    const STEPS = 120;
    const DRAINED = 100;
    // The echo is what comes back at least this far (in grid cells) from the edge: nearer, the wave is still leaving
    // and the difference to the free wave is the edge itself.
    const EDGE_BAND = 24;

    // Runs `sim` one superstep at a time for STEPS supersteps; returns the pressure of every air cell after each.
    async function pressures(sim: Simulation): Promise<Float32Array[]> {
      const frames: Float32Array[] = [];
      for (let t = 0; t < STEPS; t++) {
        await run(sim, 1);
        frames.push((await sim.air.read()).pressure);
      }
      return frames;
    }

    // The small grid's pressures over time (with a wall along its edge when `sealed`), the echo: the largest
    // difference to the large grid's away from the edge band, and the incident peak: the largest |pressure| of the
    // large grid within the small grid's outermost ring of air cells.
    async function echo(size: AirCellSize, sealed: boolean): Promise<{ small: Float32Array[]; echo: number; incident: number; start: number }> {
      const large = createSim(LARGE, LARGE, 1, { airCellSize: size });
      const small = createSim(SMALL, SMALL, 1, { airCellSize: size });
      const pad = (LARGE - SMALL) / 2 / size;
      large.air.load({ pressure: gaussian(large, large.air.columns / 2, large.air.rows / 2, SIGMA) });
      const start = gaussian(small, small.air.columns / 2, small.air.rows / 2, SIGMA);
      small.air.load({ pressure: start });
      if (sealed) {
        // A wall along the whole edge.
        const kind = new Uint32Array(SMALL * SMALL);
        for (let k = 0; k < SMALL; k++) {
          for (const [x, y] of [[k, 0], [k, SMALL - 1], [0, k], [SMALL - 1, k]]) kind[y * SMALL + x] = cell(T.WALL);
        }
        loadScene(small, kind);
        small.air.load({ pressure: start });
      }
      const [inSmall, inLarge] = [await pressures(small), await pressures(large)];

      let worst = 0;
      let incident = 0;
      const { columns, rows } = small.air;
      for (let t = 0; t < STEPS; t++) {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < columns; i++) {
            const ideal = inLarge[t][(j + pad) * large.air.columns + i + pad];
            const toEdge = Math.min(i, j, columns - 1 - i, rows - 1 - j) * size + size / 2;
            if (toEdge >= EDGE_BAND) worst = Math.max(worst, Math.abs(inSmall[t][j * columns + i] - ideal));
            if (toEdge < size) incident = Math.max(incident, Math.abs(ideal));
          }
        }
      }
      return { small: inSmall, echo: worst, incident, start: start.reduce((sum, p) => sum + Math.abs(p), 0) };
    }

    it.each(SIZES)('M6 AC4: at size %i the echo of an open edge is under 30% of what arrived, and the pressure drains', async (size) => {
      const { small, echo: worst, incident, start } = await echo(size, false);
      const totals = small.map((frame) => frame.reduce((sum, p) => sum + Math.abs(p), 0) / start);
      expect(incident, 'the wave arrived').toBeGreaterThan(0.05);
      expect(worst / incident, 'echo over incident peak').toBeLessThan(0.3);
      // Measured: under 5% after 63 supersteps at size 2 and 65 at size 4.
      expect(totals[DRAINED - 1], `total absolute pressure after ${DRAINED} supersteps, over the start`).toBeLessThan(0.05);
    });

    it.each(SIZES)('M6 AC4 control: at size %i a wall along the edge reflects the pulse', async (size) => {
      const { echo: worst, incident } = await echo(size, true);
      expect(worst / incident, 'echo over incident peak').toBeGreaterThan(0.5);
    });
  });

  describe('AC5: a wall of one cell stops the air', () => {
    const SIZE = 128;
    const SIGMA = 10;
    const STEPS = 90;
    const MID = 64;

    // A wall across the whole grid in four orientations. `distance` is the signed distance in grid cells from a cell to
    // the wall (positive on the far side, 0 on the wall); `along` is the position along the wall; `pulse` is the
    // center of the pulse, at least 4 sigma from the wall, on the near side; `foot` is where along the wall the
    // pulse is closest to it.
    const ORIENTATIONS = [
      { name: 'vertical', distance: (x: number, _y: number, o: number) => x - (MID + o), along: (_x: number, y: number) => y, pulse: [24, MID], foot: MID },
      { name: 'horizontal', distance: (_x: number, y: number, o: number) => y - (MID + o), along: (x: number) => x, pulse: [MID, 24], foot: MID },
      { name: 'diagonal', distance: (x: number, y: number, o: number) => (y - x - o) / Math.SQRT2, along: (x: number) => x, pulse: [90, 30], foot: 60 },
      { name: 'anti-diagonal', distance: (x: number, y: number, o: number) => (x + y - (SIZE - 1 - o)) / Math.SQRT2, along: (x: number) => x, pulse: [30, 30], foot: 64 },
    ];

    // The largest |pressure| the far side of the wall (air cells wholly beyond it) sees over STEPS supersteps, and the
    // largest on the near side within three air cells of the wall.
    async function throughWall(orientation: (typeof ORIENTATIONS)[number], size: AirCellSize, offset: number, gap: boolean): Promise<{ far: number; near: number }> {
      const sim = createSim(SIZE, SIZE, 1, { airCellSize: size });
      const kind = new Uint32Array(SIZE * SIZE);
      const [lo, hi] = [orientation.foot - 2 * size, orientation.foot + size];
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const along = orientation.along(x, y);
          if (orientation.distance(x, y, offset) === 0 && !(gap && along >= lo && along < hi)) kind[y * SIZE + x] = cell(T.WALL);
        }
      }
      loadScene(sim, kind);
      const { columns, rows } = sim.air;
      const [px, py] = orientation.pulse;
      sim.air.load({ pressure: gaussian(sim, Math.floor(px / size), Math.floor(py / size), SIGMA) });

      const far: number[] = [];
      const near: number[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
          const [x0, y0, x1, y1] = [i * size, j * size, i * size + size - 1, j * size + size - 1];
          const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => orientation.distance(x, y, offset));
          if (Math.min(...corners) > 0) far.push(j * columns + i);
          const center = orientation.distance(x0 + size / 2, y0 + size / 2, offset);
          if (Math.max(...corners) < 0 && center > -3 * size) near.push(j * columns + i);
        }
      }
      let [farMax, nearMax] = [0, 0];
      for (let t = 0; t < STEPS; t++) {
        await run(sim, 1);
        const { pressure } = await sim.air.read();
        for (const k of far) farMax = Math.max(farMax, Math.abs(pressure[k]));
        for (const k of near) nearMax = Math.max(nearMax, Math.abs(pressure[k]));
      }
      return { far: farMax, near: nearMax };
    }

    for (const orientation of ORIENTATIONS) {
      for (const size of SIZES) {
        for (const offset of [0, 1, 2, 3]) {
          it(`M6 AC5: at size ${size} a ${orientation.name} wall (offset ${offset}) keeps the far side at rest`, async () => {
            const { far, near } = await throughWall(orientation, size, offset, false);
            expect(near, 'the pulse reached the wall: largest |pressure| beside it').toBeGreaterThan(0.05);
            expect(far, 'largest |pressure| beyond the wall, over the pulse peak of 1').toBeLessThan(0.01);
          });
        }
        it(`M6 AC5 control: at size ${size} air passes a gap of 3 air cells in the ${orientation.name} wall`, async () => {
          const { far } = await throughWall(orientation, size, 0, true);
          expect(far, 'largest |pressure| beyond the wall, over the pulse peak of 1').toBeGreaterThan(0.05);
        });
      }
    }
  });

  describe('AC6: rest and determinism', () => {
    it.each(AIR_CELL_SIZES)('M6 AC6: at size %i air at rest and unheated keeps every word while matter moves', async (size) => {
      const width = 101;
      const height = 67;
      const rand = mulberry32(31);
      const kinds = [T.EMPTY, T.EMPTY, T.SAND, T.WATER, T.OIL, T.SMOKE, T.WALL];
      const kind = new Uint32Array(width * height);
      for (let i = 0; i < kind.length; i++) kind[i] = cell(kinds[rand() % kinds.length], rand() & 0xff);
      const sim = createSim(width, height, 8, { airCellSize: size });
      // Every cell at room temperature: smoke is painted hot, and hot cells would warm the air.
      const temp = new Uint32Array(kind.length);
      new Float32Array(temp.buffer).fill(ROOM_TEMP);
      sim.load({ kind, temp });
      const before = await sim.air.read();

      await runMany(sim, 60);

      expect(await readCells(sim), 'the matter moved').not.toEqual(kind);
      expectAirBitIdentical(before, await sim.air.read());
    });

    it.each(SIZES)('M6 AC6: at size %i two runs of a scene with air in motion are bit-identical in every cell field, flyer and air word', async (size) => {
      const scene = SCENES.blast();
      const snapshot = async (): Promise<{ fields: Record<string, Uint32Array>; flyers: Uint32Array; launched: number; air: AirData }> => {
        const sim = createSim(scene.width, scene.height, 5, { airCellSize: size });
        sim.load(scene.fields);
        const n = sim.air.columns * sim.air.rows;
        // The same random air each time.
        const rand = mulberry32(5);
        const field = (scale: number, offset: number): Float32Array => Float32Array.from({ length: n }, () => offset + (scale * rand()) / 2 ** 32);
        sim.air.load({
          pressure: field(2, -1),
          velocityX: field(0.6, -0.3),
          velocityY: field(0.6, -0.3),
          temperature: field(300, ROOM_TEMP),
        });
        await runMany(sim, 40);
        const fields: Record<string, Uint32Array> = {};
        for (const { name } of CELL_FIELDS) fields[name] = await sim.fields.read(name);
        return { fields, flyers: await sim.flyers.snapshot(), launched: (await sim.flyers.readStats()).launched, air: await sim.air.read() };
      };
      const a = await snapshot();
      const b = await snapshot();

      // The air acts on the cells now, so how many flyers are still in the air at the end varies: count the launches.
      expect(a.launched, 'cells flew').toBeGreaterThan(8);
      expect(b.flyers).toEqual(a.flyers);
      for (const name of Object.keys(a.fields)) expect(b.fields[name], name).toEqual(a.fields[name]);
      expectAirBitIdentical(a.air, b.air);
    });
  });
});
