import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type BenchOutput,
  type EngineUse,
  type ProcessEntry,
  type RunLine,
  addBenchOut,
  benchSettings,
  buildRunLine,
  compareTable,
  describeBlockers,
  describeBusy,
  findBlockers,
  findRuns,
  fingerprint,
  isBusy,
  isDirty,
  median,
  parseEngineUse,
  parseGpuSample,
  parseLog,
  parseTasklist,
  serializeLine,
  showTable,
} from './bench-log.ts';

// The bench CLI: `run` (npm run bench), `compare <base> [<head>]` (npm run bench:compare), `show [<ref>]`
// (npm run bench:show). The plan and the reasons are in AGENTS.md ("Benchmarks") and docs/decisions.md.

const ROOT = resolve(import.meta.dirname, '..');
const LOG = join(ROOT, 'bench', 'results.jsonl');
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 250;

// A run that must not happen or whose numbers are void: printed without a stack trace, exit code 1.
class Refusal extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface GpuReading {
  utilizations: number[];
  driver: string;
  name: string;
}

// About 2 s of nvidia-smi samples. Only the RTX 4080's numbers count, so a machine without nvidia-smi refuses.
async function sampleGpu(): Promise<GpuReading> {
  const utilizations: number[] = [];
  let last: ReturnType<typeof parseGpuSample> | undefined;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    let output: string;
    try {
      output = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,driver_version,name', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10_000 });
    } catch (error) {
      throw new Refusal(`nvidia-smi did not answer (${(error as Error).message}); only RTX 4080 numbers count, so the bench does not run here.`);
    }
    // One line per GPU; the NVIDIA card is the only one nvidia-smi lists.
    last = parseGpuSample(output.split(/\r?\n/)[0]);
    utilizations.push(last.utilization);
    if (i < SAMPLE_COUNT - 1) await sleep(SAMPLE_INTERVAL_MS);
  }
  return { utilizations, driver: last!.driver, name: last!.name };
}

// Best effort: the processes using the 3D engine, from the Windows GPU counters; empty when they do not answer.
function engineUse(): EngineUse[] {
  try {
    const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'bench', 'gpu-engines.ps1')], { encoding: 'utf8', timeout: 20_000 });
    return parseEngineUse(output);
  } catch {
    return [];
  }
}

// The running programs the bench refuses to run beside. Not best effort: a check that cannot run refuses, as nvidia-smi does.
function runningBlockers(): ProcessEntry[] {
  let output: string;
  try {
    output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 20_000 });
  } catch (error) {
    throw new Refusal(`tasklist did not answer (${(error as Error).message}), so the bench cannot tell whether Wallpaper Engine runs.`);
  }
  return findBlockers(parseTasklist(output));
}

// What keeps a reading from counting as idle, named, or undefined when it is idle.
function busyReason(reading: GpuReading): string | undefined {
  const blockers = runningBlockers();
  if (blockers.length > 0) return describeBlockers(blockers);
  if (isBusy(reading.utilizations)) return describeBusy(reading.utilizations, engineUse());
  return undefined;
}

// The idle reading (median utilization), or a refusal that names the load.
async function requireIdle(): Promise<GpuReading & { idle: number }> {
  const reading = await sampleGpu();
  const reason = busyReason(reading);
  if (reason !== undefined) throw new Refusal(`${reason}\nClose what uses the GPU and run it again.`);
  return { ...reading, idle: median(reading.utilizations) };
}

let child: ChildProcess | undefined;

function runVitest(cwd: string, outPath: string): Promise<number> {
  return new Promise((done, fail) => {
    child = spawn(process.execPath, [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.bench.config.ts'], {
      cwd,
      env: { ...process.env, BENCH_OUT: outPath },
      stdio: 'inherit',
    });
    child.once('error', fail);
    child.once('exit', (code) => {
      child = undefined;
      done(code ?? 1);
    });
  });
}

interface Target {
  dir: string;
  // Computed before an old harness is patched, so it names the code under test.
  fingerprint: string;
  dirty: boolean;
  commit: string;
}

function target(dir: string): Target {
  return {
    dir,
    fingerprint: fingerprint(dir),
    dirty: isDirty(dir),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
  };
}

// One bench run in `at.dir`: idle before, the bench, idle after, then one appended line. Nothing is appended otherwise.
async function benchRun(at: Target, tag?: { session: string; role: 'base' | 'head' }): Promise<RunLine> {
  const before = await requireIdle();
  const scratch = mkdtempSync(join(tmpdir(), 'cornisand-bench-out-'));
  try {
    const outPath = join(scratch, 'out.json');
    const code = await runVitest(at.dir, outPath);
    if (code !== 0) throw new Refusal(`The bench failed (exit code ${code}); nothing was logged.`);
    const after = await sampleGpu();
    const reason = busyReason(after);
    if (reason !== undefined) throw new Refusal(`${reason}\nThis was found after the run, so its numbers are void; nothing was logged.`);
    if (!existsSync(outPath)) throw new Refusal('The bench wrote no result (no GPU adapter, so its tests were skipped?); nothing was logged.');
    const output = JSON.parse(readFileSync(outPath, 'utf8')) as BenchOutput;
    const line = buildRunLine({
      fingerprint: at.fingerprint,
      dirty: at.dirty,
      commit: at.commit,
      date: new Date().toISOString(),
      gpu: before.name,
      driver: before.driver,
      settings: benchSettings(process.env),
      idle: { before: before.idle, after: median(after.utilizations) },
      ...tag,
      ...output,
    });
    appendFileSync(LOG, serializeLine(line));
    return line;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const worktrees: string[] = [];

// A temporary checkout of `ref`. node_modules is a junction to this checkout's when the lockfile matches, else `npm ci`.
async function addWorktree(ref: string, label: string, session: string): Promise<string> {
  const dir = join(tmpdir(), `cornisand-bench-${session}-${label}`);
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: ROOT, stdio: 'ignore' });
  worktrees.push(dir);
  const lockfile = (root: string): string => readFileSync(join(root, 'package-lock.json'), 'utf8').replaceAll('\r\n', '\n');
  if (lockfile(dir) === lockfile(ROOT)) {
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  } else {
    console.log(`${label}: package-lock.json differs from the checkout's, running npm ci there.`);
    const npm = process.env.npm_execpath;
    if (!npm) throw new Refusal('npm ci is needed for a base with another lockfile; start the compare through npm run bench:compare.');
    await new Promise<void>((done, fail) => {
      child = spawn(process.execPath, [npm, 'ci'], { cwd: dir, stdio: 'inherit' });
      child.once('error', fail);
      child.once('exit', (code) => {
        child = undefined;
        if (code === 0) done();
        else fail(new Error(`npm ci failed (exit code ${code})`));
      });
    });
  }
  return dir;
}

function removeWorktrees(): void {
  for (const dir of worktrees.splice(0)) {
    // Never let git or rm follow the junction into the real node_modules.
    const modules = join(dir, 'node_modules');
    if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
    try {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      // One stuck worktree (a file still open on Windows) must not keep the others from being removed.
      try {
        if (!(existsSync(modules) && lstatSync(modules).isSymbolicLink())) rmSync(dir, { recursive: true, force: true });
        execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore' });
      } catch (error) {
        console.error(`Could not remove ${dir}: ${(error as Error).message}\nRemove it with: git worktree remove --force "${dir}"`);
      }
    }
  }
}

// A base that predates BENCH_OUT cannot write its result: its own harness gets the lines that write it.
function ensureHarness(dir: string, label: string): void {
  const harness = join(dir, 'tests', 'bench.gpu.ts');
  const source = readFileSync(harness, 'utf8');
  if (source.includes('BENCH_OUT')) return;
  const patched = addBenchOut(source);
  if (patched === undefined) throw new Refusal(`${label}: its tests/bench.gpu.ts has no breakdown table (it predates M4.6a), so it cannot be compared.`);
  writeFileSync(harness, patched);
  console.log(`${label}: its tests/bench.gpu.ts predates BENCH_OUT, so the lines that write the result were added to it.`);
}

function requireCommit(ref: string): void {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    throw new Refusal(`"${ref}" is not a commit.`);
  }
}

async function compare(baseRef: string, headRef: string | undefined): Promise<void> {
  requireCommit(baseRef);
  if (headRef !== undefined) requireCommit(headRef);
  const session = new Date().toISOString().replaceAll(/\D/g, '').slice(0, 14);
  try {
    const base = target(await addWorktree(baseRef, 'base', session));
    const head = headRef === undefined ? target(ROOT) : target(await addWorktree(headRef, 'head', session));
    ensureHarness(base.dir, 'base');
    if (head.dir !== ROOT) ensureHarness(head.dir, 'head');
    const order = [
      { at: base, role: 'base' },
      { at: head, role: 'head' },
      { at: base, role: 'base' },
      { at: head, role: 'head' },
    ] as const;
    const lines: RunLine[] = [];
    for (const [i, { at, role }] of order.entries()) {
      console.log(`\n=== Run ${i + 1} of ${order.length}: ${role} (${at.commit.slice(0, 7)}${at.dirty ? ', working tree' : ''}) ===`);
      lines.push(await benchRun(at, { session, role }));
    }
    const rows = compareTable(
      lines.filter((line) => line.role === 'base'),
      lines.filter((line) => line.role === 'head'),
    );
    // A base older than the harness's `air` and `look` columns labels its scenes differently, so no row matches.
    if (rows.length === 0) throw new Refusal('No scene is in both sides\' results under the same label (an old base names its scenes differently); the four runs are logged.');
    console.log('\nGPU ms per 1x frame, mean of two runs a side. noise %: the larger gap between the two runs of the same code.');
    console.table(
      rows.map(({ scene, metric, base: b, head: h, deltaPct, noisePct }) => ({
        scene,
        metric,
        base: b,
        head: h,
        'delta %': deltaPct,
        'noise %': noisePct,
        verdict: Math.abs(deltaPct) <= noisePct ? 'within noise' : deltaPct > 0 ? 'slower' : 'faster',
      })),
    );
  } finally {
    removeWorktrees();
  }
}

function show(ref: string | undefined): void {
  if (ref !== undefined) requireCommit(ref);
  const print = fingerprint(ROOT, ref);
  const runs = existsSync(LOG) ? findRuns(parseLog(readFileSync(LOG, 'utf8')), print) : [];
  if (runs.length === 0) {
    console.log(`No logged runs for ${ref ?? 'the working tree'} (fingerprint ${print.slice(0, 12)}).`);
    return;
  }
  console.log(`${runs.length} logged run(s) for ${ref ?? 'the working tree'} (fingerprint ${print.slice(0, 12)}), newest first. GPU ms per 1x frame:`);
  console.table(showTable(runs));
}

// Ctrl+C: stop the child and its workers (a process whose cwd is a worktree keeps Windows from removing it), then clean up.
async function cleanupAndExit(): Promise<never> {
  const running = child;
  if (running?.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/pid', String(running.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      running.kill();
    }
    await Promise.race([new Promise((done) => running.once('exit', done)), sleep(5000)]);
    await sleep(500);
  }
  removeWorktrees();
  process.exit(130);
}

async function main(): Promise<void> {
  mkdirSync(join(ROOT, 'bench'), { recursive: true });
  process.once('SIGINT', () => void cleanupAndExit());
  process.once('SIGTERM', () => void cleanupAndExit());
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'run':
      await benchRun(target(ROOT));
      console.log(`Logged to ${LOG}`);
      break;
    case 'compare':
      if (args.length < 1 || args.length > 2) throw new Refusal('Usage: npm run bench:compare <base> [<head>]');
      await compare(args[0], args[1]);
      break;
    case 'show':
      show(args[0]);
      break;
    default:
      throw new Refusal('Usage: node bench/bench.ts run | compare <base> [<head>] | show [<ref>]');
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof Refusal) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
}
