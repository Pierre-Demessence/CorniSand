import { describe } from 'vitest';
import { CELL_FIELDS, emptyCellData } from '../src/cell-fields';
import { DEFAULT_DRAG, ELEMENT as T, ELEMENTS, elementByKey, type ElementDef } from '../src/elements';
import { packCell, WALL } from '../src/scene-canvas';
import { HOURGLASS, freeFall, hourglass, hourglassLayout, viscousSpread } from '../src/scenarios';
import { cellType, createSim, device, runMany } from './gpu';
import { columnTops, pileAngle } from './metrics';
import { control, scenario } from './scenario';

// The flow scenarios of M8.9 (`docs/plans/m8.9-real-world-scenarios.md`, AC10 to AC12): sand through an outlet, a thick
// liquid spreading, a grain falling. Each target is a calculation from the physical data cited beside it.

// A superstep is 1/240 s of game time.
const SUPERSTEPS_PER_SECOND = 240;
const SEED = 1;

describe.skipIf(!device)('hourglass', () => {
  // Experiment: sand runs through a narrow neck at a steady rate however much is left above it, which is why an hourglass
  //   keeps time; water slows as its level falls.
  // Target: in two dimensions the rate through an outlet D grains wide grows as (D - k d)^(3/2) (Beverloo's law; the 3/2
  //   power holds in every 2D study: Carlevaro et al. 2024), with k about 1 to 2, and does not depend on the height of sand
  //   above once that passes about the silo's width. (a) The rate stays within 10% of its mean while the sand above falls from
  //   6 to 1.5 silo widths (tolerance inferred). (b) Widening the outlet from 8 to 16 cells multiplies it by
  //   (16 - k)^(3/2) / (8 - k)^(3/2): 2.83 for k = 0, 3.14 for k = 1, 3.56 for k = 2 (one cell is one grain).
  //   Held out (REPOSE_FIT, fitted on a pour from a brush 3 cells wide): the pile in the bulb stands at the angle of repose,
  //   34 +- 4 degrees (Wikipedia 34, Dartmouth's engineering notes 35 for dry sand), built by a stream as wide as the outlet.
  // Measure: SAND cells through the outlet (the silo's cells less those still above its plate), from the silo full (6 widths)
  //   to 1.5 widths of sand above: the window is split in four by the cells that pass, each quarter's rate is its cells per 100
  //   supersteps, and (a) is the largest distance of a quarter from the window's mean rate, in percent. (b) is the window's
  //   mean rate at an outlet of 16 over the one at 8. The angle is read from the pile once the outlet is plugged with WALL and
  //   the pile has settled for 3,000 supersteps.
  // Leaves out: arches that jam a real outlet (a CA has none), grain size (a cell is a grain) and the air a real neck draws in.
  const { cells } = hourglassLayout();
  const WINDOW_CELLS = cells * (1 - 1.5 / HOURGLASS.fillWidths);
  const SAMPLE = 50;
  const SETTLE = 3000;
  // A test liquid with sand's density: the silo of the control. Water-like, so that it spreads at the cap.
  const LIQUID = 200;
  const LIQUID_ROW: ElementDef = { key: 'SANDLIQ', id: LIQUID, label: 'Sand liquid', color: [0.8, 0.7, 0.48], state: 'liquid', density: 1600, viscosity: 0.001 };
  const TEST_ROWS: readonly ElementDef[] = [...ELEMENTS, LIQUID_ROW];

  interface Drain {
    /** Cells per 100 supersteps over the whole window. */
    rate: number;
    /** The largest distance of a quarter of the window from `rate`, in percent. */
    spread: number;
    /** The pile's slope in degrees; NaN when not asked for. */
    angle: number;
  }

  async function drain(outlet: number, seed: number, fill: number, withAngle: boolean): Promise<Drain> {
    const layout = hourglassLayout(outlet);
    const scene = hourglass(outlet, fill);
    const sim = createSim(scene.width, scene.height, seed, { elements: TEST_ROWS });
    sim.load(scene.fields);
    // The superstep at which the cells through the outlet first reach each quarter mark, interpolated between samples.
    const marks = [0, 1, 2, 3, 4].map((q) => (q * WINDOW_CELLS) / 4);
    const times: number[] = [0];
    let supersteps = 0;
    let before = 0;
    while (times.length < marks.length) {
      await runMany(sim, SAMPLE);
      supersteps += SAMPLE;
      const kinds = await sim.fields.read('kind');
      let above = 0;
      for (let y = layout.plateY1; y < scene.height; y++) {
        for (let x = 0; x < scene.width; x++) if (cellType(kinds[y * scene.width + x]) === fill) above++;
      }
      const through = layout.cells - above;
      while (times.length < marks.length && through >= marks[times.length]) {
        const mark = marks[times.length];
        times.push(supersteps - SAMPLE + (SAMPLE * (mark - before)) / (through - before));
      }
      before = through;
      if (supersteps > 100_000) return { rate: NaN, spread: NaN, angle: NaN };
    }
    const rates = times.slice(1).map((t, q) => ((WINDOW_CELLS / 4) * 100) / (t - times[q]));
    const rate = (WINDOW_CELLS * 100) / times[4];
    const spread = Math.max(...rates.map((r) => (Math.abs(r - rate) / rate) * 100));
    if (!withAngle) return { rate, spread, angle: NaN };

    // Plug the outlet and let the pile settle.
    const data = emptyCellData(scene.width * scene.height);
    for (const { name } of CELL_FIELDS) data[name].set(await sim.fields.read(name));
    for (let y = layout.plateY0; y < layout.plateY1; y++) {
      for (let x = layout.outletX0; x < layout.outletX1; x++) {
        for (const { name } of CELL_FIELDS) data[name][y * scene.width + x] = 0;
        data.kind[y * scene.width + x] = packCell(T.WALL);
      }
    }
    sim.load(data);
    await runMany(sim, SETTLE);
    const kinds = await sim.fields.read('kind');
    return { rate, spread, angle: pileAngle(columnTops(kinds, scene.width, layout.plateY0, WALL, fill)) };
  }

  const memo = new Map<string, Promise<Drain>>();
  const drained = (outlet: number, fill: number, withAngle: boolean, seed = SEED): Promise<Drain> => {
    const key = `${outlet}/${fill}/${withAngle}/${seed}`;
    if (!memo.has(key)) memo.set(key, drain(outlet, seed, fill, withAngle));
    return memo.get(key)!;
  };

  const BEVERLOO = [2.83, 3.56] as const;
  const REPOSE = [30, 38] as const;

  scenario({
    name: 'hourglass',
    measure: async () => {
      const narrow = await drained(HOURGLASS.outlet, T.SAND, true);
      const wide = await drained(2 * HOURGLASS.outlet, T.SAND, true);
      return { spread: narrow.spread, ratio: wide.rate / narrow.rate, angle: narrow.angle, wideAngle: wide.angle };
    },
    checks: [
      { value: 'spread', outcome: 'the rate stays within 10% of its mean while the sand above falls from 6 to 1.5 silo widths', target: [0, 10] },
      {
        value: 'ratio',
        outcome: 'widening the outlet from 8 to 16 cells multiplies the rate by 2.83 to 3.56',
        target: BEVERLOO,
        waitsFor: ['B17'],
        companion: [1, 4],
      },
      {
        value: 'angle',
        outcome: 'the pile under an outlet of 8 stands at 34 ± 4 degrees',
        target: REPOSE,
        waitsFor: ['B18'],
        companion: [20, 50],
      },
      {
        value: 'wideAngle',
        outcome: 'the pile under an outlet of 16 stands at 34 ± 4 degrees',
        target: REPOSE,
        waitsFor: ['B18'],
        companion: [20, 50],
      },
    ],
    timeout: 120_000,
  });

  // A liquid of sand's density runs out as Torricelli's law says, in proportion to the outlet's width at best and
  // slowing as its level falls: it misses the ratio and the steady rate.
  control({
    name: 'hourglass',
    wrong: 'a silo of liquid of sand\'s density',
    measure: async () => {
      const narrow = await drained(HOURGLASS.outlet, LIQUID, false);
      const wide = await drained(2 * HOURGLASS.outlet, LIQUID, false);
      return wide.rate / narrow.rate;
    },
    target: BEVERLOO,
    timeout: 120_000,
  });
});

describe.skipIf(!device)('viscousSpread', () => {
  // Experiment: honey poured on a plate, or lava on flat ground, spreads fast at first and ever more slowly as it thins.
  // Target: the front of a two-dimensional viscous current of fixed area A on a flat floor moves as
  //   x = 1.411 (g A^3 t / (3 nu))^(1/5) (Huppert 1982: the similarity solution every release tends to; A the area from
  //   the wall to the front, nu the kinematic viscosity). Lava (30 Pa·s, 2,700 kg/m³: the LAVA row, nu = 0.0111 m²/s)
  //   released from a column 14 cells wide and 40 high against a wall (A = 560 cells² = 1.04e-3 m², a cell being 1.36 mm):
  //   x = 0.0886 m = 65 cells at 3 s and 103 cells at 30 s (the factor 10^(1/5) = 1.58 between them, whatever the viscosity).
  //   Tolerance: 20% on the positions (52 to 78 and 82 to 124) and 1.45 to 1.75 on the ratio (inferred).
  // Valid while: the flow is viscous (a Reynolds number of 0.006 at 3 s) and deeper on average (8.6 cells at 3 s, 5.4 at 30 s)
  //   than lava's capillary length (2.7 cells, from a surface tension of 0.36 N/m), under which surface tension slows a real one.
  // Measure: the farthest column holding lava in the tank's bottom row, counted from the wall.
  // Leaves out: the lava's cooling (`air: false` over a floor of WALL, which takes no heat) and surface tension.
  const FRONT_3S = [52, 78] as const;
  const FRONT_30S = [82, 124] as const;
  const T3 = 3 * SUPERSTEPS_PER_SECOND;
  const T30 = 30 * SUPERSTEPS_PER_SECOND;
  const SEEDS = [1, 2, 3];

  async function fronts(seed: number, elements: readonly ElementDef[] = ELEMENTS): Promise<{ at3: number; at30: number }> {
    const scene = viscousSpread();
    const sim = createSim(scene.width, scene.height, seed, { air: false, elements: elements });
    sim.load(scene.fields);
    const front = async (): Promise<number> => {
      const kinds = await sim.fields.read('kind');
      let x = 0;
      for (let k = 0; k < scene.width; k++) if (cellType(kinds[WALL * scene.width + k]) === T.LAVA) x = k + 1 - WALL;
      return x;
    };
    await runMany(sim, T3);
    const at3 = await front();
    await runMany(sim, T30 - T3);
    return { at3, at30: await front() };
  }

  scenario({
    name: 'viscousSpread',
    // The front is one cell at the thin edge of the flow, which turns around now and then: at 30 s it ranges from 76 to 130
    // cells over seeds 1 to 3, more than a quarter of the window's width, so the scenario reads the mean of the three seeds.
    measure: async () => {
      const runs = await Promise.all(SEEDS.map((seed) => fronts(seed)));
      const at3 = runs.reduce((sum, run) => sum + run.at3, 0) / runs.length;
      const at30 = runs.reduce((sum, run) => sum + run.at30, 0) / runs.length;
      return { at3, at30, ratio: at30 / at3 };
    },
    checks: [
      { value: 'at3', outcome: 'the lava front is 52 to 78 cells from the wall after 3 s', target: FRONT_3S, waitsFor: ['I35'], companion: [10, 80] },
      { value: 'at30', outcome: 'the lava front is 82 to 124 cells from the wall after 30 s', target: FRONT_30S },
      {
        value: 'ratio',
        outcome: 'the front after 30 s is 1.45 to 1.75 times as far as after 3 s',
        target: [1.45, 1.75],
        waitsFor: ['I35'],
        companion: [1, 5],
      },
    ],
    timeout: 120_000,
  });

  // Ten times the viscosity puts the front at 0.63 times the distance (the fifth root of 10 is 1.58), short of both windows.
  control({
    name: 'viscousSpread',
    wrong: 'lava ten times as viscous',
    measure: async () => {
      const lava = elementByKey(ELEMENTS, 'LAVA');
      const thick = ELEMENTS.map((e) => (e.key === 'LAVA' ? { ...e, viscosity: lava.viscosity! * 10 } : e));
      return (await fronts(SEED, thick)).at3;
    },
    target: FRONT_3S,
    timeout: 120_000,
  });
});

describe.skipIf(!device)('freeFall', () => {
  // Experiment: a pebble, a grain of sand and a pinch of flour dropped from 1 m. This is the sand grain.
  // Target: the sand grain (0.3 mm, settling at about 2 m/s) lands in 0.64 s. Settling speeds from
  //   `docs/research/physical-properties.md` (Grain size: 1.8 to 2.4 m/s for 0.3 mm grains, an inferred spread around 2 m/s),
  //   times from drag between linear and quadratic in the speed (the grain's Reynolds number is about 40): 0.58 to 0.74 s.
  //   The fall is 1 m = 734 cells (a cell is 1.36 mm).
  // Measure: the seconds (supersteps / 240) until the grain, dropped from rest 734 cells above the floor in still air, is a
  //   cell on the floor again; between launch and landing it is a flyer, not in the grid.
  // Leaves out: grains in a crowd, a heap's draft and the air the grain pushes aside.
  const TARGET = [0.58, 0.74] as const;
  const CAP = 6 * SUPERSTEPS_PER_SECOND;

  async function fallTime(seed: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const scene = freeFall();
    const sim = createSim(scene.width, scene.height, seed, { elements: elements });
    sim.load(scene.fields);
    for (let supersteps = 1; supersteps <= CAP; supersteps++) {
      await runMany(sim, 1);
      const kinds = await sim.fields.read('kind');
      for (let x = 0; x < scene.width; x++) {
        if (cellType(kinds[WALL * scene.width + x]) === T.SAND) return supersteps / SUPERSTEPS_PER_SECOND;
      }
    }
    return NaN;
  }

  scenario({
    name: 'freeFall',
    measure: async () => ({ seconds: await fallTime(SEED) }),
    checks: [
      {
        value: 'seconds',
        outcome: 'a sand grain falls 734 cells (1 m) in 0.58 to 0.74 s',
        target: TARGET,
        waitsFor: ['I34'],
        companion: [0.4, 1.5],
      },
    ],
    timeout: 120_000,
  });

  // Four times the default drag settles the grain at a quarter of the speed, about 3.3 s.
  control({
    name: 'freeFall',
    wrong: 'SAND at four times the default drag',
    measure: () => fallTime(SEED, ELEMENTS.map((e) => (e.key === 'SAND' ? { ...e, drag: 4 * DEFAULT_DRAG } : e))),
    target: TARGET,
    timeout: 120_000,
  });
});
