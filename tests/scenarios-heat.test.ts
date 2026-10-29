import { describe } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, type ElementDef } from '../src/elements';
import { effectiveTemp } from '../src/heat';
import { CELL_SIZE, HEAT_UNIT, PAIR_TIME } from '../src/physics';
import { WALL } from '../src/scene-canvas';
import {
  CONTACT_TEMP, HEATED_LAYER, ICE_CUP, LAVA_CRUST, STEAM_BURN, contactTemp, heatedLayer, iceCup, lavaCrust, redHotBar, steamBurn,
  type HeatedLayerKind, type IceCupVersion, type SteamBurnFill,
} from '../src/scenarios';
import type { Scene } from '../src/scenes';
import { FRAME_SUPERSTEPS, cellType, createSim, device, runMany } from './gpu';
import { control, scenario, waitsFor, type Range } from './scenario';

// The heat scenarios of M8.9 (`docs/plans/m8.9-real-world-scenarios.md`). AC4 to AC6: sealed experiments whose target is a
// heat balance of the rows' own data; they run without the air, the cells sit in WALL, which holds no heat, or at the grid's
// edge, which holds none either. AC7 to AC9 (`redHotBar`, `lavaCrust`, `heatedLayer`) wait for mechanics the game lacks.

const NO_AIR = { air: false };
// A superstep is 1/240 s of game time.
const SUPERSTEPS_PER_SECOND = 240;
// steamBurn's targets are computed from the data and rounded outward to 0.1 °C, so that the rounding never narrows a range
// (the plan's rounding to the nearest excludes the steel row's own result of 86.14 °C; awaiting the user, see the plan's M8.9e).
const outward = (min: number, max: number): Range => [Math.floor(min * 10 + 1e-9) / 10, Math.ceil(max * 10 - 1e-9) / 10];
const nearest = (min: number, max: number): Range => [Math.round(min * 10) / 10, Math.round(max * 10) / 10];

interface Settled {
  /** The mean displayed temperature of the measured cells once they have evened out, NaN if they never did. */
  mean: number;
  supersteps: number;
}

/**
 * Runs `scene` in `elements` and, every `step` supersteps, reads the displayed temperature (`effectiveTemp`, what the
 * readout shows) of the cells `measured` selects. It returns their mean once `done` holds for the kinds and every one
 * is within `spread` of the mean, or NaN after `cap` supersteps.
 */
async function settle(
  scene: Scene,
  elements: readonly ElementDef[],
  seed: number,
  measured: (type: number, x: number, y: number) => boolean,
  done: (types: Uint8Array) => boolean,
  { step, cap, spread }: { step: number; cap: number; spread: number },
): Promise<Settled> {
  const sim = createSim(scene.width, scene.height, seed, { ...NO_AIR, elements });
  sim.load(scene.fields);
  const rows = new Map(elements.map((e) => [e.id, e]));
  for (let supersteps = step; supersteps <= cap; supersteps += step) {
    await runMany(sim, step);
    const kind = await sim.fields.read('kind');
    const temp = tempView({ temp: await sim.fields.read('temp') });
    const types = new Uint8Array(kind.length);
    let sum = 0;
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < kind.length; i++) {
      types[i] = cellType(kind[i]);
      if (!measured(types[i], i % scene.width, Math.floor(i / scene.width))) continue;
      const t = effectiveTemp(rows.get(types[i])!, temp[i]);
      sum += t;
      count++;
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    const mean = sum / count;
    if (done(types) && max - mean <= spread && mean - min <= spread) return { mean, supersteps };
  }
  return { mean: NaN, supersteps: cap };
}

/** The table with a transition's latent heat scaled, on both sides of each pair (a pair shares one latent heat). */
function withLatentScaled(pairs: readonly (readonly [string, string])[], scale: number): ElementDef[] {
  const sides = new Map<string, 'above' | 'below'>();
  for (const [above, below] of pairs) {
    sides.set(above, 'above');
    sides.set(below, 'below');
  }
  return (ELEMENTS as readonly ElementDef[]).map((e): ElementDef => {
    const side = sides.get(e.key);
    const transition = side && e[side];
    return transition ? { ...e, [side]: { ...transition, latent: (transition.latent ?? 0) * scale } } : e;
  });
}

describe.skipIf(!device)('iceCup', () => {
  // Experiment: ice at 0 °C dropped into water at 20 °C, 1 part ice to 9 by mass, in a sealed insulated cup.
  // Target: all the ice melts and the cup ends at T with 9 x 4.18 x (20 - T) = 334 + 4.18 T (water's latent heat of melting,
  //   334 kJ/kg, and its capacity 4.18 kJ/kg·K: the WATER row's data), which is 10.0 °C. A cell is one unit of matter, so
  //   the cup of 25x40 cells holds exactly 100 ice and 900 water. Tolerance +-0.2 °C: water's capacity runs from 4.18 to
  //   4.22 kJ/kg·K between 20 and 0 °C, which moves the result by 0.1 °C. Sources: Wikipedia, Enthalpy of fusion; CRC Handbook.
  // Measure: the mean displayed temperature of the cup's cells once no ICE cell is left. Every cell is then water, one
  //   capacity, so the mean is the cup's heat balance whether or not the water has evened out (a cup without convection takes
  //   an hour to; it is not waited for).
  // Leaves out: the cup's own heat (WALL holds none), and whether the cup evens out (it does so slowly, backlog B15: this
  //   test checks the heat balance, not the mixing). Ice's volume: with a volume change by phase (backlog I22) a full ice
  //   cell holds 0.917 of a water cell's mass, and this cup would end near 10.8 °C; its scene then takes 109 ice cells and
  //   1,009 cells in all to keep 1 to 9 by mass and the target (`docs/research/volume-changes.md`).
  const TARGET = [9.8, 10.2] as const;
  // A cap of 12 minutes of game time for the chips and 40 for the cube; a cup that never evens out measures NaN.
  const capMinutes: Record<IceCupVersion, number> = { fast: 12, full: 40 };

  async function meanTemp(version: IceCupVersion, seed: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const scene = iceCup(version);
    const inCup = (type: number): boolean => type !== T.WALL;
    const { mean } = await settle(scene, elements, seed, inCup, (types) => !types.includes(T.ICE), {
      step: 1200,
      cap: capMinutes[version] * 60 * SUPERSTEPS_PER_SECOND,
      spread: Infinity,
    });
    return mean;
  }

  for (const [version, timeout] of [['fast', 300_000], ['full', 600_000]] as const) {
    scenario({
      name: 'iceCup',
      version,
      measure: async () => ({ end: await meanTemp(version, 1) }),
      checks: [{ value: 'end', outcome: `ends at 10.0 ± 0.2 °C (${ICE_CUP.cupWidth}x${ICE_CUP.cupHeight} cup, 1 part ice to 9)`, target: TARGET }],
      timeout,
    });
  }

  // Half the latent heat of melting leaves the cup at 14.0 °C.
  control({
    name: 'iceCup',
    version: 'fast',
    wrong: 'ICE and WATER with half their shared latent heat',
    measure: () => meanTemp('fast', 1, withLatentScaled([['ICE', 'WATER']], 0.5)),
    target: TARGET,
    timeout: 300_000,
  });
});

describe.skipIf(!device)('steamBurn', () => {
  // Experiment: why steam scalds worse than boiling water: the same mass of each at 100 °C, sealed inside a cold steel box,
  //   so the condensate stays against the steel. 10 cells of steam (or of water) at 100 °C in a box of 100 METAL cells at 20 °C.
  // Target: a heat balance with water's latent heat of boiling, 2,257 kJ/kg (CRC Handbook; the WATER row holds the same number, written out here so the target does not read the row), its capacity 4.18 MJ/m³·K and steel's
  //   volumetric capacity C: steam gives 10 x (2,257 + 4.18 x (100 - T)) = 100 x C x (T - 20), boiling water
  //   10 x 4.18 x (100 - T) = 100 x C x (T - 20). The METAL row's C is 3.5 MJ/m³·K (0.449 kJ/kg·K at 7,870 kg/m³), and carbon
  //   steel's cited range, 0.45 to 0.49 kJ/kg·K, is 3.5 to 3.85 MJ/m³·K. That gives T = 86.14 to 80.71 °C with steam and
  //   28.54 to 27.83 °C with water; rounded outward, 80.7 to 86.2 and 27.8 to 28.6. Per unit of mass, steam brings 7.75 times
  //   the heat of boiling water to a surface at 20 °C ((2,257 + 4.18 x 80) / (4.18 x 80)).
  // Measure: the mean displayed temperature of the box's cells once every one is within 0.5 °C of it (when the last steam
  //   condenses the steel is between 84.5 °C, the latent heat alone, and 86.1 °C, by how much the condensate has cooled).
  // Leaves out: steam's volume (a steam cell holds one water cell's mass, backlog I22; with I22's steam that fills k
  //   cells, the same mass is 10 x k steam cells and the box grows to hold them) and the air.
  const { cavity, boxWidth, boxHeight, fillTemp, boxTemp } = STEAM_BURN;
  const fillCells = (cavity.x1 - cavity.x0) * (cavity.y1 - cavity.y0);
  const metalCells = boxWidth * boxHeight - fillCells;
  const WATER_CAPACITY = elementHeatCapacity(elementByKey(ELEMENTS, 'WATER'));
  const LATENT = 2257;
  const STEEL_CAPACITY = [3.5, 3.85] as const;

  const balance = (fill: SteamBurnFill, steelCapacity: number): number => {
    const given = fillCells * ((fill === 'steam' ? LATENT : 0) + WATER_CAPACITY * fillTemp);
    return (given + metalCells * steelCapacity * boxTemp) / (fillCells * WATER_CAPACITY + metalCells * steelCapacity);
  };
  const STEAM_TARGET = outward(balance('steam', STEEL_CAPACITY[1]), balance('steam', STEEL_CAPACITY[0]));
  const WATER_TARGET = outward(balance('water', STEEL_CAPACITY[1]), balance('water', STEEL_CAPACITY[0]));

  async function endTemp(fill: SteamBurnFill, seed: number, elements: readonly ElementDef[] = ELEMENTS): Promise<number> {
    const scene = steamBurn(fill);
    const inBox = (type: number): boolean => type !== T.WALL;
    const { mean } = await settle(scene, elements, seed, inBox, (types) => !types.includes(T.STEAM), {
      step: 240,
      cap: 20 * 60 * SUPERSTEPS_PER_SECOND,
      spread: 0.5,
    });
    return mean;
  }

  for (const [fill, target, outcome] of [
    ['steam', STEAM_TARGET, 'steam ends at 80.7 to 86.2 °C'],
    ['water', WATER_TARGET, 'boiling water ends at 27.8 to 28.6 °C'],
  ] as const) {
    scenario({
      name: 'steamBurn',
      version: fill,
      measure: async () => ({ end: await endTemp(fill, 1) }),
      checks: [{ value: 'end', outcome, target }],
      timeout: 300_000,
    });
  }

  // A tenth of the latent heat of boiling leaves the steam case at 34.3 °C.
  control({
    name: 'steamBurn',
    version: 'steam',
    wrong: 'WATER and STEAM with a tenth of their shared latent heat',
    measure: () => endTemp('steam', 1, withLatentScaled([['WATER', 'STEAM']], 0.1)),
    target: STEAM_TARGET,
    timeout: 300_000,
  });
});

describe.skipIf(!device)('contactTemp', () => {
  // Experiment: why metal feels colder than wood: a steel block at 80 °C pressed against a granite block at 20 °C. Their
  //   contact face jumps at once to near the temperature of the block that passes heat on faster, and stays there.
  // Target: two bodies in perfect contact hold their contact face at the mean of their starting temperatures weighted by their
  //   effusivities sqrt(k C), at every time until the heat reaches their far ends (the exact solution for two semi-infinite
  //   solids; Wikipedia, Thermal effusivity). The rows (steel 50 W/m·K and 3.5 MJ/m³·K, granite 2.5 and 2.2) give 71.0 °C. The
  //   rows' cited ranges (steel 45 to 60 W/m·K and 3.5 to 3.85 MJ/m³·K, granite 2 to 3.5 W/m·K) give 69.14 to 72.72 °C, rounded
  //   to 69.1 to 72.7.
  // Measure: the contact face from the two cells beside it, weighted by their conductivities (the face between two half cells
  //   in series), sampled every 5 s from 10 s, when the heat has spread over more than 5 cells of the stone, the slower
  //   side, to 60 s, before it reaches either far end (the steel's heat has then gone 43 of its 100 cells, the
  //   stone's 12 of 60). The face also stays within 1 °C over that window.
  // Leaves out: the contact resistance of real surfaces.
  const { steelCells, steelTemp, stoneTemp } = CONTACT_TEMP;
  const effusivity = (k: number, c: number): number => Math.sqrt(k * c);
  const faceTemp = (steel: { k: number; c: number }, stone: { k: number; c: number }): number => {
    const a = effusivity(steel.k, steel.c);
    const b = effusivity(stone.k, stone.c);
    return (a * steelTemp + b * stoneTemp) / (a + b);
  };
  const FACE_TARGET = nearest(faceTemp({ k: 45, c: 3.5 }, { k: 3.5, c: 2.2 }), faceTemp({ k: 60, c: 3.85 }, { k: 2, c: 2.2 }));
  const DRIFT_TARGET = [0, 1] as const;

  async function face(seed: number, elements: readonly ElementDef[] = ELEMENTS): Promise<{ face: number; drift: number }> {
    const scene = contactTemp();
    const sim = createSim(scene.width, scene.height, seed, { ...NO_AIR, elements });
    sim.load(scene.fields);
    const steel = elements.find((e) => e.id === T.METAL)!;
    const stone = elements.find((e) => e.id === T.STONE)!;
    const kSteel = elementConductivity(steel);
    const kStone = elementConductivity(stone);
    await runMany(sim, 10 * SUPERSTEPS_PER_SECOND);
    const faces: number[] = [];
    for (let t = 10; t <= 60; t += 5) {
      const temp = tempView({ temp: await sim.fields.read('temp') });
      const a = effectiveTemp(steel, temp[steelCells - 1]);
      const b = effectiveTemp(stone, temp[steelCells]);
      faces.push((kSteel * a + kStone * b) / (kSteel + kStone));
      if (t < 60) await runMany(sim, 5 * SUPERSTEPS_PER_SECOND);
    }
    return { face: faces.reduce((sum, f) => sum + f, 0) / faces.length, drift: Math.max(...faces) - Math.min(...faces) };
  }

  scenario({
    name: 'contactTemp',
    measure: () => face(1),
    checks: [
      { value: 'face', outcome: 'holds the contact face at 69.1 to 72.7 °C', target: FACE_TARGET },
      { value: 'drift', outcome: 'keeps the contact face within 1 °C from 10 s to 60 s', target: DRIFT_TARGET },
    ],
    timeout: 120_000,
  });

  // Stone with a conductivity of 25 W/m·K holds the face near 58 °C.
  control({
    name: 'contactTemp',
    wrong: 'STONE at 25 W/m·K',
    measure: async () => (await face(1, ELEMENTS.map((e) => (e.key === 'STONE' ? { ...e, conductivity: 25 } : e)))).face,
    target: FACE_TARGET,
    timeout: 120_000,
  });
});

/** Memoizes an async measurement by its key, so that a scenario's tests and its control share one run. */
function memo<A extends unknown[], R>(key: (...args: A) => string, measure: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const runs = new Map<string, Promise<R>>();
  return (...args) => {
    const k = key(...args);
    if (!runs.has(k)) runs.set(k, measure(...args));
    return runs.get(k)!;
  };
}

describe.skipIf(!device)('redHotBar', () => {
  // Experiment: a steel bar 2.2 cm square (16x16 cells) taken out of a forge at 1,000 °C and left in still room air, hanging
  //   in it, so that it loses heat through its four sides, as a long bar does.
  // Target: lumped cooling (the bar's Biot number is 0.03) through radiation at oxidized steel's emissivity, 0.9 to 0.6 (to
  //   room walls at 20 °C), and natural convection at 10 W/m²·K. Full: with steel's heat capacity by temperature (EN 1993-1-2:
  //   440 J/kg·K at 20 °C, 760 at 600 °C, a peak near 735 °C, where its crystal structure changes and a cooling bar pauses, and
  //   650 above 900 °C): 715 to 755 °C after 125 s; the emissivity alone spans 730 to 751 °C, convection (nearer 19 W/m²·K than
  //   10 on a bar this small) lowers it by about 8 °C, and a cooling bar changes structure at a somewhat lower temperature than
  //   EN 1993-1-2's heating curve gives (inferred). Fast: the same cooling at the METAL row's constant 3.5 MJ/m³·K (iron at 20 °C):
  //   578 to 650 °C for emissivity 0.6 to 0.9 at 10 W/m²·K, about 10 °C lower with convection at 19 W/m²·K (estimate), so 565 to 655.
  //   Sources: EN 1993-1-2 (steel's specific heat); Incropera et al., Fundamentals of Heat and Mass Transfer (Table 1.1,
  //   convection coefficients; the emissivity of oxidized steel).
  // Measure: the bar's mean displayed temperature at 125 s (30,000 supersteps).
  // Leaves out: radiation coming back from the room (taken at 20 °C).
  // Waits: the game's cells lose heat to the air only (backlog I26, radiation); the full one also needs a heat capacity that follows
  //   temperature (backlog I30).
  const FAST_TARGET = [565, 655] as const;
  const FULL_TARGET = [715, 755] as const;

  const barTemp = memo(
    (elements: readonly ElementDef[]) => String(elements.find((e) => e.id === T.METAL)!.heatCapacity),
    async (elements: readonly ElementDef[]): Promise<number> => {
      const scene = redHotBar();
      const sim = createSim(scene.width, scene.height, 1, { elements });
      sim.load(scene.fields);
      const metal = elements.find((e) => e.id === T.METAL)!;
      await runMany(sim, 125 * SUPERSTEPS_PER_SECOND, FRAME_SUPERSTEPS);
      const kind = await sim.fields.read('kind');
      const temp = tempView({ temp: await sim.fields.read('temp') });
      let sum = 0;
      let count = 0;
      for (let i = 0; i < kind.length; i++) {
        if (cellType(kind[i]) !== T.METAL) continue;
        sum += effectiveTemp(metal, temp[i]);
        count++;
      }
      return sum / count;
    },
  );

  for (const [version, target, waits, outcome] of [
    ['fast', FAST_TARGET, waitsFor('redHotBar', 'I26'), 'a steel bar 16x16 cells at 1,000 °C is at 565 to 655 °C after 125 s (the row\'s constant capacity)'],
    ['full', FULL_TARGET, waitsFor('redHotBar'), 'a steel bar 16x16 cells at 1,000 °C is at 715 to 755 °C after 125 s'],
  ] as const) {
    scenario({
      name: 'redHotBar',
      version,
      measure: async () => ({ end: await barTemp(ELEMENTS) }),
      checks: [{ value: 'end', outcome, target, waitsFor: waits, companion: [target[0], 1000] }],
      timeout: 120_000,
    });
  }

  // Steel at twice its capacity cools half as fast and ends near 957 °C, far above the fast window.
  control({
    name: 'redHotBar',
    version: 'fast',
    wrong: 'METAL at twice its heat capacity',
    measure: () => barTemp(ELEMENTS.map((e) => (e.key === 'METAL' ? { ...e, heatCapacity: elementHeatCapacity(e) * 2 } : e))),
    target: FAST_TARGET,
    timeout: 120_000,
  });
});

describe.skipIf(!device)('lavaCrust', () => {
  // Experiment: a pool of basaltic lava open to still air grows a solid crust.
  // Target: crust thickness C = 0.0779 sqrt(t), C in metres and t in hours (Hon et al. 1994, Kilauea's pahoehoe flows; written
  //   t = 164.8 C² by Speiser 2017, whose text says centimetres but whose results fit metres only: its 45 cm crust is dated 35.6
  //   hours, near the 33 that metres give). That is 1 cm (7.4 cells) after 59 s and 3 cm (22.1 cells) after 9 minutes. The fit
  //   covers crusts of centimetres to about a metre over hours to days, so the first minutes extrapolate it: a factor of 1.5 on the
  //   thickness (estimate), 4.9 to 11.1 cells at 1 min and 14.8 to 33.2 at 9. The crust at 9 minutes is sqrt(9) = 3 times the
  //   crust at 1 minute whatever the constant, read to one cell at each end: 2.5 to 3.6.
  // Measure: the thickness of the STONE layer over the middle half of the pool, as the run of STONE cells from its surface down
  //   (0 where the surface cell is not STONE), averaged over those columns, at 1 and 9 minutes. The ratio is the crust at 9 over
  //   the crust at 1 minute, 0 when there is no crust at 1 minute.
  // Leaves out: real basalt sets over a range of temperatures, the game's lava at one (1,200 °C, the LAVA row); the pool starts
  //   at the row's painted 1,300 °C; gas bubbles in the crust, wind, rain.
  // Waits: radiation (backlog I26): at 1,150 °C a surface of emissivity 0.9 radiates 209 kW/m², 18 times the 11 kW/m² still air
  //   carries away; and a pool surface in the game loses far less than a bar's sides (backlog B16).
  const CRUST_1 = [4.9, 11.1] as const;
  const CRUST_9 = [14.8, 33.2] as const;
  const RATIO = [2.5, 3.6] as const;

  /** The crust over the middle of the pool at each of `minutes`, in cells. */
  async function crusts(latentScale: number, minutes: readonly number[]): Promise<number[]> {
    const scene = lavaCrust();
    const elements = ELEMENTS.map((e): ElementDef => {
      if (latentScale === 1) return e;
      if (e.key === 'LAVA') return { ...e, below: { ...e.below, latent: e.below.latent * latentScale } };
      if (e.key === 'STONE') return { ...e, above: { ...e.above, latent: e.above.latent * latentScale } };
      return e;
    });
    const sim = createSim(scene.width, scene.height, 1, { elements });
    sim.load(scene.fields);
    const x0 = WALL + LAVA_CRUST.poolWidth / 4;
    const x1 = WALL + (3 * LAVA_CRUST.poolWidth) / 4;
    const result: number[] = [];
    let done = 0;
    for (const minute of minutes) {
      await runMany(sim, (minute - done) * 60 * SUPERSTEPS_PER_SECOND, FRAME_SUPERSTEPS);
      done = minute;
      const kind = await sim.fields.read('kind');
      let sum = 0;
      for (let x = x0; x < x1; x++) {
        let y = scene.height - 1;
        while (y >= 0 && cellType(kind[y * scene.width + x]) === T.EMPTY) y--;
        while (y >= 0 && cellType(kind[y * scene.width + x]) === T.STONE) {
          sum++;
          y--;
        }
      }
      result.push(sum / (x1 - x0));
    }
    return result;
  }

  scenario({
    name: 'lavaCrust',
    measure: async () => {
      const [crust1, crust9] = await crusts(1, [1, 9]);
      return { crust1, crust9, ratio: crust1 > 0 ? crust9 / crust1 : 0 };
    },
    checks: [
      { value: 'crust1', outcome: 'has a crust of 4.9 to 11.1 cells after 1 min', target: CRUST_1, waitsFor: waitsFor('lavaCrust'), companion: [0, 12] },
      { value: 'crust9', outcome: 'has a crust of 14.8 to 33.2 cells after 9 min', target: CRUST_9, waitsFor: waitsFor('lavaCrust'), companion: [0, 34] },
      { value: 'ratio', outcome: 'has a crust 2.5 to 3.6 times as thick at 9 min as at 1', target: RATIO, waitsFor: waitsFor('lavaCrust'), companion: [0, 4] },
    ],
    timeout: 300_000,
  });

  // Four times the latent heat slows the crust to about half (the thickness goes with the inverse square root of the latent heat),
  // which misses the 1 minute window once the scenario passes; today there is no crust at all, which misses it too.
  control({
    name: 'lavaCrust',
    wrong: 'LAVA and STONE with four times their shared latent heat',
    measure: async () => (await crusts(4, [1]))[0],
    target: CRUST_1,
    timeout: 300_000,
  });
});

describe.skipIf(!device)('heatedLayer', () => {
  // Experiment: a layer of water heated gently from below conducts and stays still until the difference across it passes a
  //   threshold, then stirs into rolls (Rayleigh-Benard convection): a Rayleigh number of 1,708 between two rigid plates. For
  //   water at 20 °C that is 1.76 °C across a layer 3 cells deep (4.1 mm) and 0.093 °C across 8 cells (1.09 cm).
  // Target: below the threshold (3 cells and 1 °C: a Rayleigh number of 970) heat crosses by conduction alone, k dT / d, within
  //   20%: 0.8 to 1.2 times it. Well above it (8 cells and 2 °C: 36,780, Prandtl number 7) it crosses 3.2 to 3.3 times faster in the
  //   steady state, by Hollands 1984 (both forms of its last term), so 2.6 to 4.0 (+-20%, inferred: the correlation's scatter is
  //   not sourced). A gentler gradient cannot be measured: at 0.05 °C across 8 cells a conduction exchange moves a cell by
  //   2e-6 °C, the spacing of f32 values near 20 °C. k is water's 0.6 W/m·K (CRC Handbook).
  // Measure: from 2 to 3 minutes (28,800 to 43,200 supersteps), when the rolls have grown, the heat the layer carries across: the
  //   change of the plates' heat content (C x T summed) over the window, the mean of the lower plate's loss and the upper one's
  //   gain, as a flux over the layer's width, over k dT / d, with dT the difference of the plate rows touching the layer, taken
  //   as the mean of its values at the two ends of the window (the plates drift by a fraction of it). The plates are METAL, 70
  //   rows each, the layer starts on conduction's straight-line profile between them, `air: false`.
  // Leaves out: the walls' heat (WALL holds none), the plates' own resistance (0.4% of the layer's).
  // Waits: a convection onset (backlog I29): the game swaps two cells for any density difference.
  const ABOVE = [2.6, 4.0] as const;
  const BELOW = [0.8, 1.2] as const;
  const CONDUCTION = [0.9, 1.1] as const;
  const WATER_CONDUCTIVITY = 0.6;
  const FLAT_ID = 221;
  const FLAT_WATER: ElementDef = { ...elementByKey(ELEMENTS, 'WATER'), key: 'FLAT_WATER', id: FLAT_ID, label: 'Flat water', toolbar: 71, densityKnots: undefined };
  const TABLE = [...ELEMENTS, FLAT_WATER];
  const METAL_CAPACITY = elementHeatCapacity(elementByKey(ELEMENTS, 'METAL'));

  // How many times conduction's flux crosses the layer, in water or in water with one density at every temperature.
  const nusselt = memo(
    (kind: HeatedLayerKind, flat: boolean) => `${kind}${flat}`,
    async (kind: HeatedLayerKind, flat: boolean): Promise<number> => {
      const scene = heatedLayer(kind, flat ? FLAT_ID : T.WATER);
      const { width, plateRows } = HEATED_LAYER;
      const { depth } = HEATED_LAYER[kind];
      const sim = createSim(scene.width, scene.height, 1, { ...NO_AIR, elements: TABLE });
      sim.load(scene.fields);

      const read = async (): Promise<{ lower: number; upper: number; gap: number }> => {
        const temp = tempView({ temp: await sim.fields.read('temp') });
        let [lower, upper, lowerFace, upperFace] = [0, 0, 0, 0];
        for (let x = WALL; x < WALL + width; x++) {
          for (let y = 0; y < plateRows; y++) lower += METAL_CAPACITY * temp[y * scene.width + x];
          for (let y = plateRows + depth; y < scene.height; y++) upper += METAL_CAPACITY * temp[y * scene.width + x];
          lowerFace += temp[(plateRows - 1) * scene.width + x];
          upperFace += temp[(plateRows + depth) * scene.width + x];
        }
        return { lower, upper, gap: (lowerFace - upperFace) / width };
      };
      const [from, to] = [2 * 60 * SUPERSTEPS_PER_SECOND, 3 * 60 * SUPERSTEPS_PER_SECOND];
      await runMany(sim, from);
      const start = await read();
      await runMany(sim, to - from);
      const end = await read();

      // MJ/m³ summed over cells, times a cell's area: J per metre of depth.
      const joules = (heat: number): number => heat * HEAT_UNIT * CELL_SIZE ** 2;
      const flux = (joules(start.lower - end.lower) + joules(end.upper - start.upper)) / 2 / (width * CELL_SIZE) / ((to - from) * PAIR_TIME);
      const conduction = (WATER_CONDUCTIVITY * (start.gap + end.gap)) / 2 / (depth * CELL_SIZE);
      return flux / conduction;
    },
  );

  scenario({
    name: 'heatedLayer',
    measure: async () => ({ above: await nusselt('above', false), below: await nusselt('below', false) }),
    checks: [
      { value: 'below', outcome: 'carries heat across a layer 3 cells deep at 1 °C (Rayleigh 970) at 0.8 to 1.2 times conduction', target: BELOW, waitsFor: waitsFor('heatedLayer-below'), companion: [0.8, 6] },
      { value: 'above', outcome: 'carries heat across a layer 8 cells deep at 2 °C (Rayleigh 36,780) at 2.6 to 4.0 times conduction', target: ABOVE, waitsFor: waitsFor('heatedLayer'), companion: [2.6, 12] },
    ],
    timeout: 300_000,
  });

  // Without a density that changes with temperature nothing stirs: the measure itself is right, in both layers.
  scenario({
    name: 'heatedLayer',
    version: 'flat water',
    measure: async () => ({ above: await nusselt('above', true), below: await nusselt('below', true) }),
    checks: [
      { value: 'below', outcome: 'carries heat across a layer 3 cells deep at 0.9 to 1.1 times conduction', target: CONDUCTION },
      { value: 'above', outcome: 'carries heat across a layer 8 cells deep at 0.9 to 1.1 times conduction', target: CONDUCTION },
    ],
    timeout: 300_000,
  });

  control({
    name: 'heatedLayer',
    wrong: 'flat-density water above the threshold',
    measure: () => nusselt('above', true),
    target: ABOVE,
    timeout: 300_000,
  });
});
