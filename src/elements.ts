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
  /** Becomes fire when a fire cell is in its block. */
  flammable?: boolean;
  /** `life` counts down by `decay` per dispatch from `start` and the cell becomes the element `becomes` (a key) at 0. */
  life?: { start: number; decay: number; becomes: string };
  /** Optional WGSL rule run for cells of this element: the name of a file in `src/shaders/rules/`. */
  rule?: string;
  /** Optional color function of this element in the display shader: the name of an entry of `src/shaders/graphics.wgsl.ts`. */
  graphics?: string;
  /** Order in the toolbar (lowest first; the n-th button is selected by number key n); absent: not paintable. */
  toolbar?: number;
}

// The table is a uniform array of this many rows, and the cell stores the ID in 8 bits.
export const MAX_ELEMENTS = 256;

export const ELEMENTS = [
  { key: 'EMPTY', id: 0, label: 'Empty', color: [0.06, 0.06, 0.08], state: 'empty', density: 1.2 },
  { key: 'SAND', id: 1, label: 'Sand', color: [0.80, 0.70, 0.48], state: 'powder', density: 1600, toolbar: 1 },
  { key: 'WALL', id: 2, label: 'Wall', color: [0.43, 0.45, 0.47], state: 'solid', density: 2500, toolbar: 6 },
  { key: 'WATER', id: 3, label: 'Water', color: [0.18, 0.42, 0.72], state: 'liquid', density: 1000, toolbar: 2 },
  { key: 'SMOKE', id: 4, label: 'Smoke', color: [0.72, 0.72, 0.74], state: 'gas', density: 0.6, toolbar: 5 },
  { key: 'OIL', id: 5, label: 'Oil', color: [0.22, 0.16, 0.10], state: 'liquid', density: 900, flammable: true, toolbar: 3 },
  {
    key: 'FIRE',
    id: 6,
    label: 'Fire',
    color: [1.0, 0.72, 0.12],
    state: 'plasma',
    density: 0.3,
    life: { start: 200, decay: 4, becomes: 'SMOKE' },
    rule: 'fire',
    graphics: 'fire',
    toolbar: 4,
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
}

/** The row with this key; throws when the table has none. */
export function elementByKey(elements: readonly ElementDef[], key: string): ElementDef {
  const found = elements.find((e) => e.key === key);
  if (!found) throw new Error(`no element ${key}`);
  return found;
}
