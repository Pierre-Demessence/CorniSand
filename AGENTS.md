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
- `src/cell-fields.ts` — `CELL_FIELDS`, the one list of per-cell fields (name, WGSL type), plus `CellData` and `FIELD_BYTES`.
- `src/cell-field-buffers.ts` — `CellFields`: one storage buffer per field, the shared bind groups (`@group(1)`), `load`, `clear`, `read(name)` for tests.
- `src/display.ts` — render pipeline drawing the cell field buffers plus the brush ring.
- `src/input.ts` — pointer, wheel and Shift state.
- `src/elements.ts` — `ELEMENTS`, the element table (one row per material: ID, label, color, state, density, flammable, life, rule, graphics, toolbar position), `ELEMENT` (key → ID), `validateElements`.
- `src/element-table.ts` — `PROP_FIELDS` (the GPU's view of a row), `packElements`, `ElementTable` (the uniform buffer and its bind group, `@group(2)`).
- `src/toolbar.ts` — `toolbarEntries` (the paintable elements in toolbar order) and `renderToolbar`; `main.ts` builds the buttons from them.
- `src/shaders/*.wgsl.ts` — WGSL sources exported as template strings (functions of the grid size and the table where needed): `cell` (`commonWGSL`: the PCG hash; `cellWGSL(access, elements)`: the element constants, the `Cell` struct, the field bindings, `loadCell`, `storeCell`, `storeChanged` and the accessors, generated from `CELL_FIELDS`), `elements` (`EL_*` and `ST_*` constants, the `ElementProps` struct, the table uniform and its accessors), `ca` (the generic CA phases), `brush`, `display`, `graphics` (the display color functions by name), `rules/` (the optional element rules, `rules/index.ts` registers them by name).
- `src/proto/` and `proto.html` — the M4.1 movement prototype (`docs/plans/m4-element-engine.md`): models A and C side by side at `/proto.html` under `npm run dev`, not built into `dist/`; deleted by M4.5c.
- `src/scenes.ts` — scene builders (`SCENES`) shared by the tests and the `?scene=<name>` loader in `main.ts` (`findScene`).
- `tests/` — Vitest: `grid`, `hash`, `metrics` and `scenes` (unit), `elements` (unit: the table, its validation and packing, the toolbar), `element-table` (GPU: a test table with an extra powder row, an extra element with a rule), `display` (GPU: the rendered color of each element), `simulation` (GPU: the rules, the liquid, sinking and fire behaviors as scenes with numeric thresholds, fields moving with their cell, bit-identical reruns), `gpu.ts` (device, scene upload and readback helpers), `metrics.ts` (column levels, flatness, layer order), `bench.gpu.ts` (`npm run bench`), `proto-*` (the movement prototype).

## Docs map

- `docs/simulation.md` — how the step pipeline and the CA rules work. Update it when rules, passes or the cell format change.
- `docs/decisions.md` — architectural decisions and the alternatives they rule out.
- `docs/roadmap.md` — milestones (M4–M9: The Powder Toy on the GPU) and what defines each as done.
- `docs/backlog.md` — known bugs, tech debt and ideas, one line each.
- `docs/powder-toy.md` — what The Powder Toy simulates, how each part maps to the GPU, the frame budget, and what goes beyond it.
- `docs/plans/` — plans in progress only; deleted when the feature ships.

## Invariants

- A cell is one 32-bit word in each field buffer of `CELL_FIELDS`: `kind` (bits 0–7 type, 8–15 variant, 16–31 reserved) and `life`. The fields are declared once in `src/cell-fields.ts`; every shader gets the `Cell` struct, its bindings (`@group(1)`, binding = field index) and the accessors (`cellType`, `cellVariant`, `cellLife`, `makeCell`) from `cellWGSL` in `src/shaders/cell.wgsl.ts`. Add or change a field there only; never index a field buffer by hand. A pass's own bindings (uniforms) are group 0.
- Elements are rows of `ELEMENTS` in `src/elements.ts`, and no file outside it names an element ID: TypeScript uses `ELEMENT.SAND`, shaders use `EL_SAND` and `ST_POWDER` (generated), and the toolbar is built from the table. IDs fit in 8 bits, are never reused, and `EMPTY` (0) and `WALL` are required: out-of-bounds cells are walls and the brush erases to empty. The table reaches the CA, the brush and the display as a uniform array in `@group(2)` (`ElementTable`); `Simulation` takes another table (and extra rule sources) as options, which is how tests add rows.
- Movement depends only on `state` and `density`: powders and liquids fall through empty space, gases and lighter things; a gas rises through empty space, plasma (fire) and heavier liquids; solids and plasma never move on their own. Ignition is decided from the cells after the lifetimes but applied after the element rules, so a rule never sees a cell that ignites in the same dispatch.
- The cells are updated in place, one buffer per field, no ping-pong. A CA rule reads and writes only the cells of its own 2×2 block (that is what makes the threads race-free); `storeChanged` writes back only the fields that differ from what the block loaded. Reading a neighbor outside the block breaks in-place updates silently; no test catches it yet (AC10 only checks that two runs of one seed agree, which a deterministic out-of-block read still passes), so review rule changes for it.
- One thread handles one 2×2 block. Out-of-bounds reads (`readCell`) return a wall cell, the world boundary; out-of-bounds writes are skipped.
- The Margolus offset alternates 0 then 1; never run two steps with the same offset in a row.
- A frame is one `GPUCommandEncoder` and one `submit()`: `simulate()` records the brush pass and all CA steps, then `main.ts` records the render. Each CA dispatch has its own `{ offset, seed }` slot in one uniform buffer (stride `minUniformBufferOffsetAlignment`, selected by dynamic offset, written once per frame). Never submit mid-frame, and never `writeBuffer` a shared uniform between dispatches: all writes land before the first dispatch runs.
- A liquid cell's `life` field holds its sideways direction (0 none, 1 left, 2 right), not a lifetime; only the liquid spread rule reads it (`spreadRow` in `ca.wgsl.ts`).
- The brush runs once per frame, before the CA steps, along the segment from the previous frame's position.
- Block randomness comes from `pcg()` chained on `hash2(blockX, blockY, seed)`; never use a float `fract`-based hash for it.

## Adding an element

1. Add a row to `ELEMENTS` in `src/elements.ts`: the next unused ID, a `key` (generates `ELEMENT.<KEY>` and `EL_<KEY>`), label, color, `state` and `density`. That alone makes it fall, pile, sink or rise as its state and density say. `flammable: true` makes it ignite beside fire; `life: { start, decay, becomes }` gives it a lifetime (the brush starts the cell at `start`); `toolbar: n` makes it paintable, placed by n among the other buttons (the n-th button is selected by number key n).
2. Behavior the table cannot say goes in a rule: `src/shaders/rules/<name>.wgsl.ts` with `fn rule_<name>(i: u32, block: ptr<function, array<Cell, 4>>)`, registered in `src/shaders/rules/index.ts`, and `rule: '<name>'` on the row. It runs for cells of that element and reads and writes only the four cells of its block.
3. A color that depends on the cell (fire's life) is a function in `src/shaders/graphics.wgsl.ts`, named by `graphics: '<name>'`.
4. Add a scene test of its main behavior (`tests/element-table.test.ts` shows how to run a table with an extra row), and update the density order and the phase list in `docs/simulation.md`.

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
