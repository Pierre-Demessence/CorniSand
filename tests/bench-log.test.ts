import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BenchOutput,
  type RunLine,
  benchSettings,
  buildRunLine,
  compareTable,
  describeBusy,
  findRuns,
  fingerprint,
  isBusy,
  isDirty,
  median,
  parseEngineUse,
  parseGpuSample,
  parseLog,
  serializeLine,
  showTable,
} from '../bench/bench-log.ts';

describe('GPU check', () => {
  it('parses an nvidia-smi line', () => {
    expect(parseGpuSample('63, 621.01, NVIDIA GeForce RTX 4080')).toEqual({
      utilization: 63,
      driver: '621.01',
      name: 'NVIDIA GeForce RTX 4080',
    });
  });

  it('rejects output that is not a sample', () => {
    expect(() => parseGpuSample('No devices were found')).toThrow(/Unexpected nvidia-smi output/);
  });

  it('takes the median, so one spike among idle samples does not make the GPU busy', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(isBusy([2, 3, 2, 90, 3, 2, 3, 2])).toBe(false);
    expect(isBusy([80, 79, 81, 3, 82])).toBe(true);
  });

  it('is busy only above the idle maximum', () => {
    expect(isBusy([10, 10, 10])).toBe(false);
    expect(isBusy([11, 11, 11])).toBe(true);
    expect(isBusy([4, 4, 4], 3)).toBe(true);
  });

  it('sums a process\'s 3D engines and lists the busiest first', () => {
    const output = [
      'pid_4120_luid_0x00000000_0x0000B1C2_phys_0_eng_0_engtype_3D\t40.2\tenshrouded',
      'pid_4120_luid_0x00000000_0x0000B1C2_phys_0_eng_1_engtype_3D\t27.1\tenshrouded',
      'pid_1180_luid_0x00000000_0x0000B1C2_phys_0_eng_0_engtype_3D\t3.4\tdwm',
      'pid_77_luid_0x00000000_0x0000B1C2_phys_0_eng_0_engtype_3D\t0.2\tidle-tool',
      'not a counter line',
      '',
    ].join('\r\n');
    expect(parseEngineUse(output)).toEqual([
      { pid: 4120, name: 'enshrouded', percent: 67 },
      { pid: 1180, name: 'dwm', percent: 3 },
    ]);
  });

  it('names the utilization and the processes when busy', () => {
    const text = describeBusy([80, 79, 81], [{ pid: 4120, name: 'enshrouded', percent: 67 }]);
    expect(text).toContain('80 %');
    expect(text).toContain('enshrouded (pid 4120): 67 %');
    expect(describeBusy([80], [])).not.toContain('3D engine');
  });
});

describe('fingerprint', () => {
  let repo: string;
  const run = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  };
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = (): void => {
    run('add', '-A');
    run('-c', 'commit.gpgsign=false', 'commit', '-m', 'x');
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'bench-log-test-'));
    run('init', '-q');
    run('config', 'core.autocrlf', 'false');
    write('src/sim.ts', 'export const a = 1;\n');
    write('src/shaders/ca.wgsl.ts', 'export const b = 2;\n');
    write('tests/bench.gpu.ts', 'bench\n');
    write('tests/gpu.ts', 'gpu\n');
    write('tests/other.test.ts', 'other\n');
    write('package-lock.json', '{}\n');
    write('package.json', '{}\n');
    write('vitest.bench.config.ts', 'config\n');
    write('docs/notes.md', 'docs\n');
    commit();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('is clean and equal to the commit when nothing changed', () => {
    expect(isDirty(repo)).toBe(false);
    expect(fingerprint(repo)).toBe(fingerprint(repo, 'HEAD'));
    expect(fingerprint(repo)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores files the bench does not measure', () => {
    const before = fingerprint(repo);
    write('docs/notes.md', 'changed\n');
    write('tests/other.test.ts', 'changed\n');
    write('package.json', '{"x":1}\n');
    write('bench/bench.ts', 'cli\n');
    expect(fingerprint(repo)).toBe(before);
    expect(isDirty(repo)).toBe(false);
    run('checkout', '--', '.');
    run('clean', '-fdq');
  });

  it.each(['src/sim.ts', 'src/shaders/ca.wgsl.ts', 'tests/bench.gpu.ts', 'tests/gpu.ts', 'package-lock.json', 'vitest.bench.config.ts'])(
    'changes with %s, committed or not',
    (path) => {
      const before = fingerprint(repo);
      write(path, 'changed\n');
      const dirtyPrint = fingerprint(repo);
      expect(dirtyPrint).not.toBe(before);
      expect(isDirty(repo)).toBe(true);
      expect(fingerprint(repo, 'HEAD')).toBe(before);
      commit();
      expect(isDirty(repo)).toBe(false);
      expect(fingerprint(repo)).toBe(dirtyPrint);
      expect(fingerprint(repo, 'HEAD')).toBe(dirtyPrint);
    },
  );

  it('counts a new file under src, tracked or not', () => {
    const before = fingerprint(repo);
    write('src/new.ts', 'export {};\n');
    expect(fingerprint(repo)).not.toBe(before);
    expect(isDirty(repo)).toBe(true);
    commit();
    expect(isDirty(repo)).toBe(false);
  });

  it('counts a deleted file', () => {
    const before = fingerprint(repo);
    rmSync(join(repo, 'src/new.ts'));
    expect(fingerprint(repo)).not.toBe(before);
    expect(isDirty(repo)).toBe(true);
    commit();
  });

  it('does not depend on the line endings of the checkout', () => {
    const before = fingerprint(repo);
    write('src/sim.ts', (execFileSync('git', ['show', 'HEAD:src/sim.ts'], { cwd: repo }).toString()).replaceAll('\n', '\r\n'));
    expect(fingerprint(repo)).toBe(before);
  });
});

describe('run line', () => {
  const parts: RunLine = {
    fingerprint: 'f'.repeat(64),
    dirty: true,
    commit: 'abc1234',
    date: '2026-10-30T20:00:00.000Z',
    adapter: 'vendor="nvidia"',
    driver: '621.01',
    settings: { BENCH_SCENES: 'tank' },
    idle: { before: 2, after: 3 },
    rows: [{ scene: 'tank', speed: '1x', msMedian: 1 }],
    breakdown: { 'tank (air default, finished look)': { sum: 1 } },
  };

  it('holds the plan\'s fields and leaves out a session and role that were not given', () => {
    const line = buildRunLine(parts);
    expect(Object.keys(line)).toEqual(expect.arrayContaining(['fingerprint', 'dirty', 'commit', 'date', 'adapter', 'driver', 'settings', 'idle', 'rows', 'breakdown']));
    expect(line).not.toHaveProperty('session');
    expect(line).not.toHaveProperty('role');
  });

  it('keeps the session and role of a compare, and serializes to one line', () => {
    const line = buildRunLine({ ...parts, session: 's1', role: 'base' });
    expect(line).toMatchObject({ session: 's1', role: 'base' });
    const text = serializeLine(line);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd()).not.toContain('\n');
    expect(parseLog(text + text)).toEqual([line, line]);
  });

  it('collects the BENCH_ settings except the output path', () => {
    expect(benchSettings({ BENCH_SCENES: 'tank', BENCH_OUT: '/x', BENCH_AIR: 'off', PATH: 'p', BENCH_LOOKS: undefined })).toEqual({
      BENCH_AIR: 'off',
      BENCH_SCENES: 'tank',
    });
  });

  it('finds the runs of one fingerprint, newest first', () => {
    const older = { ...parts, date: '2026-10-29T00:00:00.000Z' };
    const newer = { ...parts, date: '2026-10-30T00:00:00.000Z' };
    const other = { ...parts, fingerprint: 'e'.repeat(64) };
    expect(findRuns([older, other, newer], parts.fingerprint)).toEqual([newer, older]);
    expect(findRuns([other], parts.fingerprint)).toEqual([]);
  });
});

describe('tables', () => {
  const name = 'tank (air default, finished look)';
  const output = (frame: number, ca0: number, ca1: number, sum: number, render: number): BenchOutput => ({
    adapter: 'a',
    rows: [
      { scene: 'tank', air: 'default', look: 'finished', speed: '1x', msMedian: frame },
      { scene: 'tank', air: 'default', look: 'finished', speed: '2x', msMedian: frame * 2 },
    ],
    breakdown: { [name]: { ca0, ca1, sum, render } },
  });

  it('compares the means of two runs a side, with the larger gap of the sides as noise', () => {
    const rows = compareTable([output(1.0, 0.2, 0.2, 0.8, 0.2), output(1.2, 0.2, 0.2, 1.0, 0.2)], [output(1.1, 0.3, 0.3, 0.9, 0.3), output(1.1, 0.3, 0.3, 0.9, 0.3)]);
    expect(rows.map((row) => row.metric)).toEqual(['frame', 'ca', 'sum', 'render']);
    const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row]));
    expect(byMetric.frame).toEqual({ scene: name, metric: 'frame', base: 1.1, head: 1.1, deltaPct: 0, noisePct: 18.2 });
    expect(byMetric.ca).toMatchObject({ base: 0.4, head: 0.6, deltaPct: 50, noisePct: 0 });
    expect(byMetric.sum).toMatchObject({ base: 0.9, head: 0.9, deltaPct: 0, noisePct: 22.2 });
    expect(byMetric.render).toMatchObject({ base: 0.2, head: 0.3, deltaPct: 50 });
  });

  it('skips a scene that one of the runs lacks', () => {
    const lacking: BenchOutput = { adapter: 'a', rows: [], breakdown: {} };
    expect(compareTable([output(1, 1, 1, 1, 1), output(1, 1, 1, 1, 1)], [output(1, 1, 1, 1, 1), lacking])).toEqual([]);
  });

  it('shows the 1x numbers of each run', () => {
    const line = buildRunLine({
      fingerprint: 'f',
      dirty: false,
      commit: 'abcdef0123',
      date: '2026-10-30T20:00:00.000Z',
      driver: 'd',
      settings: {},
      idle: { before: 1, after: 1 },
      ...output(1.5, 0.25, 0.25, 1.0, 0.5),
    });
    expect(showTable([line])).toEqual([
      { date: line.date, commit: 'abcdef0', dirty: false, role: '', scene: name, frame: 1.5, ca: 0.5, sum: 1.0, render: 0.5 },
    ]);
  });
});
