# CorniSand — agent guide

Falling-sand sandbox running entirely on the GPU: WGSL compute shaders run a Margolus cellular automaton over storage buffers, and a fullscreen-triangle render pass draws the result. TypeScript, Vite, native WebGPU, no framework.

## Commands

```bash
npm run dev       # Vite dev server
npm run build     # tsc --noEmit, then production build → dist/
npm run typecheck # tsc --noEmit (strict; covers src, tests, vite.config.ts)
npm run lint      # ESLint (typescript-eslint, type-aware)
npm test          # Vitest
npm run preview   # Serve dist/
npm run bench     # GPU timing of a frame and of every fluid pass at 2560×1340 (tests/bench.gpu.ts); needs a GPU adapter
SCREEN=1 npx vitest run solver-screen  # pressure-solver measurements at screen size (skipped otherwise)
```

CI (`.github/workflows/deploy-pages.yml`) runs lint, test and build before deploying.

The GPU suites in `tests/` run the real WGSL through Dawn's Node bindings (`webgpu` package, `tests/gpu.ts`) and skip themselves when no adapter is available, as on the CI runners (`docs/backlog.md` D11). `tests/gpu.ts` must keep a module-level reference to the GPU instance: Dawn crashes the process if it is garbage-collected while its device is in use.

## Stack facts not in config

- WebGPU only, no WebGL fallback. Targets Chrome 113+, Edge 113+, Safari 18.2+.
- `.github/workflows/deploy-pages.yml` builds and deploys to GitHub Pages on every push to `main`; `vite.config.ts` sets `base: './'` for that.
- The simulation grid is one cell per CSS pixel of the canvas, or the smallest integer cells-per-pixel scale that fits the device's storage-buffer limits (`src/grid.ts`). It is sized once at load (`src/main.ts`); resizing stretches it (see `docs/decisions.md`).
- The user's npm `min-release-age` is 7 days: `npm install` picks the newest version at least that old, not `latest`.
- TypeScript stays on 6.0.x until typescript-eslint supports 7 (`docs/backlog.md` D10).

## Layout

- `src/main.ts` — entry: WebGPU init and device re-creation, UI wiring (tool selection, speed), frame loop (one encoder, one submit per frame).
- `src/gpu.ts` — adapter/device/context setup with the adapter's buffer limits, uncaptured-error banner, device-lost callback, reload overlay.
- `src/grid.ts` — `computeGrid`: grid size and scale from the buffer limits.
- `src/simulation.ts` — compute pipelines (brush, CA, particle count); `simulate(encoder, supersteps, input)` records the brush pass and the CA steps into the caller's encoder.
- `src/fluid.ts` — the liquids: particle store, the grid and particle passes of a fluid step, and the pressure solve (`FLUID.solver`: `'multigrid'`, conjugate gradients preconditioned by a V-cycle, or the plain red-black `'sor'`, kept as the bench baseline). The grid passes run over lists of active 8×8 tiles (`FluidTileBuffers`, `tilesWGSL` in `fluid-common.wgsl.ts`; `docs/simulation.md`). `src/fluid-params.ts` holds every fluid constant and the multigrid level helpers; the CPU reference in `tests/cpu/` and the shaders read the same values.
- `src/cell-buffer.ts` — ping-pong pair of cell storage buffers.
- `src/display.ts` — render pipeline drawing the current cell buffer plus the brush ring.
- `src/input.ts` — pointer, wheel and Shift state.
- `src/particles.ts` — particle type IDs and fire max life, the single source for TS and every shader.
- `src/shaders/*.wgsl.ts` — WGSL sources exported as template strings (functions of the grid size where needed): `cell` (shared snippet: type constants, cell accessors, PCG hash, `CELL_BYTES`), `solid-ca` (all particle rules), `brush`, `display`. The fluid shaders are `fluid-common`, `fluid-grid` (grid passes and the plain sweeps), `fluid-multigrid` (coarse operators, V-cycle, conjugate-gradient kernels), `fluid-particles` and `fluid-raster`.
- `src/scenes.ts` — scene builders (`SCENES`) shared by the tests and the `?scene=<name>` loader in `main.ts` (`findScene`).
- `tests/` — Vitest: `grid` (unit), `hash`, `simulation` and the `fluid-*` suites (GPU: `fluid-particles`, `fluid-raster`, `fluid-solver`, `fluid-multigrid` and `fluid-parity` compare each fluid pass and the whole step with the CPU reference; `fluid-tiles` runs active tiles against `activeTiles: false` bit for bit), `liquids-gpu` (the liquid acceptance criteria on the GPU through read-back), `bench.gpu.ts` (`npm run bench`), `gpu.ts` (device, scene upload and readback helpers), `scenes`, `metrics`, `cpu/` (test-only CPU reference of the fluid code: grid, solver with SOR and multigrid, particles; `solver-experiments.ts` and `solver-screen.test.ts` measure the solvers) and `liquids-*.test.ts` (liquid acceptance criteria run on that reference through `LiquidModel`).

## Docs map

- `docs/simulation.md` — how the step pipeline and the CA rules work. Update it when rules, passes or the cell format change.
- `docs/decisions.md` — architectural decisions and the alternatives they rule out.
- `docs/roadmap.md` — milestones (M2 gases, M3 solids) and what defines each as done.
- `docs/backlog.md` — known bugs, tech debt and ideas, one line each.
- `docs/research/` — undecided topics with options and open questions.
- `docs/plans/` — plans in progress only; deleted when the feature ships.

## Invariants

- A cell is one `u32`: bits 0–7 type, 8–15 variant, 16–31 lifetime. The layout, the accessors (`cellType`, `cellVariant`, `cellLife`, `makeCell`) and `CELL_BYTES` live in `src/shaders/cell.wgsl.ts`, which every shader includes; change the layout there only.
- Particle type IDs and the fire max life are declared once in `particles.ts` and reach the shaders through `cell.wgsl.ts`. Only the `index.html` `data-type` attributes repeat the IDs: keep them in sync.
- Every CA dispatch reads the current buffer and writes the other one, then `CellBuffer.swap()`. Bind groups for both directions are pre-created; pick them from `currentBuffer`. The brush pass is the exception: it edits the current buffer in place (each thread touches only its own cell) and does not swap.
- One thread handles one 2×2 block and writes all four cells. Out-of-bounds reads (`readCell`) return a wall cell, the world boundary; out-of-bounds writes are skipped.
- The Margolus offset alternates 0 then 1; never run two steps with the same offset in a row.
- A frame is one `GPUCommandEncoder` and one `submit()`: `simulate()` records the brush pass and all CA steps, then `main.ts` records the render. Each CA dispatch has its own `{ offset, seed }` slot in one uniform buffer (stride `minUniformBufferOffsetAlignment`, selected by dynamic offset, written once per frame). Never submit mid-frame, and never `writeBuffer` a shared uniform between dispatches: all writes land before the first dispatch runs.
- A fluid pass that runs over the tile lists reads `tileCell(wid, lid)` instead of `global_invocation_id`, and a new pass over liquid state needs the clear set (not only the active set) if it writes "no liquid" values. `activeTiles: false` must stay bit-identical to the default (`tests/fluid-tiles.test.ts`).
- The fluid passes exist twice, in WGSL (`src/shaders/fluid-*.wgsl.ts`) and in the CPU reference (`tests/cpu/`), and change together; the GPU parity tests compare them. Every fluid constant lives once in `src/fluid-params.ts`, which the shaders interpolate and the reference imports; the key formulas (`rasterKey`, `oilKey`) are written in both languages and a GPU test checks they agree.
- The CA never moves liquid: water and oil cells change only in `writeCells` (the last fluid pass) and the brush. Rasterization never overwrites wall, sand, smoke or fire, and fire still ignites oil cells.
- Liquid cells and liquid particles are separate state: a code path that adds or removes liquid cells must add or remove the matching particles (4 per cell), or the next rasterization redraws the liquid from the particles. The brush spawns and kills them; `resolve` kills the oil particles in a fire cell.
- The brush runs once per frame, before the CA steps, along the segment from the previous frame's position.
- Block randomness comes from `pcg()` chained on `hash2(blockX, blockY, seed)`; never use a float `fract`-based hash for it.

## Adding a particle type

1. Add the ID to `PARTICLE_TYPES` in `src/particles.ts`.
2. Add an `isX()` helper in `src/shaders/solid-ca.wgsl.ts` (`TYPE_X` is generated from step 1); update `isFalling`, `isGas`, `canDisplace`, `canRiseThrough` as needed. A liquid is not a CA type: it also needs a `PARTICLE_KIND` and a density in `src/fluid-params.ts`, particle spawn and kill in `brush.wgsl.ts` and `fluid-particles.wgsl.ts`, a place in `classify`, the rasterization keys and the oil-style selection in `fluid-raster.wgsl.ts`, and the same change in `tests/cpu/flip.ts`.
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

- Never claim a water or physics behavior works from a visual check alone. Water realism failed repeatedly that way; any physics change needs a measurable, repeatable check, such as a scene test with a numeric threshold.
- Never tune a constant without confirming that the value actually reaches a rule that moves particles.
