import { describe, expect, it } from 'vitest';
import { PROP_FIELDS, packElements } from '../src/element-table';
import { ELEMENT as T, ELEMENTS, elementByKey, elementSlide, validateElements, type ElementDef } from '../src/elements';
import { MAX_REPOSE, MIN_REPOSE, REPOSE_FIT, slideSpeed } from '../src/physics';
import { cell, cellType, createSim, device, idleInput, loadScene, readCells, run, runMany } from './gpu';
import { columnTops, pileAngle } from './metrics';
import { control, scenario } from './scenario';

const SAND: ElementDef = elementByKey(ELEMENTS, 'SAND');
const GUNPOWDER: ElementDef = elementByKey(ELEMENTS, 'GUNPOWDER');

// Test powders at fixed angles, far from the game's IDs.
const FLAT = 200;
const STEEP = 201;
const row = (key: string, id: number, repose: number | undefined): ElementDef => ({
  key,
  id,
  label: key,
  color: [0.5, 0.5, 0.5],
  state: 'powder',
  density: 1500,
  ...(repose !== undefined && { repose }),
});
const TEST_ROWS: readonly ElementDef[] = [...ELEMENTS, row('FLAT', FLAT, 25), row('STEEP', STEEP, 45)];

describe('M8.8 AC15: angle of repose (table)', () => {
  it('M8.8 AC15: gives every powder row an angle of repose from data, and nothing else one', () => {
    const rows: readonly ElementDef[] = ELEMENTS;
    for (const e of rows.filter((r) => r.state === 'powder')) expect(e.repose, `${e.key} repose`).toBeGreaterThanOrEqual(MIN_REPOSE);
    for (const e of rows.filter((r) => r.state !== 'powder')) expect(e.repose, `${e.key} is not a powder`).toBeUndefined();
    // Dry sand: 30 to 35 degrees (Wikipedia 34, Dartmouth's engineering notes 35).
    expect(SAND.repose).toBe(34);
  });

  it('M8.8 AC15: turns the angle into a slide speed that is 0 at the steepest pile and grows as it flattens', () => {
    expect(slideSpeed(MAX_REPOSE)).toBe(0);
    expect(slideSpeed(34)).toBeCloseTo(Math.sqrt(11 / REPOSE_FIT), 12);
    expect(slideSpeed(MIN_REPOSE)).toBeLessThan(0.6);
    let last = 0;
    for (let angle = MAX_REPOSE - 1; angle >= MIN_REPOSE; angle--) {
      expect(slideSpeed(angle), `speed at ${angle} degrees`).toBeGreaterThan(last);
      last = slideSpeed(angle);
    }
    expect(elementSlide(SAND)).toBe(slideSpeed(34));
    expect(elementSlide({ ...SAND, repose: undefined }), 'no angle, no slide').toBe(0);
    expect(elementSlide(elementByKey(ELEMENTS, 'WATER'))).toBe(0);
  });

  it('M8.8 AC15: packs the slide speed of each row for the GPU', () => {
    const floats = new Float32Array(packElements(ELEMENTS));
    const at = (id: number): number => id * PROP_FIELDS.length + PROP_FIELDS.findIndex((f) => f.name === 'slide');
    expect(floats[at(T.SAND)]).toBe(Math.fround(slideSpeed(34)));
    expect(floats[at(T.GUNPOWDER)]).toBe(Math.fround(slideSpeed(GUNPOWDER.repose!)));
    expect(floats[at(T.WATER)]).toBe(0);
    expect(floats[at(T.WALL)]).toBe(0);
  });

  it.each<[string, Partial<ElementDef>, RegExp]>([
    ['a repose on a liquid', { state: 'liquid', repose: 30 }, /MUD: repose is only for a powder/],
    ['a repose on a solid', { state: 'solid', repose: 30 }, /MUD: repose is only for a powder/],
    ['a repose past the steepest pile', { repose: MAX_REPOSE + 1 }, /MUD: repose must be a number in 20\.\.45/],
    ['a repose flatter than the fit covers', { repose: MIN_REPOSE - 1 }, /MUD: repose must be a number in 20\.\.45/],
    ['a repose of 0', { repose: 0 }, /MUD: repose must be a number in 20\.\.45/],
    ['a repose that is not a number', { repose: NaN }, /MUD: repose must be a number in 20\.\.45/],
  ])('M8.8 AC15: rejects %s', (_name, change, message) => {
    const mud: ElementDef = { key: 'MUD', id: 202, label: 'Mud', color: [0.4, 0.3, 0.2], state: 'powder', density: 1300, ...change };
    expect(() => validateElements([...ELEMENTS, mud])).toThrow(message);
  });
});

const WIDTH = 360;
const HEIGHT = 120;
const FLOOR = 2;
const GRAINS = 4000;

// Pours a powder from a point at the top of a walled tank, one brush dab per frame, until the tank holds `GRAINS` grains,
// then lets the pile settle; the slope of the pile in degrees. No air, so only the grains' own rules shape it.
async function pouredAngle(elements: readonly ElementDef[], type: number, seed: number): Promise<number> {
  const sim = createSim(WIDTH, HEIGHT, seed, { air: false, elements });
  const cells = new Uint32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) if (y < FLOOR || x < 2 || x >= WIDTH - 2) cells[y * WIDTH + x] = cell(T.WALL);
  }
  loadScene(sim, cells);
  const at = { x: WIDTH / 2, y: HEIGHT - 8 };
  const stroke = { ...idleInput, mouseActive: true, brushSize: 1, particleType: type, mousePos: at, prevMousePos: at };
  const count = async (): Promise<number> => (await readCells(sim)).reduce((n, c) => n + (cellType(c) === type ? 1 : 0), 0);
  while ((await count()) < GRAINS) await run(sim, 4, stroke);
  await runMany(sim, 3000);
  const kinds = await readCells(sim);
  expect(await count(), 'no grain is lost').toBeGreaterThanOrEqual(GRAINS);
  return pileAngle(columnTops(kinds, WIDTH, HEIGHT, FLOOR, type));
}

describe.skipIf(!device)('M8.8 AC15: a pile poured from a point', () => {
  // sandPile: dry sand poured from a point stands at its angle of repose, 30 to 35 degrees (Wikipedia 34, Dartmouth's engineering
  // notes 35); the row's 34 is the middle, and the target is 34 ± 4 degrees. The tolerance is the test's of M8.8 AC15.
  const SAND_TARGET = [30, 38] as const;
  scenario({
    name: 'sandPile',
    measure: async () => ({ angle: await pouredAngle(ELEMENTS, T.SAND, 1) }),
    checks: [{ value: 'angle', outcome: 'sand poured from a point stands at its angle of repose within 4 degrees of 34', target: SAND_TARGET }],
    timeout: 120_000,
  });

  // Sand without its angle of repose piles at the steepest angle the grid allows, about 45 degrees.
  control({
    name: 'sandPile',
    wrong: 'sand without its angle of repose',
    measure: async () => {
      const plain = TEST_ROWS.map((e) => (e.key === 'SAND' ? { ...e, repose: undefined } : e));
      const measured = await pouredAngle(plain, T.SAND, 2);
      expect(Math.abs(measured - MAX_REPOSE), `measured ${measured.toFixed(1)} degrees`).toBeLessThanOrEqual(4);
      return measured;
    },
    target: SAND_TARGET,
    timeout: 120_000,
  });

  it.each([
    ['gunpowder', T.GUNPOWDER, 30, ELEMENTS],
    ['a 25 degree test powder', FLAT, 25, TEST_ROWS],
    ['a 45 degree test powder', STEEP, 45, TEST_ROWS],
  ] as const)('M8.8 AC15: %s stands at its angle of repose within 4 degrees', async (_name, type, angle, elements) => {
    const measured = await pouredAngle(elements, type, 1);
    expect(Math.abs(measured - angle), `measured ${measured.toFixed(1)} degrees, expected ${angle}`).toBeLessThanOrEqual(4);
  }, 120_000);

  it('M8.8 AC15: a flatter powder makes a flatter pile from the same grains', async () => {
    const flat = await pouredAngle(TEST_ROWS, FLAT, 3);
    const steep = await pouredAngle(TEST_ROWS, STEEP, 3);
    expect(steep - flat, `${steep.toFixed(1)} against ${flat.toFixed(1)} degrees`).toBeGreaterThan(10);
  }, 120_000);
});
