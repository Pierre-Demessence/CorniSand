import { describe, expect, it } from 'vitest';
import { AIR, airShare, type AirCellSize } from '../src/air';
import { emptyCellData, tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementHeatCapacity } from '../src/elements';
import { packHalf2 } from '../src/half';
import { ROOM_TEMP } from '../src/heat';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import { PLUME, plume } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { FRAME_SUPERSTEPS, airWords, cell, cellType, createSim, device, idleInput, mulberry32, readCells, run, runMany, countTypes } from './gpu';
import { heatContent } from './metrics';

// Measured with the constants in `AIR` (the M6.4 results are in the deleted plan, `git log --all -- docs/plans/m6-air.md`; re-measured
// in M8.8d with the air's physical capacity and surface coefficient).
const MEASURED = {
  // Degrees the air just above a 1,000 °C metal block is warmer than the air at the box's side, after 1,200 supersteps.
  aboveWarmer: 364,
  // Heat the air took from the cells of the sealed box in 2,000 supersteps (the box holds about 4.2 million; the air holds
  // 1/33 of what it held in M6).
  airShare: 2_080,
  // Mean upward speed of the air over the plume scene's plate after `PLUME_STEPS`, in cells per dispatch.
  plumeSpeed: 0.055,
};
// A block of metal at 1,000 °C cools to 944 °C in 30,000 supersteps (125 s at 1x): a time constant of about 35 minutes.
const COOLING_STEPS = 30_000;
// Supersteps the plume has had to develop.
const PLUME_STEPS = 960;
// Supersteps the steam in open air has to give its heat to the air (M8.8d: it has reached 96 °C by then; it condensed in
// about 2,800 before the air's capacity was physical).
const STEAM_STEPS = 3600;

// A world of cells at room temperature, edited by rectangles; row y = 0 is the bottom.
class World {
  readonly data;
  private readonly temps;

  constructor(readonly width: number, readonly height: number) {
    this.data = emptyCellData(width * height);
    this.temps = tempView(this.data);
    this.temps.fill(ROOM_TEMP);
  }

  // Fills columns [x0, x1) and rows [y0, y1) with cells of `type` at `temp`.
  fill(type: number, x0: number, x1: number, y0: number, y1: number, temp = ROOM_TEMP): this {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.data.kind[y * this.width + x] = cell(type);
        this.temps[y * this.width + x] = temp;
      }
    }
    return this;
  }

  // Walls along the left, right and bottom edges, 2 cells thick: a box open at the top.
  box(): this {
    return this.fill(T.WALL, 0, 2, 0, this.height).fill(T.WALL, this.width - 2, this.width, 0, this.height).fill(T.WALL, 0, this.width, 0, 2);
  }

  // Walls all around.
  sealed(): this {
    return this.box().fill(T.WALL, 0, this.width, this.height - 2, this.height);
  }
}

async function temps(sim: Simulation): Promise<Float32Array> {
  return tempView({ temp: await sim.fields.read('temp') });
}

// The mean over the cells of `type`.
async function meanTemp(sim: Simulation, type: number): Promise<number> {
  const [kind, temp] = [await readCells(sim), await temps(sim)];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < kind.length; i++) {
    if ((kind[i] & 0xff) !== type) continue;
    sum += temp[i];
    count++;
  }
  return sum / count;
}

// Mean of the air cells [i0, i1) x [j0, j1) of an array of `columns` per row.
function airMean(values: Float32Array, columns: number, i0: number, i1: number, j0: number, j1: number): number {
  let sum = 0;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) sum += values[j * columns + i];
  return sum / ((i1 - i0) * (j1 - j0));
}

describe.skipIf(!device)('M6 ambient heat', () => {
  describe('AC14: a cell that holds heat trades heat with the air', () => {
    const metal = elementByKey(ELEMENTS, 'METAL');
    // The temperature a metal cell at `from` has after one exchange with an air cell at room temperature.
    // `supersteps` folded into one exchange: a pair that trades a share g per superstep trades 1 - (1 - g)^supersteps at once.
    function exchange(from: number, cellSize: number, supersteps = 1): number {
      const c = elementHeatCapacity(metal);
      const capacity = AIR.heatCapacity * cellSize * cellSize;
      const g = airShare(c, cellSize);
      const share = supersteps === 1 ? g : 1 - (1 - g) ** supersteps;
      return from - (share * (from - ROOM_TEMP) / (c + capacity)) * capacity;
    }

    it('M6 AC14: a metal cell and its air cell meet at the harmonic mean of their conductivities, never past the mean of the two', async () => {
      const world = new World(4, 4).fill(T.METAL, 1, 2, 1, 2, 500);
      const sim = createSim(4, 4);
      sim.load(world.data);

      await runMany(sim, 1);

      const expected = exchange(500, 4);
      const metalNow = (await temps(sim))[1 * 4 + 1];
      expect(metalNow, 'the metal cell').toBeCloseTo(expected, 3);
      // The mean the two would settle at, weighted by their capacities: one exchange stops short of it.
      const mean = (500 * elementHeatCapacity(metal) + ROOM_TEMP * AIR.heatCapacity * 16) / (elementHeatCapacity(metal) + AIR.heatCapacity * 16);
      expect(metalNow, 'one exchange stops short of the mean').toBeGreaterThan(mean);
      // The air passes that follow spread what the air took across its faces, so only its warming is checked here.
      expect((await sim.air.read()).temperature[0], 'the air cell is warmer').toBeGreaterThan(ROOM_TEMP + 1);
    });

    it('M6 AC14: a call of several supersteps trades the heat of all of them at once, a share of 1 - (1 - g)^steps of the difference', async () => {
      const supersteps = 4;
      const world = new World(4, 4).fill(T.METAL, 1, 2, 1, 2, 500);
      const sim = createSim(4, 4);
      sim.load(world.data);

      await run(sim, supersteps);

      const folded = exchange(500, 4, supersteps);
      expect((await temps(sim))[1 * 4 + 1], 'the metal cell').toBeCloseTo(folded, 3);
      expect(folded, 'more than one step would take').toBeLessThan(exchange(500, 4));
    });

    it('M6 AC14: a solid trades heat with the air cell of its first open neighbor, a solid with none trades none', async () => {
      // Two air cells side by side (columns 0 to 3 and 4 to 7). The metal cell at (3, 1) has walls above, left and below
      // and open space to its right, which belongs to the second air cell.
      const world = new World(8, 4).fill(T.METAL, 3, 4, 1, 2, 500).fill(T.WALL, 3, 4, 2, 3).fill(T.WALL, 2, 3, 1, 2).fill(T.WALL, 3, 4, 0, 1);
      const sim = createSim(8, 4);
      sim.load(world.data);
      await runMany(sim, 1);

      const expected = exchange(500, 4);
      expect((await temps(sim))[1 * 8 + 3], 'the metal cell').toBeCloseTo(expected, 3);
      const air = await sim.air.read();
      expect(air.temperature[0], 'the air cell the cell is in, closed off by the walls').toBe(ROOM_TEMP);
      expect(air.temperature[1], 'the air cell of its open neighbor').toBeGreaterThan(ROOM_TEMP + 1);

      // Shut in by walls on all four sides: no air cell.
      const shut = new World(4, 4).fill(T.METAL, 1, 2, 1, 2, 500).fill(T.WALL, 1, 2, 2, 3).fill(T.WALL, 0, 1, 1, 2).fill(T.WALL, 2, 3, 1, 2).fill(T.WALL, 1, 2, 0, 1);
      const sealed = createSim(4, 4);
      sealed.load(shut.data);
      await runMany(sealed, 3);
      expect((await temps(sealed))[1 * 4 + 1], 'the shut-in metal cell').toBe(500);
      const rest = await sealed.air.read();
      expect(rest.temperature.every((t) => t === ROOM_TEMP), 'the air stays at room temperature').toBe(true);
    });

    // A 16x16 block of metal at 1,000 °C in a box open at the top, aligned with the air cells or not (the block's
    // surface cuts the air cells differently).
    it.each([0, 2])('M6 AC14: a 16x16 metal block at 1,000 °C cools slowly in air, and the air above it is warmer than beside it (offset %i)', async (offset) => {
      const world = new World(96, 128).box().fill(T.METAL, 40 + offset, 56 + offset, 2 + offset, 18 + offset, 1000);
      const sim = createSim(96, 128, 1);
      sim.load(world.data);

      await runMany(sim, 1200, FRAME_SUPERSTEPS);
      const early = await sim.air.read();
      const { columns } = sim.air;
      // Over the block's middle, just above it, and the same height at the box's side.
      const top = Math.floor((18 + offset) / 4) + 1;
      const above = airMean(early.temperature, columns, 11, 13, top, top + 2);
      const beside = airMean(early.temperature, columns, 4, 6, top, top + 2);
      expect(above - beside, 'degrees the air above is warmer than the air beside').toBeGreaterThan(MEASURED.aboveWarmer * 0.7);
      expect(await meanTemp(sim, T.METAL), 'the block has cooled, but not at once').toBeGreaterThan(980);

      await runMany(sim, COOLING_STEPS - 1200, FRAME_SUPERSTEPS);
      expect(await meanTemp(sim, T.METAL), `block mean after ${COOLING_STEPS} supersteps`).toBeLessThan(960);
    }, 120_000);
  });

  describe('M8.8 AC7: cooling in still air', () => {
    // A steel block 50 cells (68 mm) wide at 500 °C hangs in a large box of room-temperature air. Its surface coefficient
    // is read from the cooling of its mean temperature in the lumped form: T - T_air falls as exp(-h P t / (C A)) with P
    // the perimeter of cells that touch the air (4 x 50 - 4, a corner cell touches it once), A the area and C the capacity.
    it('M8.8 AC7: a steel block 50 cells wide at 500 °C cools with an effective surface coefficient within a factor of 2 of still-air natural convection (10 W/m²·K)', async () => {
      const [width, height, side, supersteps] = [160, 160, 50, 9000];
      const world = new World(width, height).fill(T.METAL, 55, 55 + side, 55, 55 + side, 500);
      const sim = createSim(width, height, 1);
      sim.load(world.data);

      await runMany(sim, supersteps, FRAME_SUPERSTEPS);

      const mean = await meanTemp(sim, T.METAL);
      const capacity = elementHeatCapacity(elementByKey(ELEMENTS, 'METAL')) * HEAT_UNIT;
      const heatPerKelvin = capacity * side * side * CELL_SIZE ** 2;
      const perimeter = (4 * side - 4) * CELL_SIZE;
      const h = (-Math.log((mean - ROOM_TEMP) / (500 - ROOM_TEMP)) * heatPerKelvin) / (perimeter * supersteps * PAIR_TIME);
      // Measured: 9.2 W/m²·K (mean 497.3 °C after 9,000 supersteps, 37.5 s).
      expect(h, `effective surface coefficient, W/m²·K (mean ${mean} °C)`).toBeGreaterThan(5);
      expect(h, `effective surface coefficient, W/m²·K (mean ${mean} °C)`).toBeLessThan(20);
    }, 120_000);

    it('M8.8 AC7: the air has the heat capacity of air, 1.2 kJ/m³·K per cell', () => {
      expect(AIR.heatCapacity * HEAT_UNIT).toBeCloseTo(1200, 6);
    });
  });

  describe('AC15: the total heat', () => {
    it('M6 AC15: a sealed wall box across all thresholds keeps the total heat of its cells, flyers and air, latent heat included, over 2,000 supersteps', async () => {
      const width = 52;
      const height = 44;
      // The boiling water of a sealed box raises the pressure for good, so the stone of this box is crushed into sand: the
      // crush keeps the heat, which this test counts on the real table.
      const sim = createSim(width, height, 15);
      // The scene's seed is one whose box crushes some stone with the water convecting: the crush is marginal (a handful of
      // the stone cells turn to sand), and of seeds 1 to 8, seeds 2, 5 and 8 do it, 8 the most.
      const next = mulberry32(8);
      const rand = (): number => next() / 2 ** 32;
      // Start temperatures straddle each element's thresholds (and the latent ends beyond them), so phases change both ways.
      // The water reaches 1,500 °C so that enough of it flashes into steam at once: at the physical heat speed the rest boils
      // too slowly for the pressure to build up to the stone's crush pressure (M8.8d; with 300 °C, no stone was crushed).
      const range: [number, number, number][] = [
        [T.ICE, -100, 300], [T.WATER, -100, 1500], [T.STEAM, -150, 300], [T.STONE, 800, 1500],
        [T.LAVA, 900, 1500], [T.METAL, 1300, 1900], [T.MOLTEN_METAL, 1200, 1900], [T.EMPTY, 0, 0],
      ];
      const world = new World(width, height).sealed();
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const [type, low, high] = range[Math.floor(rand() * range.length)];
          world.fill(type, x, x + 1, y, y + 1, type === T.EMPTY ? ROOM_TEMP : low + rand() * (high - low));
        }
      }
      sim.load(world.data);
      const measure = async (): Promise<{ heat: number; cells: number; types: Map<number, number> }> => {
        const grid = { kind: await readCells(sim), temp: await sim.fields.read('temp') };
        const flyers = await sim.flyers.read();
        return {
          heat: heatContent(ELEMENTS, grid, flyers, { data: await sim.air.read(), cellSize: sim.air.cellSize }),
          cells: heatContent(ELEMENTS, grid, flyers),
          types: countTypes(grid.kind),
        };
      };
      const before = await measure();

      for (let i = 1; i <= 4; i++) {
        await runMany(sim, 500);
        const now = await measure();
        expect(Math.abs(now.heat - before.heat) / Math.abs(before.heat), `heat after ${i * 500} supersteps, ${before.heat} at the start`).toBeLessThan(1e-4);
      }
      const after = await measure();
      // The air took part: the cells alone no longer hold the total.
      expect(Math.abs(after.cells - before.cells), 'heat that went into the air').toBeGreaterThan(MEASURED.airShare * 0.5);
      expect(after.types.get(T.SAND) ?? 0, 'sand: the pressure of the boiling water crushed stone').toBeGreaterThan(0);
      for (const [type, name] of [[T.METAL, 'metal'], [T.STEAM, 'steam']] as const) {
        expect(after.types.get(type)!, name).toBeGreaterThan(before.types.get(type)!);
      }
      for (const [type, name] of [[T.LAVA, 'lava'], [T.MOLTEN_METAL, 'molten metal'], [T.ICE, 'ice']] as const) {
        expect(after.types.get(type) ?? 0, name).toBeLessThan(before.types.get(type)!);
      }
    }, 120_000);
  });

  describe('AC16: the plume', () => {
    // The plume scene with its plate at `plateTemp`, run for `steps` supersteps; the air over the plate.
    async function overPlate(plateTemp: number, steps: number): Promise<{ speed: number; warmth: number; sim: Simulation }> {
      const scene = plume();
      const { plate, width } = PLUME;
      const temp = tempView(scene.fields);
      for (let y = plate.y0; y < plate.y1; y++) for (let x = plate.x0; x < plate.x1; x++) temp[y * width + x] = plateTemp;
      const sim = createSim(scene.width, scene.height, 3);
      sim.load(scene.fields);
      await runMany(sim, steps);
      const air = await sim.air.read();
      const { columns, cellSize } = sim.air;
      // The air cells over the plate's middle half, from 12 to 60 cells above it.
      const [i0, i1] = [Math.floor((plate.x0 + 16) / cellSize), Math.floor((plate.x1 - 16) / cellSize)];
      const [j0, j1] = [Math.floor((plate.y1 + 12) / cellSize), Math.floor((plate.y1 + 60) / cellSize)];
      return {
        speed: airMean(air.velocityY, columns, i0, i1, j0, j1),
        warmth: airMean(air.temperature, columns, i0, i1, j0, j1) - ROOM_TEMP,
        sim,
      };
    }

    it('M6 AC16: a metal plate at 1,000 °C on the floor of a tall box open at the top drives a rising plume', async () => {
      const { speed, warmth } = await overPlate(PLUME.plate.temp, PLUME_STEPS);
      expect(speed, 'mean upward air speed over the plate, cells per dispatch').toBeGreaterThan(MEASURED.plumeSpeed * 0.7);
      expect(warmth, 'degrees the air over the plate is above room temperature').toBeGreaterThanOrEqual(50);
    }, 60_000);

    it('M6 AC16: with the plate at room temperature the air stays at rest, every word unchanged', async () => {
      const { sim } = await overPlate(ROOM_TEMP, PLUME_STEPS);
      const rest = createSim(PLUME.width, PLUME.height);
      expect(airWords(await sim.air.read())).toEqual(airWords(await rest.air.read()));
    }, 60_000);
  });

  describe('AC17: steam in open air', () => {
    // 64 cells of steam at 110 °C in a box open at the top: how many cells of each element are left after `steps`
    // supersteps, and the mean stored temperature of the steam.
    async function release(options: { air: boolean }, steps: number): Promise<{ counts: Map<number, number>; steam: number }> {
      const world = new World(128, 192).box().fill(T.STEAM, 60, 68, 20, 28, 110);
      const sim = createSim(128, 192, 1, options);
      sim.load(world.data);
      await runMany(sim, steps, FRAME_SUPERSTEPS);
      return { counts: countTypes(await readCells(sim)), steam: await meanTemp(sim, T.STEAM) };
    }

    // M8.8d: a steam cell holds the latent heat of a cell of water, 2,257 MJ/m³, and air holds 0.0012 MJ/m³·K: warming a
    // cell's worth of air from 20 to 100 °C takes it 23,500 cells of air, so 64 cells of steam in a box of 24,576 cells
    // (the world's open edge aside) condense only as the air is replaced, which is far slower than the test runs.
    it('M8.8 AC8: steam released into open air at room temperature gives its heat to the air down to its condensing point within the measured number of supersteps', async () => {
      const { counts, steam } = await release({ air: true }, STEAM_STEPS);
      expect(counts.get(T.STEAM), 'steam left').toBe(64);
      expect(steam, 'mean stored temperature of the steam, measured 96.3').toBeLessThan(100);
    }, 60_000);

    it('M6 AC17: without the air the same steam stays steam, at its temperature', async () => {
      const { counts, steam } = await release({ air: false }, STEAM_STEPS);
      expect(counts.get(T.STEAM), 'steam').toBe(64);
      expect(steam, 'mean stored temperature of the steam').toBe(110);
    }, 60_000);
  });

  // The M6.6 gate: lava poured from high set in mid-fall and hung there as a stone ledge that held up the stream, and a
  // pile of lava crusted within seconds. Measured before the fix (seed 3): no lava reached the floor and 472 stone cells
  // hung above row 40 after 3 s of pouring; the pile was 9.5% stone after 5 s and 45% after 20 s at air cell size 4.
  describe('AC28: lava in open air', () => {
    // Fills a disc of lava with the brush every frame, as a player holding the button does, for `frames` frames at 1x.
    async function pour(sim: Simulation, at: { x: number; y: number }, brushSize: number, frames: number): Promise<void> {
      const stroke = { ...idleInput, mouseActive: true, brushSize, particleType: T.LAVA, mousePos: at, prevMousePos: at };
      for (let frame = 0; frame < frames; frame++) await run(sim, FRAME_SUPERSTEPS, stroke);
    }

    // The exchange runs before the CA, with the velocity the cell starts the frame with; nothing else in a superstep changes
    // the temperature of a lone lava cell at 1,250 °C (no neighbor, no threshold crossed).
    it.each([[0.3, false], [0.2, true]] as const)('M6 AC28: a lava cell falling at %f cells per dispatch trades heat with the air: %s', async (speed, trades) => {
      const world = new World(16, 16).fill(T.LAVA, 8, 9, 10, 11, 1250);
      world.data.velocity[10 * 16 + 8] = packHalf2(0, -speed);
      const sim = createSim(16, 16);
      sim.load(world.data);
      await run(sim, 1);
      const kinds = await readCells(sim);
      const at = kinds.findIndex((c) => cellType(c) === T.LAVA);
      const temp = (await temps(sim))[at];
      if (trades) expect(temp, 'the lava cell has warmed its air').toBeLessThan(1249.99);
      else expect(temp, 'the lava cell kept its heat').toBe(1250);
    });

    // Measured: 558 (size 4) and 562 (size 2) lava cells within 10 rows of the floor, and 0 stone cells above row 40.
    it.each([4, 2] as AirCellSize[])('M6 AC28: lava poured from 380 cells up reaches the floor molten and hangs no stone in the air (air cell size %i)', async (airCellSize) => {
      const [width, height] = [160, 400];
      const sim = createSim(width, height, 3, { airCellSize });
      await pour(sim, { x: 80, y: 380 }, 5, 180);
      const cells = await readCells(sim);
      let low = 0;
      let hanging = 0;
      for (let k = 0; k < cells.length; k++) {
        const y = Math.floor(k / width);
        if (cellType(cells[k]) === T.LAVA && y < 10) low++;
        if (cellType(cells[k]) === T.STONE && y >= 40) hanging++;
      }
      expect(low, 'lava within 10 rows of the floor').toBeGreaterThan(400);
      expect(hanging, 'stone above row 40').toBeLessThanOrEqual(20);
    }, 60_000);

    // Measured: no stone after 5 s or 20 s (before M8.8d: 4.1% and 23.8%).
    it('M6 AC28: a pile of lava on the floor sets slowly: under a third of it is stone after 20 s at 1x', async () => {
      const sim = createSim(160, 160, 3);
      await pour(sim, { x: 80, y: 30 }, 30, 60);
      const stoneShare = async (): Promise<number> => {
        const counts = countTypes(await readCells(sim));
        const stone = counts.get(T.STONE) ?? 0;
        return stone / (stone + (counts.get(T.LAVA) ?? 0));
      };
      await runMany(sim, 240 * 4, FRAME_SUPERSTEPS);
      expect(await stoneShare(), 'stone after 5 s').toBeLessThan(0.055);
      await runMany(sim, 240 * 15, FRAME_SUPERSTEPS);
      expect(await stoneShare(), 'stone after 20 s').toBeLessThan(0.31);
    }, 120_000);
  });
});
