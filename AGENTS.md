# CorniSand — agent guide

Falling-sand sandbox running entirely on the GPU: WGSL compute shaders run a Margolus cellular automaton over storage buffers (sand, liquids, gases and fire by local rules), and a fullscreen-triangle render pass draws the result. TypeScript, Vite, native WebGPU, no framework.

## Commands

```bash
npm run dev       # Vite dev server
npm run build     # tsc --noEmit, then production build → dist/
npm run typecheck # tsc --noEmit (strict; covers src, tests, vite.config.ts)
npm run lint      # ESLint (typescript-eslint, type-aware)
npm test          # Vitest
npm run preview   # Serve dist/
npm run bench     # GPU time of a frame of the CA at 2560×1340 at 1x to 8x for `tank` and `mix75`, and the simulation creation time (tests/bench.gpu.ts), and the M4.1 movement prototype's tables (tests/proto-movement.bench.gpu.ts); needs a GPU adapter
```

CI (`.github/workflows/deploy-pages.yml`) runs lint, test and build before deploying.

The GPU suites in `tests/` run the real WGSL through Dawn's Node bindings (`webgpu` package, `tests/gpu.ts`) and skip themselves when no adapter is available, as on the CI runners (`docs/backlog.md` D11). `tests/gpu.ts` must keep a module-level reference to the GPU instance: Dawn crashes the process if it is garbage-collected while its device is in use.

## Stack facts not in config

- WebGPU only, no WebGL fallback. Targets Chrome 113+, Edge 113+, Safari 18.2+.
- The reference machine is an RTX 4080. Every size and resolution (field, cells per pixel, air, gravity and light grids, CA steps per frame) is a setting, not a hard-coded constant, so it can be scaled down later (`docs/decisions.md`).
- `.github/workflows/deploy-pages.yml` builds and deploys to GitHub Pages on every push to `main`; `vite.config.ts` sets `base: './'` for that.
- The simulation grid is one cell per CSS pixel of the canvas, or the smallest integer cells-per-pixel scale that fits the device's storage-buffer limits (`src/grid.ts`). It is sized once at load (`src/main.ts`); resizing stretches it (see `docs/decisions.md`).
- The user's npm `min-release-age` is 7 days: `npm install` picks the newest version at least that old, not `latest`.
- TypeScript stays on 6.0.x until typescript-eslint supports 7 (`docs/backlog.md` D10).

## Layout

- `src/main.ts` — entry: WebGPU init and device re-creation, UI wiring (tool selection, speed), frame loop (one encoder, one submit per frame).
- `src/gpu.ts` — adapter/device/context setup with the adapter's buffer limits, uncaptured-error banner, device-lost callback, reload overlay.
- `src/grid.ts` — `computeGrid`: grid size and scale from the buffer limits.
- `src/simulation.ts` — compute pipelines (brush, CA, particle count); `simulate(encoder, supersteps, input)` records the brush pass and the CA steps into the caller's encoder.
- `src/cell-buffer.ts` — ping-pong pair of cell storage buffers.
- `src/display.ts` — render pipeline drawing the current cell buffer plus the brush ring.
- `src/input.ts` — pointer, wheel and Shift state.
- `src/particles.ts` — particle type IDs and fire max life, the single source for TS and every shader.
- `src/shaders/*.wgsl.ts` — WGSL sources exported as template strings (functions of the grid size where needed): `cell` (shared snippet: type constants, cell accessors, PCG hash, `CELL_BYTES`), `ca` (all particle rules), `brush`, `display`.
- `src/proto/` and `proto.html` — the M4.1 movement prototype (`docs/plans/m4-element-engine.md`): models A and C side by side at `/proto.html` under `npm run dev`, not built into `dist/`; deleted by M4.5c.
- `src/scenes.ts` — scene builders (`SCENES`) shared by the tests and the `?scene=<name>` loader in `main.ts` (`findScene`).
- `tests/` — Vitest: `grid`, `hash`, `metrics` and `scenes` (unit), `simulation` (GPU: the rules, and the liquid, sinking and fire behaviors as scenes with numeric thresholds), `gpu.ts` (device, scene upload and readback helpers), `metrics.ts` (column levels, flatness, layer order), `bench.gpu.ts` (`npm run bench`), `proto-*` (the movement prototype).

## Docs map

- `docs/simulation.md` — how the step pipeline and the CA rules work. Update it when rules, passes or the cell format change.
- `docs/decisions.md` — architectural decisions and the alternatives they rule out.
- `docs/roadmap.md` — milestones (M4–M9: The Powder Toy on the GPU) and what defines each as done.
- `docs/backlog.md` — known bugs, tech debt and ideas, one line each.
- `docs/powder-toy.md` — what The Powder Toy simulates, how each part maps to the GPU, the frame budget, and what goes beyond it.
- `docs/plans/` — plans in progress only; deleted when the feature ships.

## Invariants

- A cell is one `u32`: bits 0–7 type, 8–15 variant, 16–31 lifetime. The layout, the accessors (`cellType`, `cellVariant`, `cellLife`, `makeCell`) and `CELL_BYTES` live in `src/shaders/cell.wgsl.ts`, which every shader includes; change the layout there only.
- Particle type IDs and the fire max life are declared once in `particles.ts` and reach the shaders through `cell.wgsl.ts`. Only the `index.html` `data-type` attributes repeat the IDs: keep them in sync.
- Every CA dispatch reads the current buffer and writes the other one, then `CellBuffer.swap()`. Bind groups for both directions are pre-created; pick them from `currentBuffer`. The brush pass is the exception: it edits the current buffer in place (each thread touches only its own cell) and does not swap.
- One thread handles one 2×2 block and writes all four cells. Out-of-bounds reads (`readCell`) return a wall cell, the world boundary; out-of-bounds writes are skipped.
- The Margolus offset alternates 0 then 1; never run two steps with the same offset in a row.
- A frame is one `GPUCommandEncoder` and one `submit()`: `simulate()` records the brush pass and all CA steps, then `main.ts` records the render. Each CA dispatch has its own `{ offset, seed }` slot in one uniform buffer (stride `minUniformBufferOffsetAlignment`, selected by dynamic offset, written once per frame). Never submit mid-frame, and never `writeBuffer` a shared uniform between dispatches: all writes land before the first dispatch runs.
- A liquid cell's `life` field holds its sideways direction (0 none, 1 left, 2 right), not a lifetime; only the liquid spread rule reads it (`spreadRow` in `ca.wgsl.ts`).
- The brush runs once per frame, before the CA steps, along the segment from the previous frame's position.
- Block randomness comes from `pcg()` chained on `hash2(blockX, blockY, seed)`; never use a float `fract`-based hash for it.

## Adding a particle type

1. Add the ID to `PARTICLE_TYPES` in `src/particles.ts`.
2. Add an `isX()` helper in `src/shaders/ca.wgsl.ts` (`TYPE_X` is generated from step 1); update `isFalling`, `isLiquid`, `fallRank` (the density order of falling cells), `isGas`, `canDisplace`, `canRiseThrough` as needed.
3. Add movement or reaction rules in the CA phases; if it has a lifetime, declare its start value next to `FIRE_MAX_LIFE` and set it in `src/shaders/brush.wgsl.ts`.
4. Add its color in `src/shaders/display.wgsl.ts`.
5. Add a toolbar button in `index.html` (`data-type` = the ID). Number keys select the n-th toolbar button, so the button's position sets its key.
6. Update the density ordering and phase list in `docs/simulation.md`.

## Working with the user

The user is an experienced web developer, not a physics, numerics or GPU specialist.

- Plans and docs may use precise technical terms. Anything addressed to the user (a decision request, a gate report's summary, a "needs your testing" list, a final report) says in plain words what changes for them in the game: how it looks, feels, how fast it runs, what they can do. It names the mechanism only after that, if at all.
- Ask the user only decisions with a visible or usable effect. Technical choices without one (constants, solver settings, data layouts, which algorithm passes the tests) are the agent's to make: decide, record the reason in the plan or `docs/decisions.md`, and say in one line what was chosen.
- When a decision does need the user, show it: a `?scene=` to open, a before and after, what to look for. Never ask them to pick between parameter values.
- A sub-agent's decision requests are rewritten this way before they reach the user.

## Never

- Never translate The Powder Toy's source code or copy its element tables: it is GPLv3 (`docs/decisions.md`).
- Never claim a water or physics behavior works from a visual check alone. Water realism failed repeatedly that way; any physics change needs a measurable, repeatable check, such as a scene test with a numeric threshold.
- Never tune a constant without confirming that the value actually reaches a rule that moves particles.
