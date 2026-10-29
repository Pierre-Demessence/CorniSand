import { describe } from 'vitest';
import { tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementConductivity, elementHeatCapacity, type ElementDef } from '../src/elements';
import { effectiveTemp } from '../src/heat';
import { CONTACT_TEMP, ICE_CUP, STEAM_BURN, contactTemp, iceCup, steamBurn, type IceCupVersion, type SteamBurnFill } from '../src/scenarios';
import type { Scene } from '../src/scenes';
import { cellType, createSim, device, runMany } from './gpu';
import { control, scenario, type Range } from './scenario';

// The heat bookkeeping scenarios of M8.9 (`docs/plans/m8.9-real-world-scenarios.md`, AC4 to AC6): sealed experiments
// whose target is a heat balance of the rows' own data. All three run without the air; the cells sit in WALL, which
// holds no heat, or at the grid's edge, which holds none either.

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
  //   test checks the heat balance, not the mixing).
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
  // Leaves out: steam's volume (a steam cell holds one water cell's mass, backlog I22) and the air.
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
