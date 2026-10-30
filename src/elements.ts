import { ABSOLUTE_ZERO, MAX_TEMP, ROOM_TEMP } from './heat';
import { CELL_SIZE, DEFAULT_GRAVITY, MAX_REPOSE, MIN_REPOSE, slideSpeed, spreadSpeed } from './physics';
import { CATEGORIES, type Category } from './toolbar';

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
  /**
   * Dynamic viscosity in Pa·s, above 0. Liquids only. A liquid spreads sideways at the speed of a viscous layer
   * (`spreadSpeed`), at most one cell per dispatch: water (1e-3) is at the cap, a thick liquid creeps. Without it a liquid
   * spreads at the cap.
   */
  viscosity?: number;
  /**
   * Angle of repose in degrees, `MIN_REPOSE` to `MAX_REPOSE`: the slope a pile of this powder poured from a point stands
   * at (`slideSpeed`). Powders only. Without it a powder piles at `MAX_REPOSE`, the steepest the grid allows.
   */
  repose?: number;
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
  /** Position in its picker tab (lowest first; the n-th entry shown is selected by number key n); absent: not paintable. Unique within the `category`. */
  toolbar?: number;
  /** The picker tab that holds it. Required with `toolbar`. */
  category?: Category;
  /** One sentence for the picker's tooltip, in our own words. Required with `toolbar`. */
  description?: string;
  /** How the finished look draws the element, read by the display alone (`src/display-table.ts`); each value defaults by state. */
  look?: LookDef;
  /**
   * A molten element (liquid rock, liquid metal): its cells remember the element they set into in their ctype (`kind` bits
   * 16-23), written by the `above` that made them (`Transition.setsInto`). A cell with ctype k sets into k below k's `above`
   * temperature, by k's latent heat, and moves by k's density; one with ctype 0 sets into its own `below`. Needs a `below`.
   */
  molten?: true;
  /** What a molten cell that sets into this element is called, where "Molten <label>" is wrong (basalt's lava is "Lava"). CPU only, for `cellName`. */
  meltLabel?: string;
}

/** The display-only properties of a row (`ElementDef.look`). Every value is 0 to 1. */
export interface LookDef {
  /** Strength of the grain shading: the brightness change of the lightest and darkest variant, as a share of the color. Default by state (`LookSettings`): powders and solids only. */
  grain?: number;
  /** How much of the wall behind it the element hides: 1 for solids and powders, 0.35 for liquids, 0 for gases and fire. */
  opacity?: number;
  /**
   * The share of each color channel (red, green, blue) a liquid absorbs per cell of depth; liquids only, default none. A
   * liquid with some is drawn in the finished look with a tint that deepens with the depth above it; one without is drawn
   * flat.
   */
  absorption?: readonly [number, number, number];
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
  /**
   * The key of the element a cell that passes this `above` into a molten element sets back into once it cools: written as
   * the molten cell's ctype. Default: the row itself. That element needs an `above` into the same molten element, at this
   * temperature or below it; the molten cell sets by that `above`'s temperature and latent heat. Only on an `above` into a
   * molten element.
   */
  setsInto?: string;
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

// Pressure (dimensionless, like the air's) per MPa·√m of fracture toughness, anchored so that STONE's (basalt's) 1.7 is
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

/**
 * The chance per dispatch that a liquid cell of this row spreads sideways (or slides down a slope) when it could: its
 * viscous spreading speed in cells per dispatch capped at 1, which is also the value of a row with no viscosity.
 */
export function elementSpread(e: ElementDef): number {
  return e.viscosity === undefined ? 1 : Math.min(1, spreadSpeed(e.density, e.viscosity));
}

/** The speed in cells per dispatch a powder grain gets when it slides off a step: 0 for a row without a repose (it keeps its own speed, as at `MAX_REPOSE`). */
export function elementSlide(e: ElementDef): number {
  return e.repose === undefined ? 0 : slideSpeed(e.repose);
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
 * The row a molten cell of `e` with this ctype sets into: the ctype's row when `e` is molten and that row's `above` becomes
 * `e`; undefined for any other cell, which is what the GPU makes of an unknown ctype too (`kindMelt`).
 */
export function meltRow(table: readonly ElementDef[], e: ElementDef, ctype: number): ElementDef | undefined {
  if (!e.molten || ctype === 0) return undefined;
  const row = table.find((r) => r.id === ctype);
  return row?.above?.becomes === e.key ? row : undefined;
}

/**
 * What the pointer readout and the paint preview call a cell: a molten cell by what it sets into, the `meltLabel` of that
 * row ("Lava" for basalt) or else "Molten " and its label in lower case ("Molten glass"); with ctype 0 by the molten row's
 * `below`. Every other cell is its row's label.
 */
export function cellName(table: readonly ElementDef[], id: number, ctype = 0): string {
  const e = table.find((r) => r.id === id);
  if (!e) return '';
  if (!e.molten) return e.label;
  const sets = meltRow(table, e, ctype) ?? table.find((r) => r.key === e.below?.becomes);
  if (!sets) return e.label;
  return sets.meltLabel ?? `Molten ${sets.label.toLowerCase()}`;
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
// Silica's heat of fusion: 8.5 kJ/mol (quartz, CRC Handbook) over 60.08 g/mol is 141 kJ/kg; 148 kJ/kg for cristobalite. Glass has no
// sharp melting point of its own, so every row that melts into molten glass takes this one: 145 kJ/kg times glass's 2,500 kg/m³, in MJ/m³.
const GLASS_FUSION = 362;
// Aerogel is the same silica at 150 kg/m³: 145 kJ/kg times 150 kg/m³, 21.75 MJ/m³.
const AEROGEL_FUSION = 21.75;
// Heats of fusion in kJ/kg times the solid's density, in MJ/m³ (the heat-capacity unit × °C): aluminium 10.7 kJ/mol (397 kJ/kg), copper
// 13.0 kJ/mol (205), gold 12.55 kJ/mol (63.7), titanium 14.15 kJ/mol (295), tungsten 52.3 kJ/mol (285), alumina 111 kJ/mol (1,088; CRC Handbook).
const ALUMINIUM_FUSION = 1072;
const COPPER_FUSION = 1837;
const GOLD_FUSION = 1229;
const TITANIUM_FUSION = 1329;
const TUNGSTEN_FUSION = 5500;
const ALUMINA_FUSION = 4298;
// What the finished look adds to pure water's absorption on every channel, per metre (see the WATER row).
const WATER_TURBIDITY = 0.085;

// Conductivity (W/m·K), heat capacity (MJ/m³·K) and latent heat (MJ/m³) are physical data, the source named in each row's
// comment; the pace they give is in `heatShare` (`src/heat.ts`). A cell is one unit of matter whatever its state, so a gas
// row's capacity is its specific heat times its liquid's density, and a latent heat is per kilogram times the density of the
// denser phase. Empty space holds no heat itself: its temperature is its air cell's. Every row trades heat with its air cell at the
// air's surface coefficient (`AIR.surfaceCoefficient`), whatever the material.
export const ELEMENTS = [
  // Empty space is air: 1.2 kg/m³ at 20 °C, and its density at its air cell's temperature follows the ideal-gas law.
  { key: 'EMPTY', id: 0, label: 'Empty', color: [0.06, 0.06, 0.08], state: 'empty', density: 1.2 },
  // Dry sand: 0.27 W/m·K (0.25 to 0.35 for dry quartz sand) and 1.3 MJ/m³·K (1,600 kg/m³ at 0.8 kJ/kg·K).
  // Angle of repose 34° (dry sand 30 to 35°: Wikipedia's table 34°, Dartmouth's engineering notes 35° for dry irregular sand).
  // Quartz melts at 1,713 °C (cristobalite's melting point) into molten glass, which sets into glass.
  { key: 'SAND', id: 1, label: 'Sand', color: [0.80, 0.70, 0.48], state: 'powder', density: 1600, conductivity: 0.27, heatCapacity: 1.3, repose: 34,
    above: { temp: 1713, becomes: 'LAVA', latent: GLASS_FUSION, setsInto: 'GLASS' },
    toolbar: 1, category: 'Powders', description: 'Dry grains that fall and pile up into a slope.' },
  // The engine's invincible wall and the world's edge, not a real material: it never conducts, so heat never leaves the world.
  { key: 'WALL', id: 2, label: 'Wall', color: [0.43, 0.45, 0.47], state: 'solid', density: 2500,
    toolbar: 1, category: 'Solids', description: 'An indestructible barrier: it never moves and holds no heat.' },
  // Water: 0.6 W/m·K and 4.18 MJ/m³·K (4.18 kJ/kg·K at 1,000 kg/m³). Freezes and boils at the physical 0 and 100 °C, with the
  // latent heats above. Its density by temperature is the handbook's (999.84 kg/m³ at 0 °C, 999.97 at 4, 992.2 at 40, 958.4
  // at 100) at four points: densest at 4 °C, so a pond under a freezing ceiling stirs until it is 4 °C throughout. Viscosity
  // 1.0 mPa·s at 20 °C (1.002, handbook).
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
    viscosity: 0.001,
    // Its absorption of red, green and blue light (650, 550 and 450 nm) is Pope and Fry's (1997, pure water): 0.340, 0.0565 and
    // 0.00922 per metre, per cell of CELL_SIZE, plus `WATER_TURBIDITY` on every channel for the particles of natural water
    // (estimated and chosen by sight: pure water alone only loses its red and green and stays bright blue however deep, while
    // this turns deep water dark navy). Real water tints a pool a metre deep and barely 17 cm (128 cells), so the finished
    // look exaggerates the depth by `LOOK.depthScale`.
    look: {
      absorption: [(0.340 + WATER_TURBIDITY) * CELL_SIZE, (0.0565 + WATER_TURBIDITY) * CELL_SIZE, (0.00922 + WATER_TURBIDITY) * CELL_SIZE],
    },
    below: { temp: 0, becomes: 'ICE', latent: WATER_FUSION },
    // The burst is a flash into steam pushing the air out; tuned in the M6.3c tests (tests/air-burst.test.ts): one cell
    // flashing barely stirs the air, a layer poured onto lava visibly pushes it.
    above: { temp: 100, becomes: 'STEAM', latent: WATER_VAPORIZATION, burst: WATER_BURST },
    toolbar: 1,
    category: 'Liquids',
    description: 'Flows and levels out; freezes at 0 °C and boils at 100 °C.',
  },
  // Combustion gas, the smoke of every fire (backlog I16 keeps what burns and what it leaves). Air-like: the products of a
  // flame (nitrogen, carbon dioxide, steam) weigh about what air does at the same temperature, 1.2 kg/m³ at 20 °C, so it
  // rises only while it is hotter than the air around it (`densityAt`, the ideal-gas law) and spreads out once it has
  // cooled to it. Painted at 150 °C, a warm plume leaving a flame. Heat values are placeholders: 0.04 W/m·K (hot gas) and a
  // capacity of 1.0 MJ/m³·K as a stand-in per cell (1.1 kJ/kg·K times the ~900 kg/m³ of the oil it mostly comes from).
  { key: 'SMOKE', id: 4, label: 'Smoke', color: [0.72, 0.72, 0.74], state: 'gas', density: 1.2, temperature: 150, conductivity: 0.04, heatCapacity: 1,
    toolbar: 1, category: 'Gases', description: 'Gas from fires: it rises while it is warmer than the air, then spreads out.' },
  // Oil: 0.14 W/m·K (mineral oil 0.13 to 0.15) and 1.7 MJ/m³·K (1.9 kJ/kg·K at 900 kg/m³). It expands by about 7e-4 per K
  // (mineral oil 6.4e-4 to 7.5e-4): 900 kg/m³ at 20 °C, 775 at 250. Viscosity 0.2 Pa·s at 20 °C (motor oil SAE 10
  // to 30: 0.1 to 0.3; vegetable oil about 0.06). Catches fire at 250 °C, which is
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
    viscosity: 0.2,
    // Estimated, not read from a source: a brown oil absorbs blue most and red least, and is nearly opaque (it hides the wall
    // behind it at 0.9, against water's 0.35).
    look: { opacity: 0.9, absorption: [0.0001, 0.0002, 0.0004] },
    above: { temp: 250, becomes: 'FIRE' },
    toolbar: 2,
    category: 'Liquids',
    description: 'A thick liquid that floats on water and catches fire when hot.',
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
    toolbar: 1,
    category: 'Explosives',
    description: 'A flame: it lights what is flammable beside it, then fades into smoke.',
  },
  // Steel-like metal (the key stays METAL): 50 W/m·K (carbon steel 45 to 60; copper's 400 is eight times it) and
  // 3.5 MJ/m³·K (iron's 0.449 kJ/kg·K at 7,870 kg/m³). Melts at iron's 1,538 °C.
  {
    key: 'METAL',
    id: 7,
    label: 'Steel',
    color: [0.70, 0.74, 0.80],
    state: 'solid',
    density: 7870,
    conductivity: 50,
    heatCapacity: 3.5,
   
    above: { temp: 1538, becomes: 'MOLTEN_METAL', latent: IRON_FUSION },
    // A bright, smooth metal: a fainter grain than the solids' default (chosen so its luminance varies by 3 to 12 steps).
    look: { grain: 0.02 },
    toolbar: 1,
    category: 'Metals',
    description: 'Steel: it carries heat well and melts only at very high temperatures.',
  },
  // Basalt, the rock lava really cools into (and the one LAVA's numbers describe): 2,900 kg/m³ (the average of basalt,
  // 2.9 g/cm³, Wikipedia "Basalt"; granite's 2.7), 2.0 W/m·K (the mean of the 1962 to 1986 measurements, 1.96, Natural Resources
  // Canada's geothermal service report) and 2.4 MJ/m³·K (0.82 kJ/kg·K, measured on basalt glass at 40 °C, Wang et al., PMC7409246,
  // rising with temperature: the table keeps one value). Melts into lava at 1,200 °C, the liquidus of basalt ("near or above
  // 1200 °C", Wikipedia "Basalt") and LAVA's setting point, taking rock's physical latent heat (see LAVA).
  {
    key: 'STONE',
    id: 8,
    label: 'Basalt',
    color: [0.52, 0.46, 0.40],
    state: 'solid',
    density: 2900,
    conductivity: 2,
    heatCapacity: 2.4,
    above: { temp: 1200, becomes: 'LAVA', latent: LAVA_LATENT },
    // Basalt's melt is what LAVA is: any molten cell that sets into basalt is called "Lava".
    meltLabel: 'Lava',
    // Crushed rock: a blast turns basalt into gravel above the pressure its fracture toughness gives. 1.7 MPa·√m is the scale's
    // anchor (`PRESSURE_PER_TOUGHNESS`), inside the 1.4 to 3.8 measured on igneous rocks at pressure (basalt in the open air
    // reads 0.6 to 1.3, porosity lowering it); tuned in tests/air-crush.test.ts so that a gunpowder charge of about 50 cells
    // crushes the basalt within about 15 cells.
    toughness: STONE_TOUGHNESS,
    pressureAbove: { becomes: 'GRAVEL' },
    toolbar: 2,
    category: 'Solids',
    description: 'Heavy volcanic rock that melts into lava when very hot and breaks into gravel in a blast.',
  },
  // Ice: 917 kg/m³, 2.2 W/m·K and 1.9 MJ/m³·K (2.05 kJ/kg·K). No button: Water painted below 0 °C is ice (`paintTarget`), at -20 °C by default. It does not float: a solid never moves.
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
    // Ice is brittle: 0.1 MPa·√m, the low end of the range measured on ice (0.1 to 0.3 for shelf ice below freezing, Rist et al.
    // 2002; 0.155 at zero porosity, Rist et al. 1999; read from search abstracts, not the papers), a seventh of glass's. Low
    // enough that a steam burst or boiling pressure breaks ice into snow, on purpose: ice is the most brittle solid of the table.
    // A blast breaks it into snow.
    toughness: 0.1,
    pressureAbove: { becomes: 'SNOW' },
  },
  // Steam: 0.59 kg/m³ at 100 °C (`densityTemp`; the ideal-gas law gives the rest). A cell is one unit of matter: its capacity is steam's 2.0 kJ/kg·K times the 1,000 kg/m³ of
  // the water it came from, 2.0 MJ/m³·K, and its conductivity keeps steam's real thermal diffusivity at that capacity:
  // 0.025 W/m·K / (0.59 kg/m³ × 2.0 kJ/kg·K) = 2.1e-5 m²/s, times 2.0 MJ/m³·K is 42 W/m·K. (Steam's own 0.025 would let
  // a cell of the water's mass out-stay a cold plate for minutes, where real steam gives its heat up within a second.)
  // No button: Water painted above 100 °C is steam, at 110 °C by default, just past its condensing point.
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
  },
  // Lava is molten stone: liquid stone at 2,700 kg/m³, painted at 1,300 °C and setting at 1,200. Its latent heat is rock's
  // physical one: about 450 kJ/kg (basalt) at 2,700 kg/m³ is 1,200 MJ/m³. It is what keeps a pile of lava flowing in open
  // air for a while. Molten basalt conducts about 1 W/m·K and holds 4.0 MJ/m³·K (1.5 kJ/kg·K). It is the molten element of
  // the rocks: a cell remembers what it melted from (its ctype) and sets back into that. Molten silicate expands by about 4e-5 per K: 2,700 kg/m³ at 1,200 °C, 2,668 at 1,500.
  // Viscosity 30 Pa·s, the middle of basaltic lava at eruption temperatures (10 to 100 Pa·s). No button: Stone painted above 1,200 °C
  // is lava, at 1,300 °C by default.
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
    viscosity: 30,
    // Opaque: it hides the wall and casts a shadow like rock, and it shines on its own, so it takes no depth tint.
    look: { opacity: 1 },
    molten: true,
    graphics: 'molten',
    below: { temp: 1200, becomes: 'STONE', latent: LAVA_LATENT },
  },
  // Molten steel: 7,000 kg/m³, painted at 1,600 °C, sets back into METAL at 1,538. Liquid iron conducts about 35 W/m·K and
  // holds 5.7 MJ/m³·K (0.82 kJ/kg·K). Its density falls by about 0.83 kg/m³ per K from 7,000 at the melting point. Viscosity
  // 6 mPa·s (liquid iron, 5 to 7 mPa·s near its melting point). No button: Metal painted above 1,538 °C is molten steel, at 1,600 °C by default.
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
    viscosity: 0.006,
    look: { opacity: 1 },
    molten: true,
    graphics: 'molten',
    below: { temp: 1538, becomes: 'METAL', latent: IRON_FUSION },
  },
  // Black powder: grains of 1.7 to 1.82 g/cm³ (safety data sheets; 1,700 kg/m³ here, so it sinks through sand and water),
  // catches fire at about 427 °C (the safety data sheets give 200 to 464 °C, ignition in 5 s at 427). Its conductivity and
  // capacity are estimates, not read from a source: a loose powder conducts like dry sand or a little less (0.2 W/m·K), and
  // a capacity of about 0.8 kJ/kg·K at 1,700 kg/m³ gives 1.4 MJ/m³·K. It burns into FIRE, by heat or by touching fire
  // (flammable), and releases `burst` into the air as each cell goes: a charge of about 50 cells is a blast that throws the
  // sand over it (tuned against the `explosion` scene, tests/air-burst.test.ts).
  // Angle of repose 30°: an estimate, not read from a source (glazed, rounded grains flow freely, like dry sand's 30 to 35°).
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
    repose: 30,
   
    above: { temp: 427, becomes: 'FIRE', burst: GUNPOWDER_BURST },
    // A dark powder: the same share of a dark color is too few steps to see, so its grain is stronger than the powders' default.
    look: { grain: 0.25 },
    toolbar: 2,
    category: 'Explosives',
    description: 'Black powder: it catches fire when hot and goes off with a blast.',
  },
  // Gravel: crushed basalt (what a blast leaves of basalt and brick). Loose dry gravel weighs 1,500 to 1,900 kg/m³ (1,800 here).
  // A cell is one unit of matter whatever its form, so a crushed cell keeps its parent's heat capacity, basalt's 2.4 MJ/m³·K
  // (a crush then keeps the temperature and the latent heats match); a loose dry bed of coarse stones conducts only about 0.4 W/m·K
  // (estimated, not read from a source). Angle of repose 38°: estimated, angular crushed stone stands at 35 to 45°. It melts into the same lava as basalt,
  // which sets into basalt, with basalt's melting point and latent heat.
  {
    key: 'GRAVEL',
    id: 14,
    label: 'Gravel',
    color: [0.45, 0.43, 0.41],
    state: 'powder',
    density: 1800,
    conductivity: 0.4,
    heatCapacity: 2.4,
    repose: 38,
    above: { temp: 1200, becomes: 'LAVA', latent: LAVA_LATENT, setsInto: 'STONE' },
    toolbar: 2,
    category: 'Powders',
    description: 'Loose broken rock: a blast leaves it where basalt and brick were; it melts into lava.',
  },
  // Snow: what a blast leaves of ice. Settled snow weighs 200 to 500 kg/m³ (300 here); a cell is one unit of matter, so it keeps
  // ice's heat capacity, 1.9 MJ/m³·K; the bed conducts only about 0.15 W/m·K (0.1 to 0.5 for settled snow, Sturm et al. 1997). It melts at 0 °C into water, with water's
  // latent heat. Painted at -10 °C, the cold it was made at.
  {
    key: 'SNOW',
    id: 15,
    label: 'Snow',
    color: [0.82, 0.86, 0.90],
    state: 'powder',
    density: 300,
    temperature: -10,
    conductivity: 0.15,
    heatCapacity: 1.9,
    repose: 40,
    above: { temp: 0, becomes: 'WATER', latent: WATER_FUSION },
    toolbar: 3,
    category: 'Powders',
    description: 'Light ice crystals: they pile up, and melt into water at 0 °C.',
  },
  // Broken glass (cullet): what a blast leaves of glass. Loose cullet weighs about 1,400 kg/m³ and, a cell being one unit of matter,
  // keeps glass's heat capacity, 2.1 MJ/m³·K; a loose bed of shards conducts about 0.3 W/m·K and stands at about 38° (both estimated,
  // not read from a source).
  // It melts into the molten glass that glass does, at glass's temperature and latent heat.
  {
    key: 'BROKEN_GLASS',
    id: 16,
    label: 'Broken glass',
    color: [0.62, 0.82, 0.84],
    state: 'powder',
    density: 1400,
    conductivity: 0.3,
    heatCapacity: 2.1,
    repose: 38,
    above: { temp: 1400, becomes: 'LAVA', latent: GLASS_FUSION, setsInto: 'GLASS' },
    toolbar: 4,
    category: 'Powders',
    description: 'Sharp glass shards: a blast leaves them where glass was; they melt into glass.',
  },
  // Soda-lime glass: 2,500 kg/m³, 1.0 W/m·K (window glass 0.8 to 1.0) and 2.1 MJ/m³·K (0.84 kJ/kg·K). Fracture toughness 0.74
  // MPa·√m (soda-lime-silica glass in mode I), so a blast breaks it a good deal farther out than basalt. Real glass softens
  // over a range with no sharp melting point; the table melts it at 1,400 °C, the melting range of a furnace (1,400 to 1,500),
  // into the molten glass (LAVA) that sand makes at 1,713 °C, and takes silica's latent heat. Transparent: the finished look draws it over the wall behind it at opacity 0.4 (a lighter shadow too) and it has hardly any grain.
  {
    key: 'GLASS',
    id: 17,
    label: 'Glass',
    color: [0.55, 0.80, 0.82],
    state: 'solid',
    density: 2500,
    conductivity: 1,
    heatCapacity: 2.1,
    above: { temp: 1400, becomes: 'LAVA', latent: GLASS_FUSION },
    toughness: 0.74,
    pressureAbove: { becomes: 'BROKEN_GLASS' },
    look: { opacity: 0.4, grain: 0.01 },
    toolbar: 3,
    category: 'Solids',
    description: 'Clear, brittle and hard: a blast shatters it; it melts into glass when very hot, and sand does too.',
  },
  // Fired clay brick: 1,900 kg/m³ (common brick 1,800 to 2,000), 0.7 W/m·K (0.6 to 1.0) and 1.6 MJ/m³·K (0.84 kJ/kg·K). Its
  // toughness is 1.0 MPa·√m, estimated (not read from a source: fired clay is brittle, concrete reads 0.2 to 1.4). It has no melting
  // point in the table: fired clay holds past 1,600 °C, beyond what lava reaches.
  {
    key: 'BRICK',
    id: 18,
    label: 'Brick',
    color: [0.62, 0.27, 0.18],
    state: 'solid',
    density: 1900,
    conductivity: 0.7,
    heatCapacity: 1.6,
    toughness: 1,
    pressureAbove: { becomes: 'GRAVEL' },
    toolbar: 4,
    category: 'Solids',
    description: 'Fired clay: it shrugs off lava and breaks into gravel in a blast.',
  },
  // Aluminium: 2,700 kg/m³, 237 W/m·K and 2.42 MJ/m³·K (0.897 kJ/kg·K), melting at 660.3 °C (CRC Handbook; Wikipedia, List of
  // thermal conductivities). Melts into molten metal that sets back into aluminium, far below steel's 1,538 °C.
  {
    key: 'ALUMINIUM',
    id: 19,
    label: 'Aluminium',
    color: [0.78, 0.80, 0.83],
    state: 'solid',
    density: 2700,
    conductivity: 237,
    heatCapacity: 2.42,
    above: { temp: 660, becomes: 'MOLTEN_METAL', latent: ALUMINIUM_FUSION },
    look: { grain: 0.02 },
    toolbar: 2,
    category: 'Metals',
    description: 'Light silvery metal: it carries heat almost as well as copper and melts at 660 °C.',
  },
  // Copper: 8,960 kg/m³, 401 W/m·K and 3.45 MJ/m³·K (0.385 kJ/kg·K), melting at 1,084.6 °C (CRC Handbook).
  {
    key: 'COPPER',
    id: 20,
    label: 'Copper',
    color: [0.80, 0.38, 0.20],
    state: 'solid',
    density: 8960,
    conductivity: 401,
    heatCapacity: 3.45,
    above: { temp: 1085, becomes: 'MOLTEN_METAL', latent: COPPER_FUSION },
    look: { grain: 0.02 },
    toolbar: 3,
    category: 'Metals',
    description: 'Reddish metal that carries heat about eight times better than steel and melts at 1,085 °C.',
  },
  // Gold: 19,300 kg/m³, 318 W/m·K and 2.49 MJ/m³·K (0.129 kJ/kg·K), melting at 1,064.2 °C (CRC Handbook). As dense as tungsten, nearly
  // three times as dense as steel: a molten cell of it sinks under molten steel.
  {
    key: 'GOLD',
    id: 21,
    label: 'Gold',
    color: [0.95, 0.72, 0.15],
    state: 'solid',
    density: 19300,
    conductivity: 318,
    heatCapacity: 2.49,
    above: { temp: 1064, becomes: 'MOLTEN_METAL', latent: GOLD_FUSION },
    look: { grain: 0.02 },
    toolbar: 4,
    category: 'Metals',
    description: 'Very heavy yellow metal that carries heat well and melts at 1,064 °C; molten, it sinks under molten steel.',
  },
  // Titanium: 4,506 kg/m³, 21.9 W/m·K and 2.36 MJ/m³·K (0.523 kJ/kg·K), melting at 1,668 °C (CRC Handbook; a poorer conductor than steel).
  {
    key: 'TITANIUM',
    id: 22,
    label: 'Titanium',
    color: [0.55, 0.57, 0.62],
    state: 'solid',
    density: 4506,
    conductivity: 21.9,
    heatCapacity: 2.36,
    above: { temp: 1668, becomes: 'MOLTEN_METAL', latent: TITANIUM_FUSION },
    look: { grain: 0.02 },
    toolbar: 5,
    category: 'Metals',
    description: 'Strong, light metal that carries heat worse than steel and melts at 1,668 °C.',
  },
  // Tungsten: 19,300 kg/m³, 173 W/m·K and 2.55 MJ/m³·K (0.132 kJ/kg·K), melting at 3,422 °C (CRC Handbook), the highest of any metal.
  {
    key: 'TUNGSTEN',
    id: 23,
    label: 'Tungsten',
    color: [0.36, 0.37, 0.40],
    state: 'solid',
    density: 19300,
    conductivity: 173,
    heatCapacity: 2.55,
    above: { temp: 3422, becomes: 'MOLTEN_METAL', latent: TUNGSTEN_FUSION },
    look: { grain: 0.02 },
    toolbar: 6,
    category: 'Metals',
    description: 'Dark, very heavy metal that melts only at 3,422 °C, higher than any other metal.',
  },
  // Ceramic: alumina, the crucible ceramic: 3,950 kg/m³, 30 W/m·K (99.5% alumina at room temperature, 25 to 35; it falls with
  // heat) and 3.48 MJ/m³·K (0.88 kJ/kg·K), melting at 2,072 °C (CRC Handbook) into molten ceramic that sets back, far above steel's
  // melt. It has no crush: a blast does not break it (its cracking by thermal shock is M8.1k's).
  {
    key: 'CERAMIC',
    id: 24,
    label: 'Ceramic',
    color: [0.88, 0.85, 0.78],
    state: 'solid',
    density: 3950,
    conductivity: 30,
    heatCapacity: 3.48,
    above: { temp: 2072, becomes: 'LAVA', latent: ALUMINA_FUSION },
    toolbar: 5,
    category: 'Solids',
    description: 'Fired alumina, as in a crucible: it holds molten steel and no blast breaks it.',
  },
  // Diamond: 3,510 kg/m³, 2,200 W/m·K (type IIa; 1,000 to 2,200) and 1.79 MJ/m³·K (0.509 kJ/kg·K): the best conductor there is. The
  // game's conduction caps a pair's exchange at their mean (`heatShare`), which this row reaches: heat crosses it as fast as the
  // grid allows, about four times copper's pace. It mimics no real material in never melting or crushing (the real one turns to
  // graphite or burns at 700 to 1,500 °C in air and melts only under pressure).
  {
    key: 'DIAMOND',
    id: 25,
    label: 'Diamond',
    color: [0.74, 0.92, 0.98],
    state: 'solid',
    density: 3510,
    conductivity: 2200,
    heatCapacity: 1.79,
    toolbar: 6,
    category: 'Solids',
    description: 'The hardest and best heat-conducting solid: it never melts or breaks here.',
  },
  // Silica aerogel, the best insulator that lasts at lava's temperature: 150 kg/m³ (blankets 120 to 200, an estimate), 0.015 W/m·K
  // (0.013 to 0.020 at room temperature, handbook; mineral wool's 0.04 is too poor a barrier for one cell between lava and water,
  // see the insulationWall scenario) and 0.15 MJ/m³·K (about 1.0 kJ/kg·K at that density, an estimate), the bulk of the blanket as one
  // solid. It is amorphous silica: it melts at quartz's 1,713 °C, well over lava's temperature, taking silica's 145 kJ/kg (see
  // `GLASS_FUSION`) times its own 150 kg/m³, 22 MJ/m³ (`AEROGEL_FUSION`), not the glass row's. The molten cell keeps the aerogel's
  // ctype and sets back into aerogel, giving out the latent heat it took in (setting into glass would give out glass's 362).
  {
    key: 'INSULATION',
    id: 26,
    label: 'Aerogel',
    color: [0.90, 0.80, 0.42],
    state: 'solid',
    density: 150,
    conductivity: 0.015,
    heatCapacity: 0.15,
    above: { temp: 1713, becomes: 'LAVA', latent: AEROGEL_FUSION },
    toolbar: 7,
    category: 'Solids',
    description: 'Aerogel, a silica foam: heat passes through it far worse than through stone, and it melts only above the temperature of lava.',
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
    if (e.viscosity !== undefined) {
      if (e.state !== 'liquid') throw new Error(`element ${e.key}: viscosity is only for a liquid`);
      if (!(Number.isFinite(e.viscosity) && e.viscosity > 0)) throw new Error(`element ${e.key}: viscosity must be a finite number above 0`);
    }
    if (e.repose !== undefined) {
      if (e.state !== 'powder') throw new Error(`element ${e.key}: repose is only for a powder`);
      if (!(e.repose >= MIN_REPOSE && e.repose <= MAX_REPOSE)) throw new Error(`element ${e.key}: repose must be a number in ${MIN_REPOSE}..${MAX_REPOSE}`);
    }
    if (!(elementGravity(e) >= 0 && elementGravity(e) < Infinity)) throw new Error(`element ${e.key}: gravity must be a finite number, 0 or more`);
    if (!(elementConductivity(e) >= 0 && elementConductivity(e) < Infinity)) throw new Error(`element ${e.key}: conductivity must be a finite number, 0 or more`);
    if (!(elementHeatCapacity(e) > 0 && elementHeatCapacity(e) < Infinity)) throw new Error(`element ${e.key}: heatCapacity must be a finite number above 0`);
    if (!(elementDrag(e) >= 0 && elementDrag(e) < 1)) throw new Error(`element ${e.key}: drag must be at least 0 and below 1`);
    if (!(elementTemperature(e) >= ABSOLUTE_ZERO && elementTemperature(e) <= MAX_TEMP)) {
      throw new Error(`element ${e.key}: temperature must be a number in ${ABSOLUTE_ZERO}..${MAX_TEMP}`);
    }
    if (e.look !== undefined) validateLook(e, e.look);
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
  const positions = new Set<string>();
  for (const e of elements) {
    if (e.life) {
      if (!keys.has(e.life.becomes)) throw new Error(`element ${e.key}: life.becomes "${e.life.becomes}" is not in the table`);
      if (e.state === 'liquid') throw new Error(`element ${e.key}: a liquid keeps its direction in life, it cannot have a lifetime`);
      if (!Number.isInteger(e.life.start) || e.life.start <= 0 || !Number.isInteger(e.life.decay) || e.life.decay <= 0 || e.life.decay > 255) {
        throw new Error(`element ${e.key}: life.start and life.decay must be positive integers, decay at most 255`);
      }
    }
    if (e.category !== undefined && !CATEGORIES.includes(e.category)) {
      throw new Error(`element ${e.key}: category "${e.category}" is not one of ${CATEGORIES.join(', ')}`);
    }
    if (e.toolbar !== undefined) {
      if (!Number.isInteger(e.toolbar) || e.toolbar < 1) throw new Error(`element ${e.key}: toolbar must be a positive integer`);
      if (e.category === undefined) throw new Error(`element ${e.key}: a paintable element needs a category from ${CATEGORIES.join(', ')}`);
      if (e.description === undefined || e.description.trim() === '') throw new Error(`element ${e.key}: a paintable element needs a description`);
      const slot = `${e.category}:${e.toolbar}`;
      if (positions.has(slot)) throw new Error(`element ${e.key}: toolbar position ${e.toolbar} is used twice in ${e.category}`);
      positions.add(slot);
    }
  }
  if (elements.some((e) => e.flammable) && !keys.has('FIRE')) throw new Error('a flammable element needs a FIRE element to become');
  if (keys.has('FIRE') && !elements.find((e) => e.key === 'FIRE')?.life) throw new Error('FIRE needs a life: that is what a burning cell starts with');
  validateTransitions(elements);
}

// The display-only values are shares from 0 to 1, and absorption belongs to a liquid.
function validateLook(e: ElementDef, look: LookDef): void {
  const share = (name: string, value: number): void => {
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error(`element ${e.key}: look.${name} must be a number in 0..1`);
  };
  if (look.grain !== undefined) share('grain', look.grain);
  if (look.opacity !== undefined) share('opacity', look.opacity);
  if (look.absorption !== undefined) {
    if (e.state !== 'liquid') throw new Error(`element ${e.key}: look.absorption is only for a liquid`);
    look.absorption.forEach((value, i) => share(`absorption[${i}]`, value));
  }
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
      if (t.setsInto !== undefined && !(side === 'above' && target.molten)) throw new Error(`${name}.setsInto is only for an above into a molten element`);
      if (side === 'above' && target.molten) {
        // A cell melting into a molten element sets back into `setsInto` (default: this row) by that row's own `above`, which
        // must lead into the same molten element, and it is molten from this threshold up: that must not lie under the one
        // it sets by, or the molten cell would be past its own setting point at once.
        const sets = byKey.get(t.setsInto ?? e.key);
        if (!sets) throw new Error(`${name}.setsInto "${t.setsInto}" is not in the table`);
        if (sets.above?.becomes !== t.becomes) throw new Error(`${name}: ${sets.key} (setsInto) needs an above into ${t.becomes}`);
        if (!(t.temp >= sets.above.temp)) throw new Error(`${name}.temp ${t.temp} is under the ${sets.above.temp} of ${sets.key}, which the molten cell sets by`);
        if (target.above && !(t.temp <= target.above.temp)) throw new Error(`${name}.temp ${t.temp} is over the ${target.above.temp} of ${target.key}`);
        continue;
      }
      const [targetLow, targetHigh] = range(target);
      if (!(t.temp >= targetLow && t.temp <= targetHigh)) throw new Error(`${name}.temp ${t.temp} is outside the range ${targetLow}..${targetHigh} of ${target.key}`);
    }
    if (e.molten && !e.below) throw new Error(`element ${e.key}: a molten element needs a below: what a cell with no ctype sets into`);
    if (e.meltLabel !== undefined && e.meltLabel.trim() === '') throw new Error(`element ${e.key}: meltLabel must not be empty`);
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
