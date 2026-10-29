import { expect, it } from 'vitest';
import { SCENE_INFO } from '../src/scenes';

// The helper of the real-world scenarios (`AGENTS.md`, "Real-world scenarios"). It imports no GPU code: a
// scenario's `measure` callback is the only place that uses the device, and it runs inside the test, under the
// calling file's `describe.skipIf(!device)`.

/**
 * The items a scenario's test waits for, read from its menu entry (`SCENE_INFO[scene].waitsFor`) so that the test titles
 * and the menu cannot disagree. `only` narrows it to the items one check waits for when the scene has several; each
 * must be in the entry. Delete the entry's `waitsFor` in the commit that makes the scenario pass.
 */
export function waitsFor(scene: string, ...only: string[]): string[] {
  const ids = SCENE_INFO[scene]?.waitsFor;
  if (!ids || ids.length === 0) throw new Error(`${scene} has no waitsFor in SCENE_INFO`);
  for (const id of only) if (!ids.includes(id)) throw new Error(`${scene} does not wait for ${id} in SCENE_INFO`);
  return only.length > 0 ? only : [...ids];
}

/** An inclusive range [min, max]. */
export type Range = readonly [number, number];

export interface Check<K extends string> {
  /** The name of the measured value this check reads. */
  value: K;
  /** What the check says, after the scenario's name in the title: "ends at 10.0 ± 0.2 °C". */
  outcome: string;
  target: Range;
  /** Roadmap or backlog IDs that will make the target pass. A check with some is waiting: it must fail today. */
  waitsFor?: readonly string[];
  /** A waiting check's companion range, which holds both today's value and the target. */
  companion?: Range;
}

export interface ScenarioSpec<K extends string> {
  name: string;
  /** "fast", "full": goes after the name in titles, `iceCup (full): ...`. */
  version?: string;
  /** Runs the experiment once for every check and returns the measured values by name. */
  measure: () => Promise<Record<K, number>>;
  checks: readonly Check<K>[];
  /** Milliseconds each test may take; the first one to run carries the measurement. */
  timeout: number;
}

export interface ControlSpec {
  name: string;
  version?: string;
  /** The one property that is deliberately wrong: "ICE and WATER with half their shared latent heat". */
  wrong: string;
  measure: () => Promise<number>;
  /** The scenario's target; the control passes when the value lies outside it. */
  target: Range;
  timeout: number;
}

/** A test the helper registers: `fails` ones go through `it.fails`. */
export interface PlannedTest {
  title: string;
  fails: boolean;
  run: (annotate: (message: string) => Promise<unknown>) => Promise<void>;
}

function label(name: string, version?: string): string {
  return version ? `${name} (${version})` : name;
}

function formatNumber(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(5))) : String(n);
}

function formatRange([min, max]: Range): string {
  return `${formatNumber(min)} to ${formatNumber(max)}`;
}

function checkRange(range: Range, what: string): void {
  if (!(range[0] <= range[1])) throw new Error(`${what}: the range ${formatRange(range)} is empty`);
}

/** The tests of one scenario, in registration order; `scenario` registers them. Exported to test the helper without a GPU. */
export function planScenario<K extends string>(spec: ScenarioSpec<K>): PlannedTest[] {
  const name = label(spec.name, spec.version);
  let measured: Promise<Record<K, number>> | undefined;
  // One run of the scene serves every test of the scenario, the first one to start pays for it.
  const measure = (): Promise<Record<K, number>> => (measured ??= spec.measure());
  const tests: PlannedTest[] = [];

  for (const check of spec.checks) {
    const { value, outcome, target, waitsFor = [], companion } = check;
    checkRange(target, `${name} ${value}`);
    if (waitsFor.length === 0) {
      tests.push({
        title: `${name}: ${outcome}`,
        fails: false,
        run: async (annotate) => {
          const m = (await measure())[value];
          await annotate(`${name}: ${value} measured ${formatNumber(m)}, target ${formatRange(target)}`);
          expectInRange(m, target, `${name} ${value}`);
        },
      });
      continue;
    }

    if (!companion) throw new Error(`${name} ${value}: a waiting check needs a companion range`);
    checkRange(companion, `${name} ${value} companion`);
    const ids = waitsFor.join(', ');
    tests.push(
      {
        title: `${name} [waits for ${ids}]: ${outcome}`,
        fails: true,
        run: async (annotate) => {
          const m = (await measure())[value];
          await annotate(`${name}: ${value} measured ${formatNumber(m)}, target ${formatRange(target)} (waits for ${ids})`);
          expectInRange(m, target, `${name} ${value}`);
        },
      },
      {
        title: `${name}: measures ${value} in ${formatRange(companion)}`,
        fails: false,
        run: async (annotate) => {
          const m = (await measure())[value];
          await annotate(
            `${name}: ${value} measured ${formatNumber(m)}, expected in ${formatRange(companion)}; target ${formatRange(target)} (waits for ${ids})`,
          );
          expectInRange(m, companion, `${name} ${value}`);
        },
      },
    );
  }
  return tests;
}

/** The test of one control. It passes only when the value is a number outside the target. */
export function planControl(spec: ControlSpec): PlannedTest {
  const name = label(spec.name, spec.version);
  checkRange(spec.target, `${name} control`);
  return {
    title: `${name} control: ${spec.wrong} misses ${formatRange(spec.target)}`,
    fails: false,
    run: async (annotate) => {
      const m = await spec.measure();
      await annotate(`${name} control (${spec.wrong}): measured ${formatNumber(m)}, target ${formatRange(spec.target)}`);
      expect(Number.isFinite(m), `${name} control measured ${m}, not a number`).toBe(true);
      expect(m < spec.target[0] || m > spec.target[1], `${name} control: ${formatNumber(m)} is inside the target ${formatRange(spec.target)}`).toBe(true);
    },
  };
}

function expectInRange(value: number, range: Range, what: string): void {
  const message = `${what} is ${formatNumber(value)}, outside ${formatRange(range)}`;
  expect(value, message).toBeGreaterThanOrEqual(range[0]);
  expect(value, message).toBeLessThanOrEqual(range[1]);
}

function register(test: PlannedTest, timeout: number): void {
  (test.fails ? it.fails : it)(test.title, ({ annotate }) => test.run((message) => annotate(message)), timeout);
}

/**
 * Registers a scenario's checks: each as one test, or, when it waits for an item, as an `it.fails` test plus its
 * companion. Call it inside the file's `describe.skipIf(!device)`.
 */
export function scenario<K extends string>(spec: ScenarioSpec<K>): void {
  for (const test of planScenario(spec)) register(test, spec.timeout);
}

/** Registers a control: the same scene with one property deliberately wrong, which must miss the target. */
export function control(spec: ControlSpec): void {
  register(planControl(spec), spec.timeout);
}
