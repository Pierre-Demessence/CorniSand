# Bench log and back-to-back compare

Status: approved; implemented, reviewed and committed up to the last item, which waits for a free GPU.

Busy-path checks ran live (a game at 60 to 80 %): `npm run bench` and `bench:compare HEAD` refused, named `enshrouded`, logged nothing and left no worktree. The whole run/compare/show path was also run once with `IDLE_MAX` raised temporarily (its void lines were deleted). Ctrl+C cleanup is unverified (an agent cannot send a console Ctrl+C): the user presses it once during the last step.

## Goal

The bench refuses to run while another program loads the GPU and saves each clean run with the code it measured, and a speed check compares a base and a result back to back at the end of a task: no task waits for a free GPU to start, and a busy GPU only postpones the check.

## Acceptance criteria

- AC1: WHEN `npm run bench` starts while the GPU's utilization (median of `nvidia-smi` samples over about 2 s) is above `IDLE_MAX`, it exits 1 before starting vitest, prints the utilization and, when the Windows GPU counters answer, the processes using the 3D engine with their share, and appends nothing. Check: unit test of the parsers and the decision; one run while a game is open (at plan time: 80 %, `enshrouded` at 67 %).
- AC2: WHEN a bench run finishes and the GPU is idle before and 2 s after it, one line is appended to `bench/results.jsonl`: fingerprint, `dirty`, HEAD commit, ISO date, adapter description, NVIDIA driver version, the `BENCH_*` settings, the idle reading, and the `rows` and `breakdown` tables the bench prints. WHEN the after-check finds the GPU busy, nothing is appended and it exits 1 saying the numbers are void. Check: unit test of the line builder; one real run.
- AC3: The fingerprint is a SHA-256 over the paths and working-tree contents of the files git tracks or would track under `src/`, `tests/bench.gpu.ts`, `tests/gpu.ts`, `package-lock.json` and `vitest.bench.config.ts`. A change elsewhere (docs, another test) leaves it equal; a change to one of them, committed or not, changes it; `dirty` is true when one of them differs from HEAD. Check: unit test on a temporary git repository.
- AC4: WHEN `npm run bench:compare <base> [<head>]` runs, it benches base, head, base, head (head defaults to the working tree), logs the four runs with a shared `session` and their `role`, and prints for each scene, look and air setting at 1x the frame median and, from the breakdown, `ca0` + `ca1`, `sum` and `render`: base mean, head mean, delta in %, and the larger gap between two runs of the same code. Its temporary worktrees are removed on success, on failure and on Ctrl+C. Check: unit test of the table on fixture results; `bench:compare HEAD` on a free GPU shows deltas within the gaps.
- AC5: WHEN the GPU is busy before any of the four runs, the compare stops, keeps the runs already logged, removes its worktrees and exits 1. Check: one run while a game is open; `git worktree list` afterwards.
- AC6: WHEN a base's `tests/bench.gpu.ts` predates `BENCH_OUT`, the compare copies the current harness into that worktree and says so. Check: `bench:compare 6e9ea45` on a free GPU.
- AC7: `npm run bench:show [<ref>]` prints the logged runs whose fingerprint matches the working tree (or the ref), newest first, as the 1x table, or says there are none. Check: unit test of the lookup on fixture lines; once by hand.
- AC8: `git check-attr merge bench/results.jsonl` prints `union`.
- AC9: `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass; `npm test` does not start a bench.

## Design

- `bench/bench.ts` is the CLI (`run`, `compare`, `show`), run by Node 24's type stripping (`node bench/bench.ts …`): no `tsx`, no new dependency. It spawns `nvidia-smi`, `pwsh`, `git`, `npm` and vitest with argument arrays, never a shell string. `tsconfig.json` gains `bench` in `include`, `allowImportingTsExtensions` and `noEmit` (Node needs the `.ts` in `./bench-log.ts`); `eslint.config.js` gives `bench/**/*.ts` the node globals.
- `bench/bench-log.ts` holds the pure parts, tested by `tests/bench-log.test.ts` (unit, runs in CI): the `nvidia-smi` and counter parsers, `isBusy`, `fingerprint`, the log line, `compareTable`, `findRuns`.
- `tests/bench.gpu.ts`: WHEN `BENCH_OUT` is set, it writes `{ adapter, rows, breakdown }` as JSON to that path. Nothing else in the harness changes.
- GPU check: `nvidia-smi --query-gpu=utilization.gpu,driver_version,name --format=csv,noheader,nounits`, about 8 samples over 2 s; busy when the median is above `IDLE_MAX` (10 % until the last step calibrates it). Process names: `Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage'` through `pwsh -NoProfile` (the English counter path works on this French-locale Windows), the pid from the instance name, the name from `Get-Process`; best effort, left out when it fails. No `nvidia-smi` means another machine: the bench refuses, since only RTX 4080 numbers count.
- Log: `bench/results.jsonl`, one JSON object per line, append-only, committed with the work it measures. `.gitattributes`: `bench/results.jsonl merge=union`, so two branches that both logged runs merge without a conflict.
- Worktrees: `git worktree add --detach` under the OS temp folder; `node_modules` is a directory junction to the checkout's when `package-lock.json` is identical, else `npm ci` there. A head that defaults to the working tree runs in the checkout itself, uncommitted changes included.
- The compare reruns the base instead of reusing its logged run: two runs of the same code minutes apart differ by up to about 20 % (`tank` 1.11 and 0.92 ms, backlog D43), and days apart add driver, clock and heat differences; only back-to-back runs tell a change from noise. The log is for history and lookups (`docs/decisions.md`).
- Workflow (`AGENTS.md`): a speed check is `bench:compare <base>` at the end of an item, never a baseline at its start, since the base stays in git. WHEN the bench refuses, the item is committed with `Bench pending: npm run bench:compare <base> <commit>` under it in its plan, the run continues, and the plan cannot finish until each pending compare has run and its result is recorded under its item.

## Checklist

- [x] `bench/bench-log.ts` and `tests/bench-log.test.ts`.
- [x] `tests/bench.gpu.ts`: `BENCH_OUT`.
- [x] `bench/bench.ts`; `package.json` scripts `bench` (now `node bench/bench.ts run`), `bench:compare`, `bench:show`; `tsconfig.json`, `eslint.config.js`, `.gitattributes`.
- [x] Busy-path checks while the GPU is loaded (AC1, AC5); skipped with a note if it happens to be free.
- [x] `AGENTS.md`: Commands (the three scripts, what they log and when they refuse), Stack facts (the GPU check is automatic and names what to close), Layout (`bench/`), a Benchmarks paragraph with the workflow above. `docs/decisions.md`: a "Bench runs are compared back to back; the log is history" entry. `docs/plans/m12.14-substances.md`: M12.14a's two bench steps become one `bench:compare` at its end with the pending rule, AC10's check names `bench:compare`, and its `Needs you` becomes `(at the end)`.
- [x] Review, then commit the code, the docs and this plan.
- [ ] When the user says the GPU is free: calibrate `IDLE_MAX` from the idle reading with the desktop as usual and with the live wallpaper running, so the wallpaper counts as busy (if the two readings overlap, busy becomes "a process other than `dwm` above the threshold" in the counters), recorded here; `npm run bench` (AC2), `bench:compare HEAD` (AC4), `bench:compare 6e9ea45` (AC6), `bench:show` (AC7), and one Ctrl+C during `bench:compare` followed by `git worktree list` (AC4). Commit the logged lines and delete this plan.

Visible after: nothing in the game. `npm run bench` refuses while a game runs and names it; `bench:compare` and `bench:show` exist; plan items no longer need a free GPU to start.
Needs you: say when the GPU is free, and pause the live wallpaper when the agent asks, for the last step (at the end).
