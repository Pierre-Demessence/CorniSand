import { ABSOLUTE_ZERO, MAX_TEMP, ROOM_TEMP } from './heat';
import { DEFAULT_GRAVITY } from './physics';

// The element table: one row per material, the single source of the IDs, colors, movement class, density, lifetimes
// and toolbar entries that the shaders, the brush, the display and the toolbar are generated from.

// How an element moves and what moves through it. Empty is air. A solid never moves and nothing passes through it;
// powders and liquids fall; liquids also spread sideways; gases rise; plasma (fire) stays put but a gas rises through it.
export const STATES = ['empty', 'solid', 'powder', 'liquid', 'gas', 'plasma'] as const;
export type ElementState = (typeof STATES)[number];

export interface ElementDef {
  /** 'SAND': generates `ELEMENT.SAND` and the WGSL constant `EL_SAND`. */
  key: string;
  /** Stable, never reused; it is stored in the cells. */
  id: number;
  /** Toolbar text. */
  label: string;
  /** Linear RGB, 0-1. */
  color: readonly [number, number, number];
  state: ElementState;
  /**
   * kg/m³ from physical data or our own tuning. A heavier falling cell displaces a lighter one; a gas rises through a
   * heavier liquid. For a liquid with `densityKnots` it is its nominal density, inside the knots' range; for a gas (and
   * empty space) it is the density at `densityTemp`; a powder or a solid has this one density at every temperature.
   */
  density: number;
  /**
   * A liquid's density by temperature: one to `DENSITY_KNOTS` points `[°C, kg/m³]` of increasing temperature, linear
   * between them and flat outside (`densityAt`). Liquids only. Without it a liquid has `density` at every temperature,
   * so a body of it never convects. Water's has its maximum at 4 °C.
   */
  densityKnots?: readonly (readonly [number, number])[];
  /** °C that `density` is measured at, default `ROOM_TEMP`. Gases and empty space only: they follow the ideal-gas law from this one point (`densityAt`). */
  densityTemp?: number;
  /** Downward acceleration in cells per dispatch² of a powder or liquid; default `DEFAULT_GRAVITY` for those states, 0 for the others. Gases rise at a fixed speed and ignore it. */
  gravity?: number;
  /** Share of its velocity a flying cell of this element loses per dispatch; default `DEFAULT_DRAG`. */
  drag?: number;
  /** Becomes fire when a fire cell is in its block. */
  flammable?: boolean;
  /** °C a painted cell starts at, and a cell of a scene loaded without temperatures; default `ROOM_TEMP`. */
  temperature?: number;
  /** Thermal conductivity in W/m·K, 0 or more; default 0 (holds no heat unless it has a transition). Two cells exchange at the harmonic mean of their conductivities, 0 when either is 0 (`heatShare`, `src/heat.ts`). */
  conductivity?: number;
  /** Volumetric heat capacity in MJ/m³·K, above 0; default 1. A cell of a high capacity changes temperature less for the same heat. A gas row's is its specific heat times its liquid's density, as a cell is one unit of matter in every state. */
  heatCapacity?: number;
  /** Becomes the element `becomes` (a key) when its stored temperature drops below `temp` minus the latent width. */
  below?: Transition;
  /** Becomes the element `becomes` (a key) when its stored temperature rises above `temp` plus the latent width. */
  above?: Transition;
  /**
   * Becomes the element `becomes` (a key) in the dispatch the pressure of its air cell rises above `pressure`: one way,
   * instant, no latent heat, the cell keeps its heat (it starts at the temperature that holds the same heat, as at a temperature threshold). Dimensionless, like the air's pressure. Needs the air; without
   * it the cell never changes. Checked after the temperature thresholds.
   */
  pressureAbove?: PressureTransition;
  /**
   * Fracture toughness in MPa·√m: how easily a crack runs through the material, which decides what a blast breaks (every
   * cell is the same size and carries flaws of the same size, so the pressure that breaks it scales with its toughness).
   * Required with `pressureAbove`, whose pressure is this times `PRESSURE_PER_TOUGHNESS`; rejected without it.
   */
  toughness?: number;
  /** `life` counts down by `decay` per dispatch from `start` and the cell becomes the element `becomes` (a key) at 0. */
  life?: { start: number; decay: number; becomes: string };
  /** Optional WGSL rule run for cells of this element: the name of a file in `src/shaders/rules/`. */
  rule?: string;
  /** Optional color function of this element in the display shader: the name of an entry of `src/shaders/graphics.wgsl.ts`. */
  graphics?: string;
  /** Order in the toolbar (lowest first; the n-th button is selected by number key n); absent: not paintable. */
  toolbar?: number;
}

/**
 * A change of element at a temperature. The cell takes in (or gives out) `latent` heat, in MJ/m³ (the heat-capacity
 * unit × °C), at the threshold before it changes: while it does, its stored temperature runs past `temp` by up to
 * `latent` / the heat capacity of the element (the latent width) and its temperature stays at `temp`. The stored
 * temperature is bookkeeping while it does, so it may leave the range of `ABSOLUTE_ZERO` to `MAX_TEMP` (steam condensing
 * runs about 1,130 °C under 100 °C); only the temperature (`cellTemp`) stays inside it. 0 by default.
 */
export interface Transition {
  /** °C. */
  temp: number;
  /** The key of the element the cell becomes. */
  becomes: string;
  latent?: number;
  /**
   * Pressure the cell releases into its air cell when it passes this threshold, 0 or more; `above` only (a table with
   * one on a `below` is rejected). It is released when the cell changes by heat and, when the cell becomes FIRE, also when
   * it ignites by touching fire. Default 0. Dimensionless, like the air's pressure.
   */
  burst?: number;
}

/**
 * A change of element at a pressure (`ElementDef.pressureAbove`). The pressure comes from the row's `toughness`: a
 * hand-given pressure is rejected.
 */
export interface PressureTransition {
  /** The key of the element the cell becomes. */
  becomes: string;
}

export const DEFAULT_DRAG = 1 / 64;

// Pressure (dimensionless, like the air's) per MPa·√m of fracture toughness, anchored so that STONE's granite, 1.7, is
// the 0.45 that tests/air-crush.test.ts tuned: a gunpowder charge of about 50 cells crushes stone within about 15 cells.
export const STONE_TOUGHNESS = 1.7;
export const PRESSURE_PER_TOUGHNESS = 0.45 / STONE_TOUGHNESS;

/** The pressure above which a cell of this row crushes, or undefined when it has no `pressureAbove`. */
export function crushPressure(e: ElementDef): number | undefined {
  return e.pressureAbove && e.toughness !== undefined ? e.toughness * PRESSURE_PER_TOUGHNESS : undefined;
}

/** The most points of a liquid's density by temperature. */
export const DENSITY_KNOTS = 4;

/** The reference temperature of a gas's density with its default applied. */
export function elementDensityTemp(e: ElementDef): number {
  return e.densityTemp ?? ROOM_TEMP;
}

/** How a row's density follows its temperature: not at all (powders, solids, plasma), by knots (liquids), or by the ideal-gas law (gases, empty space). */
export function densityMode(e: ElementDef): 'constant' | 'knots' | 'gas' {
  if (e.state === 'gas' || e.state === 'empty') return 'gas';
  return e.densityKnots !== undefined ? 'knots' : 'constant';
}

/**
 * The density of a cell of this row at the temperature `temp` (°C): the knots of a liquid interpolated linearly and flat
 * outside them, a gas's density scaled by the ideal-gas law (inversely with the absolute temperature) from `density` at
 * `densityTemp`, and `density` for everything else. A cell's temperature is `cellTemp`, inside `ABSOLUTE_ZERO`..`MAX_TEMP`.
 * Mirrors `elDensityAt` in `src/shaders/elements.wgsl.ts`.
 */
export function densityAt(e: ElementDef, temp: number): number {
  const mode = densityMode(e);
  if (mode === 'gas') return (e.density * (elementDensityTemp(e) - ABSOLUTE_ZERO)) / Math.max(temp - ABSOLUTE_ZERO, 1);
  const knots = e.densityKnots;
  if (mode === 'constant' || !knots) return e.density;
  if (temp <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [t0, d0] = knots[i - 1];
    const [t1, d1] = knots[i];
    if (temp <= t1) return d0 + ((d1 - d0) * (temp - t0)) / (t1 - t0);
  }
  return knots[knots.length - 1][1];
}

/**
 * What the GPU reads of a row's density by temperature: `DENSITY_KNOTS` points of increasing temperature and their
 * densities, flat outside. A liquid's knots padded by repeating the last one a degree further on each time; a gas's
 * reference point first (the shader scales it by the ideal-gas law); a row with no curve is one flat point.
 */
export function densityProfile(e: ElementDef): { temps: number[]; densities: number[] } {
  const mode = densityMode(e);
  const points: [number, number][] = mode === 'knots' ? e.densityKnots!.map(([t, d]) => [t, d]) : [[mode === 'gas' ? elementDensityTemp(e) : 0, e.density]];
  while (points.length < DENSITY_KNOTS) {
    const [t, d] = points[points.length - 1];
    points.push([t + 1, d]);
  }
  return { temps: points.map(([t]) => t), densities: points.map(([, d]) => d) };
}

/** The gravity of a row with its default for the state applied. */
export function elementGravity(e: ElementDef): number {
  return e.gravity ?? (e.state === 'powder' || e.state === 'liquid' ? DEFAULT_GRAVITY : 0);
}

/** The conductivity of a row with its default applied. */
export function elementConductivity(e: ElementDef): number {
  return e.conductivity ?? 0;
}

/** The heat capacity of a row with its default applied. */
export function elementHeatCapacity(e: ElementDef): number {
  return e.heatCapacity ?? 1;
}

/**
 * Whether a cell of this element has a temperature that means something: it conducts heat or has a transition. Empty
 * space and walls do not; the `temp` word of such a cell is never read or changed by heat.
 */
export function elementHoldsHeat(e: ElementDef): boolean {
  return elementConductivity(e) > 0 || e.below !== undefined || e.above !== undefined;
}

/** The latent heat of a transition with its default applied. */
export function transitionLatent(t: Transition): number {
  return t.latent ?? 0;
}

/** The burst of a transition with its default applied. */
export function transitionBurst(t: Transition): number {
  return t.burst ?? 0;
}

/** How far past its threshold a cell of this element runs while it takes in or gives out the latent heat of `t`. */
export function latentWidth(e: ElementDef, t: Transition): number {
  return transitionLatent(t) / elementHeatCapacity(e);
}

/**
 * Whether a cell of this element never changes by itself: empty or solid, with no lifetime, no rule, no heat and no
 * pressure transition. A block of only such cells is a fixed point of every CA phase, so the CA skips it.
 */
export function elementInert(e: ElementDef): boolean {
  return (e.state === 'empty' || e.state === 'solid') && !e.life && e.rule === undefined && !elementHoldsHeat(e) && e.pressureAbove === undefined;
}

/** The drag of a row with its default applied. */
export function elementDrag(e: ElementDef): number {
  return e.drag ?? DEFAULT_DRAG;
}

/** The temperature of a row with its default applied. */
export function elementTemperature(e: ElementDef): number {
  return e.temperature ?? ROOM_TEMP;
}

// The table is a uniform array of this many rows, and the cell stores the ID in 8 bits.
export const MAX_ELEMENTS = 256;

// The pressure a cell of water releases when it flashes into steam (`Transition.burst`).
const WATER_BURST = 0.1;
// The pressure a cell of gunpowder releases as it burns.
const GUNPOWDER_BURST = 3;
// Heat a cell of lava gives out as it sets into stone, and stone takes in as it melts (see the LAVA row).
const LAVA_LATENT = 1200;
// Water's latent heats: 334 kJ/kg to freeze and 2,257 kJ/kg to boil, times water's 1,000 kg/m³ (the denser phase), in MJ/m³.
const WATER_FUSION = 334;
const WATER_VAPORIZATION = 2257;
// Iron's heat of fusion: 247 kJ/kg (13.8 kJ/mol) times solid iron's 7,870 kg/m³, in MJ/m³.
const IRON_FUSION = 1944;

// Conductivity (W/m·K), heat capacity (MJ/m³·K) and latent heat (MJ/m³) are physical data, the source named in each row's
// comment; the pace they give is in `heatShare` (`src/heat.ts`). A cell is one unit of matter whatever its state, so a gas
// row's capacity is its specific heat times its liquid's density, and a latent heat is per kilogram times the density of the
// denser phase. Empty space holds no heat itself: its temperature is its air cell's. Every row trades heat with its air cell at the
// air's surface coefficient (`AIR.surfaceCoefficient`), whatever the material.
export const ELEMENTS = [
  // Empty space is air: 1.2 kg/m³ at 20 °C, and its density at its air cell's temperature follows the ideal-gas law.
  { key: 'EMPTY', id: 0, label: 'Empty', color: [0.06, 0.06, 0.08], state: 'empty', density: 1.2 },
  // Dry sand: 0.27 W/m·K (0.25 to 0.35 for dry quartz sand) and 1.3 MJ/m³·K (1,600 kg/m³ at 0.8 kJ/kg·K).
  { key: 'SAND', id: 1, label: 'Sand', color: [0.80, 0.70, 0.48], state: 'powder', density: 1600, conductivity: 0.27, heatCapacity: 1.3, toolbar: 1 },
  // The engine's invincible wall and the world's edge, not a real material: it never conducts, so heat never leaves the world.
  { key: 'WALL', id: 2, label: 'Wall', color: [0.43, 0.45, 0.47], state: 'solid', density: 2500, toolbar: 6 },
  // Water: 0.6 W/m·K and 4.18 MJ/m³·K (4.18 kJ/kg·K at 1,000 kg/m³). Freezes and boils at the physical 0 and 100 °C, with the
  // latent heats above. Its density by temperature is the handbook's (999.84 kg/m³ at 0 °C, 999.97 at 4, 992.2 at 40, 958.4
  // at 100) at four points: densest at 4 °C, so a pond under a freezing ceiling stirs until it is 4 °C throughout.
  {
    key: 'WATER',
    id: 3,
    label: 'Water',
    color: [0.18, 0.42, 0.72],
    state: 'liquid',
    density: 1000,
    densityKnots: [[0, 999.8], [4, 1000], [40, 992.2], [100, 958.4]],
    conductivity: 0.6,
    heatCapacity: 4.18,
   
    below: { temp: 0, becomes: 'ICE', latent: WATER_FUSION },
    // The burst is a flash into steam pushing the air out; tuned in the M6.3c tests (tests/air-burst.test.ts): one cell
    // flashing barely stirs the air, a layer poured onto lava visibly pushes it.
    above: { temp: 100, becomes: 'STEAM', latent: WATER_VAPORIZATION, burst: WATER_BURST },
    toolbar: 2,
  },
  // A placeholder for every fire's smoke (backlog I16, M8.8f): a hot combustion gas, 0.04 W/m·K at a few hundred °C, with a
  // capacity of 1.0 MJ/m³·K as a stand-in per cell (1.1 kJ/kg·K times the ~900 kg/m³ of the oil it mostly comes from).
  { key: 'SMOKE', id: 4, label: 'Smoke', color: [0.72, 0.72, 0.74], state: 'gas', density: 0.6, conductivity: 0.04, heatCapacity: 1, toolbar: 5 },
  // Oil: 0.14 W/m·K (mineral oil 0.13 to 0.15) and 1.7 MJ/m³·K (1.9 kJ/kg·K at 900 kg/m³). It expands by about 7e-4 per K
  // (mineral oil 6.4e-4 to 7.5e-4): 900 kg/m³ at 20 °C, 775 at 250. Catches fire at 250 °C, which is
  // a stand-in for the flash point of a lamp oil, and burns on its own from there (no latent heat: the fire rule heats the
  // cell the next dispatch).
  {
    key: 'OIL',
    id: 5,
    label: 'Oil',
    color: [0.22, 0.16, 0.10],
    state: 'liquid',
    density: 900,
    densityKnots: [[20, 900], [250, 775]],
    flammable: true,
    conductivity: 0.14,
    heatCapacity: 1.7,
   
    above: { temp: 250, becomes: 'FIRE' },
    toolbar: 3,
  },
  {
    key: 'FIRE',
    id: 6,
    label: 'Fire',
    color: [1.0, 0.72, 0.12],
    state: 'plasma',
    density: 0.3,
    life: { start: 200, decay: 4, becomes: 'SMOKE' },
    // About the temperature of an open flame.
    temperature: 1000,
    // A placeholder, not a material: the gas of a flame conducts about 0.1 W/m·K (air at 1,000 °C: 0.07), and the fire rule
    // keeps the cell at the flame temperature whatever it gives away, so its capacity (1 as a stand-in per cell) only
    // sets how fast it heats a neighbor. It lights what it touches through `flammable`, not through this.
    conductivity: 0.1,
    heatCapacity: 1,
   
    rule: 'fire',
    graphics: 'fire',
    toolbar: 4,
  },
  // Steel-like metal, the best conductor of the table: 50 W/m·K (carbon steel 45 to 60; copper's 400 is eight times it) and
  // 3.5 MJ/m³·K (iron's 0.449 kJ/kg·K at 7,870 kg/m³). Melts at iron's 1,538 °C.
  {
    key: 'METAL',
    id: 7,
    label: 'Metal',
    color: [0.70, 0.74, 0.80],
    state: 'solid',
    density: 7870,
    conductivity: 50,
    heatCapacity: 3.5,
   
    above: { temp: 1538, becomes: 'MOLTEN_METAL', latent: IRON_FUSION },
    toolbar: 7,
  },
  // Granite-like stone: 2.5 W/m·K (granite 2 to 3.5) and 2.2 MJ/m³·K (0.82 kJ/kg·K at 2,700 kg/m³). Melts into lava at
  // 1,200 °C, taking rock's physical latent heat (see LAVA).
  {
    key: 'STONE',
    id: 8,
    label: 'Stone',
    color: [0.52, 0.46, 0.40],
    state: 'solid',
    density: 2700,
    conductivity: 2.5,
    heatCapacity: 2.2,
   
    above: { temp: 1200, becomes: 'LAVA', latent: LAVA_LATENT },
    // Crushed rock: a blast turns stone into sand, its stand-in, above the pressure that granite's fracture toughness (about
    // 1.7 MPa·√m) gives. It anchors the scale (`PRESSURE_PER_TOUGHNESS`), tuned in tests/air-crush.test.ts so that a
    // gunpowder charge of about 50 cells crushes the stone within about 15 cells.
    toughness: STONE_TOUGHNESS,
    pressureAbove: { becomes: 'SAND' },
    toolbar: 8,
  },
  // Ice: 917 kg/m³, 2.2 W/m·K and 1.9 MJ/m³·K (2.05 kJ/kg·K). Painted at -20 °C. It does not float: a solid never moves.
  {
    key: 'ICE',
    id: 9,
    label: 'Ice',
    color: [0.68, 0.86, 0.96],
    state: 'solid',
    density: 917,
    temperature: -20,
    conductivity: 2.2,
    heatCapacity: 1.9,
   
    above: { temp: 0, becomes: 'WATER', latent: WATER_FUSION },
    toolbar: 9,
  },
  // Steam: 0.59 kg/m³ at 100 °C (`densityTemp`; the ideal-gas law gives the rest). A cell is one unit of matter: its capacity is steam's 2.0 kJ/kg·K times the 1,000 kg/m³ of
  // the water it came from, 2.0 MJ/m³·K, and its conductivity keeps steam's real thermal diffusivity at that capacity:
  // 0.025 W/m·K / (0.59 kg/m³ × 2.0 kJ/kg·K) = 2.1e-5 m²/s, times 2.0 MJ/m³·K is 42 W/m·K. (Steam's own 0.025 would let
  // a cell of the water's mass out-stay a cold plate for minutes, where real steam gives its heat up within a second.)
  // Painted at 110 °C, just past its condensing point.
  {
    key: 'STEAM',
    id: 10,
    label: 'Steam',
    color: [0.84, 0.90, 0.97],
    state: 'gas',
    density: 0.59,
    densityTemp: 100,
    temperature: 110,
    conductivity: 42,
    heatCapacity: 2,
   
    below: { temp: 100, becomes: 'WATER', latent: WATER_VAPORIZATION },
    toolbar: 11,
  },
  // Lava is molten stone: liquid stone at 2,700 kg/m³, painted at 1,300 °C and setting at 1,200. Its latent heat is rock's
  // physical one: about 450 kJ/kg (basalt) at 2,700 kg/m³ is 1,200 MJ/m³. It is what keeps a pile of lava flowing in open
  // air for a while. Molten basalt conducts about 1 W/m·K and holds 4.0 MJ/m³·K (1.5 kJ/kg·K). One molten element per
  // meltable material (backlog I15). Molten silicate expands by about 4e-5 per K: 2,700 kg/m³ at 1,200 °C, 2,668 at 1,500.
  {
    key: 'LAVA',
    id: 11,
    label: 'Lava',
    color: [0.92, 0.32, 0.06],
    state: 'liquid',
    density: 2700,
    densityKnots: [[1200, 2700], [1500, 2668]],
    temperature: 1300,
    conductivity: 1,
    heatCapacity: 4,
   
    below: { temp: 1200, becomes: 'STONE', latent: LAVA_LATENT },
    toolbar: 10,
  },
  // Molten steel: 7,000 kg/m³, painted at 1,600 °C, sets back into METAL at 1,538. Liquid iron conducts about 35 W/m·K and
  // holds 5.7 MJ/m³·K (0.82 kJ/kg·K). Its density falls by about 0.83 kg/m³ per K from 7,000 at the melting point. Not paintable:
  // metal melts into it.
  {
    key: 'MOLTEN_METAL',
    id: 12,
    label: 'Molten metal',
    color: [1.0, 0.62, 0.28],
    state: 'liquid',
    density: 7000,
    densityKnots: [[1538, 7000], [1700, 6866]],
    temperature: 1600,
    conductivity: 35,
    heatCapacity: 5.7,
   
    below: { temp: 1538, becomes: 'METAL', latent: IRON_FUSION },
  },
  // Black powder: grains of 1.7 to 1.82 g/cm³ (safety data sheets; 1,700 kg/m³ here, so it sinks through sand and water),
  // catches fire at about 427 °C (the safety data sheets give 200 to 464 °C, ignition in 5 s at 427). Its conductivity and
  // capacity are estimates, not read from a source: a loose powder conducts like dry sand or a little less (0.2 W/m·K), and
  // a capacity of about 0.8 kJ/kg·K at 1,700 kg/m³ gives 1.4 MJ/m³·K. It burns into FIRE, by heat or by touching fire
  // (flammable), and releases `burst` into the air as each cell goes: a charge of about 50 cells is a blast that throws the
  // sand over it (tuned against the `explosion` scene, tests/air-burst.test.ts).
  {
    key: 'GUNPOWDER',
    id: 13,
    label: 'Gunpowder',
    color: [0.24, 0.24, 0.27],
    state: 'powder',
    density: 1700,
    flammable: true,
    conductivity: 0.2,
    heatCapacity: 1.4,
   
    above: { temp: 427, becomes: 'FIRE', burst: GUNPOWDER_BURST },
    toolbar: 12,
  },
] as const satisfies readonly ElementDef[];

/** The IDs of the default table by key: the only way code outside the table names an element. */
export const ELEMENT = Object.fromEntries(ELEMENTS.map((e) => [e.key, e.id])) as {
  readonly [E in (typeof ELEMENTS)[number] as E['key']]: E['id'];
};

// The generated shaders refer to these two by name (out-of-bounds cells are walls, the brush erases to empty).
const REQUIRED_KEYS = ['EMPTY', 'WALL'];

/** Throws when the table cannot drive the simulation; the message names the offending row. */
export function validateElements(elements: readonly ElementDef[]): void {
  const keys = new Set<string>();
  const ids = new Set<number>();
  for (const e of elements) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(e.key)) throw new Error(`element key "${e.key}" must be upper snake case`);
    if (!Number.isInteger(e.id) || e.id < 0 || e.id >= MAX_ELEMENTS) throw new Error(`element ${e.key}: id ${e.id} is not in 0..${MAX_ELEMENTS - 1}`);
    if (keys.has(e.key)) throw new Error(`element key ${e.key} appears twice`);
    if (ids.has(e.id)) throw new Error(`element ${e.key}: id ${e.id} is used twice`);
    keys.add(e.key);
    ids.add(e.id);
    if (!STATES.includes(e.state)) throw new Error(`element ${e.key}: unknown state "${e.state}"`);
    if (!Number.isFinite(e.density)) throw new Error(`element ${e.key}: density must be a number`);
    validateDensity(e);
    if (!(elementGravity(e) >= 0 && elementGravity(e) < Infinity)) throw new Error(`element ${e.key}: gravity must be a finite number, 0 or more`);
    if (!(elementConductivity(e) >= 0 && elementConductivity(e) < Infinity)) throw new Error(`element ${e.key}: conductivity must be a finite number, 0 or more`);
    if (!(elementHeatCapacity(e) > 0 && elementHeatCapacity(e) < Infinity)) throw new Error(`element ${e.key}: heatCapacity must be a finite number above 0`);
    if (!(elementDrag(e) >= 0 && elementDrag(e) < 1)) throw new Error(`element ${e.key}: drag must be at least 0 and below 1`);
    if (!(elementTemperature(e) >= ABSOLUTE_ZERO && elementTemperature(e) <= MAX_TEMP)) {
      throw new Error(`element ${e.key}: temperature must be a number in ${ABSOLUTE_ZERO}..${MAX_TEMP}`);
    }
    // Rule and graphics names become WGSL identifiers (`rule_<name>`).
    for (const name of [e.rule, e.graphics]) {
      if (name !== undefined && !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`element ${e.key}: "${name}" must be lower snake case`);
    }
  }
  for (const key of REQUIRED_KEYS) if (!keys.has(key)) throw new Error(`the table needs an element ${key}`);
  // Out-of-bounds cells are walls and the brush erases to empty: neither may move or be displaced.
  if (elementByKey(elements, 'EMPTY').state !== 'empty') throw new Error('EMPTY must have state empty');
  if (elementByKey(elements, 'WALL').state !== 'solid') throw new Error('WALL must have state solid');
  if (elements.find((e) => e.key === 'EMPTY')?.id !== 0) throw new Error('EMPTY must have id 0: a zeroed cell is empty');
  const positions = new Set<number>();
  for (const e of elements) {
    if (e.life) {
      if (!keys.has(e.life.becomes)) throw new Error(`element ${e.key}: life.becomes "${e.life.becomes}" is not in the table`);
      if (e.state === 'liquid') throw new Error(`element ${e.key}: a liquid keeps its direction in life, it cannot have a lifetime`);
      if (!Number.isInteger(e.life.start) || e.life.start <= 0 || !Number.isInteger(e.life.decay) || e.life.decay <= 0 || e.life.decay > 255) {
        throw new Error(`element ${e.key}: life.start and life.decay must be positive integers, decay at most 255`);
      }
    }
    if (e.toolbar !== undefined) {
      if (!Number.isInteger(e.toolbar) || e.toolbar < 1) throw new Error(`element ${e.key}: toolbar must be a positive integer`);
      if (positions.has(e.toolbar)) throw new Error(`element ${e.key}: toolbar position ${e.toolbar} is used twice`);
      positions.add(e.toolbar);
    }
  }
  if (elements.some((e) => e.flammable) && !keys.has('FIRE')) throw new Error('a flammable element needs a FIRE element to become');
  if (keys.has('FIRE') && !elements.find((e) => e.key === 'FIRE')?.life) throw new Error('FIRE needs a life: that is what a burning cell starts with');
  validateTransitions(elements);
}

// The density by temperature: knots on a liquid only, a reference temperature on a gas or empty space only, and a density
// that is a real, positive number wherever a temperature is divided into it.
function validateDensity(e: ElementDef): void {
  const name = `element ${e.key}`;
  if (e.densityKnots !== undefined) {
    const knots = e.densityKnots;
    if (e.state !== 'liquid') throw new Error(`${name}: densityKnots is only for a liquid`);
    if (knots.length < 1 || knots.length > DENSITY_KNOTS) throw new Error(`${name}: densityKnots needs 1 to ${DENSITY_KNOTS} points`);
    knots.forEach(([t, d], i) => {
      if (!(Number.isFinite(t) && t >= ABSOLUTE_ZERO && t <= MAX_TEMP)) throw new Error(`${name}: densityKnots[${i}] temperature must be a number in ${ABSOLUTE_ZERO}..${MAX_TEMP}`);
      if (!(Number.isFinite(d) && d > 0)) throw new Error(`${name}: densityKnots[${i}] density must be a finite number above 0`);
      if (i > 0 && !(t > knots[i - 1][0])) throw new Error(`${name}: densityKnots must increase in temperature`);
    });
    const [low, high] = [Math.min(...knots.map(([, d]) => d)), Math.max(...knots.map(([, d]) => d))];
    if (!(e.density >= low && e.density <= high)) throw new Error(`${name}: density ${e.density} must lie within its densityKnots (${low}..${high})`);
  }
  if (e.densityTemp !== undefined) {
    if (e.state !== 'gas' && e.state !== 'empty') throw new Error(`${name}: densityTemp is only for a gas or empty space`);
    if (!(Number.isFinite(e.densityTemp) && e.densityTemp > ABSOLUTE_ZERO && e.densityTemp <= MAX_TEMP)) throw new Error(`${name}: densityTemp must be a number in ${ABSOLUTE_ZERO}..${MAX_TEMP}, above absolute zero`);
  }
  if ((e.state === 'gas' || e.state === 'empty') && !(e.density > 0)) throw new Error(`${name}: the density of a gas must be above 0`);
}

// A threshold must be a number inside the range of temperatures with a target whose own range holds it, and no pair of
// transitions may undo itself on the next dispatch.
function validateTransitions(elements: readonly ElementDef[]): void {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const range = (e: ElementDef): [number, number] => [e.below?.temp ?? -Infinity, e.above?.temp ?? Infinity];
  for (const e of elements) {
    for (const side of ['below', 'above'] as const) {
      const t = e[side];
      if (!t) continue;
      const name = `element ${e.key}: ${side}`;
      const latent = transitionLatent(t);
      if (!(latent >= 0 && latent < Infinity)) throw new Error(`${name}.latent must be a finite number, 0 or more`);
      // The latent width may carry the stored temperature past ABSOLUTE_ZERO or MAX_TEMP: it is bookkeeping while the cell
      // takes in the heat, and only `cellTemp` (clamped to the threshold) is a temperature.
      if (!(t.temp >= ABSOLUTE_ZERO && t.temp <= MAX_TEMP)) throw new Error(`${name}.temp ${t.temp} must be a number in ${ABSOLUTE_ZERO}..${MAX_TEMP}`);
      if (t.burst !== undefined) {
        if (side === 'below') throw new Error(`${name}.burst is not allowed: only an above transition releases pressure`);
        if (!(t.burst >= 0 && t.burst < Infinity)) throw new Error(`${name}.burst must be a finite number, 0 or more`);
      }
      const target = byKey.get(t.becomes);
      if (!target) throw new Error(`${name}.becomes "${t.becomes}" is not in the table`);
      const [targetLow, targetHigh] = range(target);
      if (!(t.temp >= targetLow && t.temp <= targetHigh)) throw new Error(`${name}.temp ${t.temp} is outside the range ${targetLow}..${targetHigh} of ${target.key}`);
    }
    if (e.toughness !== undefined && !e.pressureAbove) throw new Error(`element ${e.key}: toughness is only for an element with a pressureAbove`);
    if (e.pressureAbove) {
      const p = e.pressureAbove;
      if ('pressure' in p) throw new Error(`element ${e.key}: pressureAbove.pressure is not allowed: the pressure comes from toughness`);
      if (!(e.toughness !== undefined && e.toughness > 0 && e.toughness < Infinity)) throw new Error(`element ${e.key}: toughness must be a finite number above 0 for an element with a pressureAbove`);
      if (!byKey.has(p.becomes)) throw new Error(`element ${e.key}: pressureAbove.becomes "${p.becomes}" is not in the table`);
      // A crush chain that returns to this element would retype its cell every dispatch above the limit.
      const seen = new Set<string>();
      for (let next = byKey.get(p.becomes); next && !seen.has(next.key); next = next.pressureAbove && byKey.get(next.pressureAbove.becomes)) {
        if (next === e) throw new Error(`element ${e.key}: pressureAbove.becomes "${p.becomes}" leads back to ${e.key}`);
        seen.add(next.key);
      }
    }
    if (e.below && e.above && !(e.below.temp < e.above.temp)) throw new Error(`element ${e.key}: below.temp must be under above.temp`);
    const [low, high] = range(e);
    if (!(elementTemperature(e) >= low && elementTemperature(e) <= high)) {
      throw new Error(`element ${e.key}: temperature ${elementTemperature(e)} is outside its own range ${low}..${high}`);
    }
  }
  // A pair that turns into each other must meet at one threshold and cost one latent heat each way, and the latent heat
  // must be above 0: without it a cell at the threshold would flip every dispatch.
  for (const a of elements) {
    const b = a.above && byKey.get(a.above.becomes);
    if (!a.above || !b || b.below?.becomes !== a.key) continue;
    if (a.above.temp !== b.below.temp || transitionLatent(a.above) !== transitionLatent(b.below)) {
      throw new Error(`element ${a.key}: above and the below of ${b.key} must share their temp and latent`);
    }
    if (!(transitionLatent(a.above) > 0)) throw new Error(`element ${a.key}: the pair with ${b.key} needs a latent above 0`);
  }
}

/** The row with this key; throws when the table has none. */
export function elementByKey(elements: readonly ElementDef[], key: string): ElementDef {
  const found = elements.find((e) => e.key === key);
  if (!found) throw new Error(`no element ${key}`);
  return found;
}
