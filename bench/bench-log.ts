import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The pure and git-reading parts of the bench CLI (bench.ts), tested by tests/bench-log.test.ts.

// The GPU counts as busy above this utilization (%), as the median of the samples.
export const IDLE_MAX = 10;

// What the bench measures: the simulation and renderer, the harness and its device setup, the lockfile (a driver of
// Dawn's version) and the bench config. A change elsewhere does not change a run's numbers.
export const FINGERPRINT_PATHS = ['src', 'tests/bench.gpu.ts', 'tests/gpu.ts', 'package-lock.json', 'vitest.bench.config.ts'];

export interface GpuSample {
  utilization: number;
  driver: string;
  name: string;
}

export interface EngineUse {
  pid: number;
  name: string;
  percent: number;
}

export interface Idle {
  before: number;
  after: number;
}

export type BenchRows = Record<string, string | number>[];
export type Breakdown = Record<string, Record<string, number>>;

export interface BenchOutput {
  adapter: string;
  rows: BenchRows;
  breakdown: Breakdown;
}

export interface RunLine extends BenchOutput {
  fingerprint: string;
  dirty: boolean;
  commit: string;
  date: string;
  driver: string;
  settings: Record<string, string>;
  idle: Idle;
  session?: string;
  role?: 'base' | 'head';
}

// One line of `nvidia-smi --query-gpu=utilization.gpu,driver_version,name --format=csv,noheader,nounits`.
export function parseGpuSample(line: string): GpuSample {
  const [utilization, driver, ...name] = line.split(',').map((part) => part.trim());
  const value = Number(utilization);
  if (!Number.isFinite(value) || !driver || name.length === 0) throw new Error(`Unexpected nvidia-smi output: "${line}"`);
  return { utilization: value, driver, name: name.join(', ') };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function isBusy(utilizations: number[], idleMax = IDLE_MAX): boolean {
  return median(utilizations) > idleMax;
}

// Lines of `<counter instance>\t<percent>\t<process name>`, one per `engtype_3D` instance of the Windows GPU counters. The
// instance names start with `pid_<pid>_`. The result sums a process's engines, busiest first, without the idle ones.
export function parseEngineUse(output: string, minPercent = 1): EngineUse[] {
  const byPid = new Map<number, EngineUse>();
  for (const line of output.split(/\r?\n/)) {
    const [instance, percent, name] = line.split('\t');
    const pid = /^pid_(\d+)_/.exec(instance ?? '')?.[1];
    const value = Number(percent);
    if (pid === undefined || !Number.isFinite(value)) continue;
    const use = byPid.get(Number(pid)) ?? { pid: Number(pid), name: name?.trim() || `pid ${pid}`, percent: 0 };
    use.percent += value;
    byPid.set(use.pid, use);
  }
  return [...byPid.values()]
    .filter((use) => use.percent >= minPercent)
    .map((use) => ({ ...use, percent: Math.round(use.percent) }))
    .sort((a, b) => b.percent - a.percent);
}

export function describeBusy(utilizations: number[], uses: EngineUse[]): string {
  const lines = [`The GPU is busy: ${Math.round(median(utilizations))} % utilization (samples ${utilizations.join(', ')}), idle is at most ${IDLE_MAX} %.`];
  if (uses.length > 0) lines.push('3D engine use by process:', ...uses.map((use) => `  ${use.name} (pid ${use.pid}): ${use.percent} %`));
  return lines.join('\n');
}

// The working tree's text with the line endings git would store, so a checkout with CRLF and a blob with LF agree.
const normalize = (content: Buffer): string => content.toString('utf8').replaceAll('\r\n', '\n');

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

const gitList = (cwd: string, args: string[]): string[] =>
  git(cwd, args).toString('utf8').split('\0').filter((entry) => entry !== '');

// SHA-256 over the paths and contents of the measured files: of the working tree (tracked files and files git would track),
// or of `ref`'s commit.
export function fingerprint(cwd: string, ref?: string): string {
  const files =
    ref === undefined
      ? gitList(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...FINGERPRINT_PATHS])
      : gitList(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...FINGERPRINT_PATHS]);
  const hash = createHash('sha256');
  for (const path of [...new Set(files)].sort()) {
    let content: Buffer;
    if (ref === undefined) {
      try {
        content = readFileSync(join(cwd, path));
      } catch {
        continue; // tracked, deleted from the working tree
      }
    } else {
      content = git(cwd, ['show', `${ref}:${path}`]);
    }
    hash.update(`${path}\0${createHash('sha256').update(normalize(content)).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

// True when a measured file differs from HEAD, a file git does not track yet included.
export function isDirty(cwd: string): boolean {
  return gitList(cwd, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...FINGERPRINT_PATHS]).length > 0;
}

// The `BENCH_*` variables a run was started with, minus the output path the CLI sets itself.
export function benchSettings(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[0].startsWith('BENCH_') && entry[0] !== 'BENCH_OUT' && entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function buildRunLine(parts: RunLine): RunLine {
  const { fingerprint: print, dirty, commit, date, adapter, driver, settings, idle, rows, breakdown, session, role } = parts;
  return {
    fingerprint: print,
    dirty,
    commit,
    date,
    adapter,
    driver,
    settings,
    idle,
    ...(session !== undefined && { session }),
    ...(role !== undefined && { role }),
    rows,
    breakdown,
  };
}

export const serializeLine = (line: RunLine): string => `${JSON.stringify(line)}\n`;

export function parseLog(text: string): RunLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunLine);
}

// The runs of one code state, newest first.
export function findRuns(runs: RunLine[], print: string): RunLine[] {
  return runs.filter((run) => run.fingerprint === print).sort((a, b) => b.date.localeCompare(a.date));
}

export interface Metrics {
  [metric: string]: number;
}

export const METRICS = ['frame', 'ca', 'sum', 'render'] as const;

const key = (scene: string | number, air: string | number, look: string | number): string => `${scene} (air ${air}, ${look} look)`;

// A run's numbers at 1x by "scene (air a, look l)": the frame median, `ca0` + `ca1`, `sum` and `render` of the breakdown.
export function metricsAt1x(run: BenchOutput): Map<string, Metrics> {
  const result = new Map<string, Metrics>();
  for (const row of run.rows) {
    if (row.speed !== '1x') continue;
    result.set(key(row.scene, row.air, row.look), { frame: Number(row.msMedian) });
  }
  for (const [name, passes] of Object.entries(run.breakdown)) {
    const metrics = result.get(name) ?? {};
    metrics.ca = (passes.ca0 ?? 0) + (passes.ca1 ?? 0);
    metrics.sum = passes.sum;
    metrics.render = passes.render;
    result.set(name, metrics);
  }
  return result;
}

export interface CompareRow {
  scene: string;
  metric: string;
  base: number;
  head: number;
  deltaPct: number;
  noisePct: number;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const round = (x: number, digits: number): number => Number(x.toFixed(digits));

// The gap between the two runs of one code, as a share of their mean: how far the same code strays from itself.
function gapPct(values: number[]): number {
  const m = mean(values);
  return m === 0 ? 0 : ((Math.max(...values) - Math.min(...values)) / m) * 100;
}

// A metric of a scene in every run, or undefined when a run lacks it (or there are no runs).
function valuesOf(runs: Map<string, Metrics>[], scene: string, metric: string): number[] | undefined {
  const values = runs.map((run) => run.get(scene)?.[metric]);
  return values.length > 0 && values.every((value) => value !== undefined) ? values : undefined;
}

// Rows for the base runs and the head runs (two of each, back to back): per scene, look and air setting at 1x, each metric's
// mean per side, the head's change in %, and the larger of the two sides' gaps in %.
export function compareTable(baseRuns: BenchOutput[], headRuns: BenchOutput[]): CompareRow[] {
  const base = baseRuns.map(metricsAt1x);
  const head = headRuns.map(metricsAt1x);
  const rows: CompareRow[] = [];
  for (const scene of base[0]?.keys() ?? []) {
    for (const metric of METRICS) {
      const baseValues = valuesOf(base, scene, metric);
      const headValues = valuesOf(head, scene, metric);
      if (!baseValues || !headValues) continue;
      const baseMean = mean(baseValues);
      const headMean = mean(headValues);
      rows.push({
        scene,
        metric,
        base: round(baseMean, 3),
        head: round(headMean, 3),
        deltaPct: baseMean === 0 ? 0 : round(((headMean - baseMean) / baseMean) * 100, 1),
        noisePct: round(Math.max(gapPct(baseValues), gapPct(headValues)), 1),
      });
    }
  }
  return rows;
}

export interface ShowRow {
  date: string;
  commit: string;
  dirty: boolean;
  role: string;
  scene: string;
  frame: number;
  ca: number;
  sum: number;
  render: number;
}

// The 1x numbers of each run, newest run first.
export function showTable(runs: RunLine[]): ShowRow[] {
  return runs.flatMap((run) =>
    [...metricsAt1x(run)].map(([scene, m]) => ({
      date: run.date,
      commit: run.commit.slice(0, 7),
      dirty: run.dirty,
      role: run.role ?? '',
      scene,
      frame: m.frame ?? NaN,
      ca: round(m.ca ?? NaN, 3),
      sum: m.sum ?? NaN,
      render: m.render ?? NaN,
    })),
  );
}
