import { describe, expect, it } from 'vitest';
import { control, planControl, planScenario, scenario, type PlannedTest } from './scenario';

// The helper runs no GPU code: its stubs measure plain numbers, so this file needs no device.

function recorder(): { notes: string[]; annotate: (message: string) => Promise<void> } {
  const notes: string[] = [];
  return {
    notes,
    annotate: (message) => {
      notes.push(message);
      return Promise.resolve();
    },
  };
}

function constant<K extends string>(values: Record<K, number>): { calls: () => number; measure: () => Promise<Record<K, number>> } {
  let calls = 0;
  return {
    calls: () => calls,
    measure: () => {
      calls++;
      return Promise.resolve(values);
    },
  };
}

describe('M8.9 AC1: the scenario helper', () => {
  it('registers a passing check as one normal test titled by the scenario and its outcome', () => {
    const stub = constant({ temp: 10 });
    const tests = planScenario({ name: 'iceCup', measure: stub.measure, timeout: 1000, checks: [{ value: 'temp', outcome: 'ends at 10.0 ± 0.2 °C', target: [9.8, 10.2] }] });
    expect(tests.map((t) => [t.title, t.fails])).toEqual([['iceCup: ends at 10.0 ± 0.2 °C', false]]);
  });

  it('puts the version after the name in every title', () => {
    const stub = constant({ temp: 10 });
    const tests = planScenario({
      name: 'iceCup',
      version: 'full',
      measure: stub.measure,
      timeout: 1000,
      checks: [
        { value: 'temp', outcome: 'ends at 10 °C', target: [9, 11] },
        { value: 'temp', outcome: 'ends at 10 °C later', target: [9, 11], waitsFor: ['I26'], companion: [0, 20] },
      ],
    });
    expect(tests.map((t) => t.title)).toEqual([
      'iceCup (full): ends at 10 °C',
      'iceCup (full) [waits for I26]: ends at 10 °C later',
      'iceCup (full): measures temp in 0 to 20',
    ]);
    expect(planControl({ name: 'iceCup', version: 'full', wrong: 'half the latent heat', measure: () => Promise.resolve(14), target: [9, 11], timeout: 1000 }).title).toBe(
      'iceCup (full) control: half the latent heat misses 9 to 11',
    );
  });

  it('registers a waiting check as an it.fails test plus a normal companion, naming every ID', () => {
    const stub = constant({ temp: 500 });
    const tests = planScenario({
      name: 'redHotBar',
      measure: stub.measure,
      timeout: 1000,
      checks: [{ value: 'temp', outcome: 'is at 565 to 655 °C after 125 s', target: [565, 655], waitsFor: ['I26', 'I31'], companion: [0, 1000] }],
    });
    expect(tests.map((t) => [t.title, t.fails])).toEqual([
      ['redHotBar [waits for I26, I31]: is at 565 to 655 °C after 125 s', true],
      ['redHotBar: measures temp in 0 to 1000', false],
    ]);
  });

  it('measures once for every check of a scenario, however many tests it registers', async () => {
    const stub = constant({ a: 1, b: 2 });
    const tests = planScenario({
      name: 'two',
      measure: stub.measure,
      timeout: 1000,
      checks: [
        { value: 'a', outcome: 'a is 1', target: [1, 1] },
        { value: 'b', outcome: 'b is 2', target: [2, 2], waitsFor: ['X1'], companion: [0, 5] },
      ],
    });
    expect(stub.calls()).toBe(0);
    for (const t of tests.filter((x) => !x.fails)) await t.run(recorder().annotate);
    expect(stub.calls()).toBe(1);
  });

  it('checks the range inclusively and fails outside it or on a value that is not a number', async () => {
    const planned = (value: number): PlannedTest =>
      planScenario({ name: 's', measure: () => Promise.resolve({ v: value }), timeout: 1000, checks: [{ value: 'v', outcome: 'o', target: [1, 2] }] })[0];
    for (const v of [1, 1.5, 2]) await expect(planned(v).run(recorder().annotate), String(v)).resolves.toBeUndefined();
    for (const v of [0.999, 2.001, Number.NaN, Number.POSITIVE_INFINITY]) await expect(planned(v).run(recorder().annotate), String(v)).rejects.toThrow(/outside 1 to 2/);
  });

  it('annotates the measured value and the target of every test', async () => {
    const stub = constant({ temp: 14.0123 });
    const [waiting, companion] = planScenario({
      name: 'iceCup',
      version: 'fast',
      measure: stub.measure,
      timeout: 1000,
      checks: [{ value: 'temp', outcome: 'ends at 10.0 ± 0.2 °C', target: [9.8, 10.2], waitsFor: ['I26'], companion: [0, 20] }],
    });
    const first = recorder();
    await expect(waiting.run(first.annotate)).rejects.toThrow();
    expect(first.notes).toEqual(['iceCup (fast): temp measured 14.012, target 9.8 to 10.2 (waits for I26)']);
    const second = recorder();
    await companion.run(second.annotate);
    expect(second.notes).toEqual(['iceCup (fast): temp measured 14.012, expected in 0 to 20; target 9.8 to 10.2 (waits for I26)']);
  });

  it('passes a waiting check only by failing while its target is missed, and flags it once the target is met', async () => {
    // Vitest passes an `it.fails` test whose body throws and fails it when the body resolves: the item that
    // makes the scenario pass must turn it into a normal test.
    const spec = (v: number) => planScenario({ name: 's', measure: () => Promise.resolve({ v }), timeout: 1000, checks: [{ value: 'v', outcome: 'o', target: [1, 2], waitsFor: ['X1'], companion: [0, 5] }] });
    const [missing, missingCompanion] = spec(3);
    expect(missing.fails).toBe(true);
    await expect(missing.run(recorder().annotate)).rejects.toThrow();
    await expect(missingCompanion.run(recorder().annotate)).resolves.toBeUndefined();
    const [met] = spec(1.5);
    await expect(met.run(recorder().annotate)).resolves.toBeUndefined();
    const [, brokenCompanion] = spec(Number.NaN);
    await expect(brokenCompanion.run(recorder().annotate)).rejects.toThrow();
  });

  it('refuses a waiting check without a companion and an empty range', () => {
    const measure = () => Promise.resolve({ v: 1 });
    expect(() => planScenario({ name: 's', measure, timeout: 1000, checks: [{ value: 'v', outcome: 'o', target: [1, 2], waitsFor: ['X1'] }] })).toThrow(/companion/);
    expect(() => planScenario({ name: 's', measure, timeout: 1000, checks: [{ value: 'v', outcome: 'o', target: [2, 1] }] })).toThrow(/empty/);
    expect(() => planControl({ name: 's', wrong: 'w', measure: () => Promise.resolve(1), target: [2, 1], timeout: 1000 })).toThrow(/empty/);
  });

  it('passes a control only when its value lies outside the target', async () => {
    const run = (v: number) => planControl({ name: 'iceCup', wrong: 'half the latent heat', measure: () => Promise.resolve(v), target: [9.8, 10.2], timeout: 1000 }).run(recorder().annotate);
    await expect(run(14)).resolves.toBeUndefined();
    await expect(run(9.7)).resolves.toBeUndefined();
    await expect(run(9.8)).rejects.toThrow(/inside the target 9.8 to 10.2/);
    await expect(run(10.2)).rejects.toThrow(/inside/);
    await expect(run(Number.NaN)).rejects.toThrow(/not a number/);
    const notes = recorder();
    await planControl({ name: 'iceCup', wrong: 'half the latent heat', measure: () => Promise.resolve(14), target: [9.8, 10.2], timeout: 1000 }).run(notes.annotate);
    expect(notes.notes).toEqual(['iceCup control (half the latent heat): measured 14, target 9.8 to 10.2']);
  });
});

// One stub scenario per state, registered through the real helper: the tests below run under Vitest itself.
const passing = constant({ value: 5 });
const waiting = constant({ value: 50 });
const controlled = constant({ value: 50 });

describe('M8.9 AC1: stub scenarios registered with scenario() and control()', () => {
  scenario({ name: 'stubPassing', measure: passing.measure, timeout: 1000, checks: [{ value: 'value', outcome: 'is 5', target: [4, 6] }] });
  scenario({
    name: 'stubWaiting',
    measure: waiting.measure,
    timeout: 1000,
    checks: [{ value: 'value', outcome: 'is 5', target: [4, 6], waitsFor: ['X1'], companion: [0, 100] }],
  });
  control({ name: 'stubPassing', wrong: 'a value ten times too high', measure: () => controlled.measure().then((m) => m.value), target: [4, 6], timeout: 1000 });

  it('ran each stub scenario\'s measurement once', () => {
    expect([passing.calls(), waiting.calls(), controlled.calls()]).toEqual([1, 1, 1]);
  });
});
