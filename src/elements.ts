import { ABSOLUTE_ZERO, MAX_TEMP, ROOM_TEMP } from './heat';

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
  /** kg/m³ from physical data or our own tuning. A heavier falling cell displaces a lighter one; a gas rises through a heavier liquid. */
  density: number;
  /** Downward acceleration in cells per dispatch² of a powder or liquid; default `DEFAULT_GRAVITY` for those states, 0 for the others. Gases rise at a fixed speed and ignore it. */
  gravity?: number;
  /** Share of its velocity a flying cell of this element loses per dispatch; default `DEFAULT_DRAG`. */
  drag?: number;
  /** Becomes fire when a fire cell is in its block. */
  flammable?: boolean;
  /** °C a painted cell starts at, and a cell of a scene loaded without temperatures; default `ROOM_TEMP`. */
  temperature?: number;
  /** Share of the temperature difference to a neighbor that evens out per exchange, 0 to 1; default 0 (holds no heat unless it has a transition). Two cells exchange at the harmonic mean of their conductivities, 0 when either is 0. */
  conductivity?: number;
  /** Heat per °C of one cell, above 0; default 1. A cell of a high capacity changes temperature less for the same heat. */
  heatCapacity?: number;
  /** Becomes the element `becomes` (a key) when its stored temperature drops below `temp` minus the latent width. */
  below?: Transition;
  /** Becomes the element `becomes` (a key) when its stored temperature rises above `temp` plus the latent width. */
  above?: Transition;
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
 * A change of element at a temperature. The cell takes in (or gives out) `latent` heat, in heat-capacity × °C units, at
 * the threshold before it changes: while it does, its stored temperature runs past `temp` by up to `latent` / the heat
 * capacity of the element (the latent width) and its temperature stays at `temp`. 0 by default.
 */
export interface Transition {
  /** °C. */
  temp: number;
  /** The key of the element the cell becomes. */
  becomes: string;
  latent?: number;
}

// A grain reaches the CA's top speed (1 cell per dispatch) after falling 16 cells.
export const DEFAULT_GRAVITY = 1 / 32;
export const DEFAULT_DRAG = 1 / 64;

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

/** How far past its threshold a cell of this element runs while it takes in or gives out the latent heat of `t`. */
export function latentWidth(e: ElementDef, t: Transition): number {
  return transitionLatent(t) / elementHeatCapacity(e);
}

/**
 * Whether a cell of this element never changes by itself: empty or solid, with no lifetime, no rule and no heat. A block
 * of only such cells is a fixed point of every CA phase, so the CA skips it.
 */
export function elementInert(e: ElementDef): boolean {
  return (e.state === 'empty' || e.state === 'solid') && !e.life && e.rule === undefined && !elementHoldsHeat(e);
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

// Conductivity and heat capacity are tuning grounded in physical ranks, not physical units: a cell is one unit of matter
// whatever its state, so the capacity is per cell and the conductivity a share per exchange. Empty space holds no heat
// until M6 gives it an air temperature.
export const ELEMENTS = [
  { key: 'EMPTY', id: 0, label: 'Empty', color: [0.06, 0.06, 0.08], state: 'empty', density: 1.2 },
  // Dry sand conducts poorly (about 0.3 W/m·K, rank 0.05); capacity from its volumetric 1.3 MJ/m³·K.
  { key: 'SAND', id: 1, label: 'Sand', color: [0.80, 0.70, 0.48], state: 'powder', density: 1600, conductivity: 0.05, heatCapacity: 1.3, toolbar: 1 },
  // The engine's invincible wall and the world's edge, not a real material: it never conducts, so heat never leaves the world.
  { key: 'WALL', id: 2, label: 'Wall', color: [0.43, 0.45, 0.47], state: 'solid', density: 2500, toolbar: 6 },
  // Water conducts 0.6 W/m·K, which ranks 0.1; it gets 0.3 to stand in for the convection a resting CA liquid does not
  // have. Capacity 4.2 from its 4.2 MJ/m³·K, the highest of the table. Freezes and boils at the physical 0 and 100 °C;
  // the latent heats are starting values, tuned with the scenes.
  {
    key: 'WATER',
    id: 3,
    label: 'Water',
    color: [0.18, 0.42, 0.72],
    state: 'liquid',
    density: 1000,
    conductivity: 0.3,
    heatCapacity: 4.2,
    below: { temp: 0, becomes: 'ICE', latent: 300 },
    above: { temp: 100, becomes: 'STEAM', latent: 400 },
    toolbar: 2,
  },
  // A placeholder for every fire's smoke (backlog I16): stand-in heat values, not tuned.
  { key: 'SMOKE', id: 4, label: 'Smoke', color: [0.72, 0.72, 0.74], state: 'gas', density: 0.6, conductivity: 0.05, heatCapacity: 1, toolbar: 5 },
  // Oil: 0.14 W/m·K (rank 0.1) and 1.7 MJ/m³·K. Catches fire at 250 °C, which is a stand-in for the flash point of a
  // lamp oil, and burns on its own from there (no latent heat: the fire rule heats the cell the next dispatch).
  {
    key: 'OIL',
    id: 5,
    label: 'Oil',
    color: [0.22, 0.16, 0.10],
    state: 'liquid',
    density: 900,
    flammable: true,
    conductivity: 0.1,
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
    // A hot gas that heats what it touches quickly and holds little heat itself: a high rank for a gas, a small capacity.
    conductivity: 0.5,
    heatCapacity: 1,
    rule: 'fire',
    graphics: 'fire',
    toolbar: 4,
  },
  // Steel-like metal: the best conductor of the table (about 50 W/m·K, rank 1), 3.5 MJ/m³·K. Melts at iron's 1,538 °C.
  {
    key: 'METAL',
    id: 7,
    label: 'Metal',
    color: [0.70, 0.74, 0.80],
    state: 'solid',
    density: 7870,
    conductivity: 1,
    heatCapacity: 3.5,
    above: { temp: 1538, becomes: 'MOLTEN_METAL', latent: 600 },
    toolbar: 7,
  },
  // Granite-like stone: about 2.5 W/m·K (rank 0.1), 2.2 MJ/m³·K. Melts into lava at 1,200 °C.
  {
    key: 'STONE',
    id: 8,
    label: 'Stone',
    color: [0.52, 0.46, 0.40],
    state: 'solid',
    density: 2700,
    conductivity: 0.1,
    heatCapacity: 2.2,
    above: { temp: 1200, becomes: 'LAVA', latent: 400 },
    toolbar: 8,
  },
  // Ice: 917 kg/m³, 2.2 W/m·K (rank 0.2), 1.9 MJ/m³·K. Painted at -20 °C. It does not float: a solid never moves.
  {
    key: 'ICE',
    id: 9,
    label: 'Ice',
    color: [0.68, 0.86, 0.96],
    state: 'solid',
    density: 917,
    temperature: -20,
    conductivity: 0.2,
    heatCapacity: 1.9,
    above: { temp: 0, becomes: 'WATER', latent: 300 },
    toolbar: 9,
  },
  // Steam: 0.59 kg/m³ at 100 °C. A gas holds far less heat per volume than water; 2.0 is a tuned per-cell capacity, and
  // 0.2 a gas's high rank for a cell that stands for a cloud. Painted at 110 °C, just past its condensing point.
  {
    key: 'STEAM',
    id: 10,
    label: 'Steam',
    color: [0.84, 0.90, 0.97],
    state: 'gas',
    density: 0.59,
    temperature: 110,
    conductivity: 0.2,
    heatCapacity: 2,
    below: { temp: 100, becomes: 'WATER', latent: 400 },
    toolbar: 11,
  },
  // Lava is molten stone: liquid stone at 2,700 kg/m³, painted at 1,300 °C and setting at 1,200. One molten element per
  // meltable material (backlog I15).
  {
    key: 'LAVA',
    id: 11,
    label: 'Lava',
    color: [0.92, 0.32, 0.06],
    state: 'liquid',
    density: 2700,
    temperature: 1300,
    conductivity: 0.15,
    heatCapacity: 2.6,
    below: { temp: 1200, becomes: 'STONE', latent: 400 },
    toolbar: 10,
  },
  // Molten steel: 7,000 kg/m³, painted at 1,600 °C, sets back into METAL at 1,538. Not paintable: metal melts into it.
  {
    key: 'MOLTEN_METAL',
    id: 12,
    label: 'Molten metal',
    color: [1.0, 0.62, 0.28],
    state: 'liquid',
    density: 7000,
    temperature: 1600,
    conductivity: 0.6,
    heatCapacity: 4,
    below: { temp: 1538, becomes: 'METAL', latent: 600 },
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
    if (!(elementGravity(e) >= 0 && elementGravity(e) < Infinity)) throw new Error(`element ${e.key}: gravity must be a finite number, 0 or more`);
    if (!(elementConductivity(e) >= 0 && elementConductivity(e) <= 1)) throw new Error(`element ${e.key}: conductivity must be a number in 0..1`);
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

// A threshold, its target and its latent heat must leave every stored temperature a cell can have inside the range the
// tools keep it in, and no pair of transitions may undo itself on the next dispatch.
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
      const width = latentWidth(e, t);
      const [low, high] = side === 'above' ? [t.temp, t.temp + width] : [t.temp - width, t.temp];
      if (!(low >= ABSOLUTE_ZERO && high <= MAX_TEMP)) {
        throw new Error(`${name}.temp ${t.temp} and its latent width ${width} must stay within ${ABSOLUTE_ZERO}..${MAX_TEMP}`);
      }
      const target = byKey.get(t.becomes);
      if (!target) throw new Error(`${name}.becomes "${t.becomes}" is not in the table`);
      const [targetLow, targetHigh] = range(target);
      if (!(t.temp >= targetLow && t.temp <= targetHigh)) throw new Error(`${name}.temp ${t.temp} is outside the range ${targetLow}..${targetHigh} of ${target.key}`);
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
