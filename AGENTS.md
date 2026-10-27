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
npm run bench     # GPU time per frame (timestamp queries) at 2560×1340 at 1x to 8x for `tank`, `mix75`, `full100` and `blast`, the 1x time of each pass, and the simulation creation time (tests/bench.gpu.ts); needs a GPU adapter. BENCH_SCENES=mix75,blast and BENCH_SPLIT_ONLY=1 narrow it
```

CI (`.github/workflows/deploy-pages.yml`) runs lint, test and build before deploying.

The GPU suites in `tests/` run the real WGSL through Dawn's Node bindings (`webgpu` package, `tests/gpu.ts`) and skip themselves when no adapter is available, as on the CI runners (`docs/backlog.md` D11). `tests/gpu.ts` must keep a module-level reference to the GPU instance: Dawn crashes the process if it is garbage-collected while its device is in use.

## Stack facts not in config

- WebGPU only, no WebGL fallback. Targets Chrome 113+, Edge 113+, Safari 18.2+.
- The reference machine is an RTX 4080. It is also the user's gaming GPU: before `npm run bench`, check with `nvidia-smi` that nothing else loads it (a game or a live wallpaper once made a bench run 3 to 8 times too high); ask the user to close it if it does. Every size and resolution (field, cells per pixel, air, gravity and light grids, CA steps per frame) is a setting, not a hard-coded constant, so it can be scaled down later (`docs/decisions.md`).
- `.github/workflows/deploy-pages.yml` builds and deploys to GitHub Pages on every push to `main`; `vite.config.ts` sets `base: './'` for that.
- The simulation grid is one cell per CSS pixel of the canvas, or the smallest integer cells-per-pixel scale that fits the device's storage-buffer limits (`src/grid.ts`). It is sized once at load (`src/main.ts`); resizing stretches it (see `docs/decisions.md`).
- The user's npm `min-release-age` is 7 days: `npm install` picks the newest version at least that old, not `latest`.
- TypeScript stays on 6.0.x until typescript-eslint supports 7 (`docs/backlog.md` D10).

## Layout

- `src/main.ts` — entry: WebGPU init and device re-creation, UI wiring (tool selection, speed), frame loop (one encoder, one submit per frame).
- `src/gpu.ts` — adapter/device/context setup with the adapter's buffer limits, uncaptured-error banner, device-lost callback, reload overlay.
- `src/grid.ts` — `computeGrid`: grid size and scale from the buffer limits.
- `src/simulation.ts` — compute pipelines (brush, CA, particle count); `simulate(encoder, supersteps, input)` records the brush pass and the CA steps into the caller's encoder.
- `src/passes.ts` — `PassRecorder`: the frame's one compute pass, or for the bench (`PassTimer`) one timed pass per group of dispatches.
- `src/cell-fields.ts` — `CELL_FIELDS`, the one list of per-cell fields (name, WGSL type), plus `CellData`, `FIELD_BYTES` and `tempView` (the `temp` words as floats).
- `src/heat.ts` — temperature constants: `ROOM_TEMP` (what an element is painted at by default), `ABSOLUTE_ZERO`, `MAX_TEMP`, `NO_THRESHOLD`, and `effectiveTemp` (the TypeScript twin of `cellTemp`).
- `src/half.ts` — binary16 conversion and `packHalf2`/`unpackHalf2`, the CPU side of the packed `velocity` and `remainder` words (scenes and tests).
- `src/movement.ts` — `MOVEMENT`, the movement constants (top speed, launch speed, friction, flyer cap), `movementWGSL`, `launchGroups`.
- `src/flyers.ts` — `Flyers`: the flyer buffers and passes of a superstep (launch, flight, landing, compaction), the overlay the display reads, the brush removal, read-back helpers for tests.
- `src/cell-field-buffers.ts` — `CellFields`: one storage buffer per field, the shared bind groups (`@group(1)`), `load`, `clear`, `read(name)` for tests.
- `src/display.ts` — render pipeline drawing the cell field buffers plus the brush ring.
- `src/input.ts` — pointer, wheel and Shift state.
- `src/elements.ts` — `ELEMENTS`, the element table (one row per material: ID, label, color, state, density, flammable, life, rule, graphics, toolbar position), `ELEMENT` (key → ID), `validateElements`.
- `src/element-table.ts` — `PROP_FIELDS` (the GPU's view of a row), `packElements`, `ElementTable` (the uniform buffer and its bind group, `@group(2)`).
- `src/toolbar.ts` — `toolbarEntries` (the paintable elements in toolbar order) and `renderToolbar`; `main.ts` builds the buttons from them.
- `src/shaders/*.wgsl.ts` — WGSL sources exported as template strings (functions of the grid size and the table where needed): `cell` (`cellTypesWGSL`: the PCG hash, the element constants, the `Cell` struct and its accessors and builders `cellType`, `cellVariant`, `cellLife`, `cellVelocity`, `cellRemainder`, `cellStoredTemp`, `makeCell`, `withType`, `withLife`, `withMotion`, `withTemp`; `cellBindingsWGSL(access)`: the field bindings, `loadCell`, `storeCell`, `storeChanged`; `cellWGSL` is both; generated from `CELL_FIELDS`), `elements` (`EL_*` and `ST_*` constants, the `ElementProps` struct, the table uniform and its accessors), `ca` (the generic CA phases), `heat` (`cellTemp`, the stored temperature clamped to the thresholds; `exchangeHeat`, the conduction between two cells of a block), `flyers` (the flyer passes, generated from `CELL_FIELDS` too), `brush`, `display`, `graphics` (the display color functions by name), `rules/` (the optional element rules, `rules/index.ts` registers them by name).
- `src/scenes.ts` — scene builders (`SCENES`, including `pile` and `blast`, which start with velocities) shared by the tests and the `?scene=<name>` loader in `main.ts` (`findScene`).
- `tests/` — Vitest: `grid`, `hash`, `metrics` and `scenes` (unit), `elements` (unit: the table, its validation and packing, the toolbar), `element-table` (GPU: a test table with an extra powder row, an extra element with a rule, a solid with a lifetime the CA must not skip), `display` (GPU: the rendered color of each element), `half` (unit: binary16 conversion), `heat` (GPU: the temperatures cells are painted and loaded at, carried bit for bit by falling and flying cells; conduction: its rate, bars of metal and stone, heat kept by cells beside empty space, the capacity-weighted mean, total heat of a sealed box; phase changes: single cells at their thresholds, the `iceLava`, `steamCeiling` and `moltenMetal` scenes, boxes that must not flicker, total heat with latent heat across every threshold; `tests/metrics.ts` `heatContent` and `latentOffsets`), `simulation` (GPU: the rules, the liquid, sinking and fire behaviors as scenes with numeric thresholds, free fall, walls against fast cells, settled piles, the blast and the flyers, fields moving with their cell, bit-identical reruns), `gpu.ts` (device, scene upload and readback helpers), `metrics.ts` (column levels, flatness, layer order), `block-locality` (GPU: one dispatch on two scenes differing in a few cells must differ only inside those cells' blocks, with two negative controls), `bench.gpu.ts` (`npm run bench`).

## Docs map

- `docs/simulation.md` — how the step pipeline and the CA rules work. Update it when rules, passes or the cell format change.
- `docs/decisions.md` — architectural decisions and the alternatives they rule out.
- `docs/roadmap.md` — milestones (M5–M10: The Powder Toy on the GPU) and what defines each as done.
- `docs/backlog.md` — known bugs, tech debt and ideas, one line each.
- `docs/powder-toy.md` — what The Powder Toy simulates, how each part maps to the GPU, the frame budget, and what goes beyond it.
- `docs/plans/` — plans in progress only; deleted when the feature ships.

## Invariants

- A cell is one 32-bit word in each field buffer of `CELL_FIELDS`: `kind` (bits 0–7 type, 8–15 variant, 16–31 reserved), `life`, `velocity` and `remainder` (each two binary16 values packed in a `u32`, x in the low half, in cells per dispatch; zero for anything that does not fall), and `temp` (`f32`, the stored temperature in °C; meaningless for empty space and walls). The fields are declared once in `src/cell-fields.ts`; every shader gets the `Cell` struct, its bindings (`@group(1)`, binding = field index) and the accessors (`cellType`, `cellVariant`, `cellLife`, `cellVelocity`, `cellRemainder`, `cellStoredTemp`) from `cellWGSL` in `src/shaders/cell.wgsl.ts`. Add or change a field there only; never index a field buffer by hand. A pass's own bindings (uniforms) are group 0; the CA's launch counts are group 3. The flyer passes that carry whole cells bind three buffers of their own plus every field: 8 storage buffers, the default per-stage limit the game and the tests run at (`tests/gpu.test.ts` asserts it), so a sixth field needs backlog D32 first.
- Elements are rows of `ELEMENTS` in `src/elements.ts`, and no file outside it names an element ID: TypeScript uses `ELEMENT.SAND`, shaders use `EL_SAND` and `ST_POWDER` (generated), and the toolbar is built from the table. IDs fit in 8 bits, are never reused, and `EMPTY` (0) and `WALL` are required: out-of-bounds cells are walls and the brush erases to empty. The table reaches the CA, the brush and the display as a uniform array in `@group(2)` (`ElementTable`); `Simulation` takes another table (and extra rule sources) as options, which is how tests add rows.
- Movement depends on `state`, `density` and, for powders and liquids, the cell's velocity: they gain their element's `gravity` per dispatch, move one cell inside the block when the remainder reaches 1, and fall through empty space, gases and lighter things; a gas rises through empty space, plasma (fire) and heavier liquids; solids and plasma never move on their own. A cell faster than `MOVEMENT.launchSpeed` leaves the grid as a flyer (below). Gases move at a constant speed by their own rules and ignore velocity. A rule that changes a cell uses `withType`/`retype`, `withLife`, `withMotion` or `withTemp`, which keep every other field; `makeCell` builds a fresh cell with motion zero and is for the brush and scenes. Ignition is decided from the cells after the lifetimes but applied after the element rules, so a rule never sees a cell that ignites in the same dispatch.
- Flyers: a cell that leaves the grid is a `Flyer` (position, velocity, the whole `Cell`) in a list of at most `maxFlyers` (`Simulation` option, default `MOVEMENT.maxFlyers`); past the cap launches stay in the CA, clamped. The flyer passes run once per superstep, after the offset-1 dispatch, inside the frame's one compute pass; every slot comes from a prefix sum and every landing conflict from a claim key, so nothing depends on thread scheduling. A flyer is blocked by any non-empty cell, flyers do not collide with each other, and only the brush's erase and replace reach a flyer (backlog I13). The display draws flyers from an overlay buffer that `recordOverlay` fills after `simulate`.
- The cells are updated in place, one buffer per field, no ping-pong. A CA rule reads and writes only the cells of its own 2×2 block (that is what makes the threads race-free); `storeChanged` writes back only the fields that differ from what the block loaded. Reading a neighbor outside the block breaks in-place updates silently, and the determinism test cannot see it (two runs of one seed agree even then). `tests/block-locality.test.ts` guards it: it runs one dispatch on a random scene holding every element of the table and on a copy with one cell changed per 4×4 tile, and requires bit-identical fields outside the blocks of the changed cells. It catches a read only when it changes a result for the cells drawn: continuous phases nearly always, discrete ones with high probability over its 32 rounds, not with certainty, so still review rule changes for it. A new cell field needs a generator there (it throws on a field it does not know).
- One thread handles one 2×2 block. Out-of-bounds reads (`readCell`) return a wall cell, the world boundary; out-of-bounds writes are skipped.
- The CA keeps the block in one private variable per slot (`blk0`–`blk3`, `blkAt(k)`/`setBlk(k, c)`), never in a private array indexed by a runtime slot: such an array lives in per-thread memory and made the CA three times slower. The same holds for any new per-block state.
- The CA skips a block whose four cells are all inert (`elementInert`: empty or solid, no lifetime, no rule, and no heat: `elementHoldsHeat`, a conductivity above 0 or a transition) without loading their other fields. Anything that changes such a cell by itself must make `elementInert` false for it or run outside the CA: that is why a metal or stone cell wakes its block, and why WALL (which holds no heat) stays skippable. The skip and the launch count also rely on empty and solid cells having zero velocity: every runtime path keeps it so (`retype`, `makeCell`), and a scene loaded through `Simulation.load` must too.
- The Margolus offset alternates 0 then 1; never run two steps with the same offset in a row.
- The phases of one CA dispatch run in this order: 0–3 movement, 4 lifetimes (ignition decided), 5 element rules, 6 ignition applied, 7 heat conduction, 8 phase changes (left out of the shader when the table has no transition). A rule never sees a cell that ignites or changes phase in the same dispatch. A cell's temperature (`cellTemp`) is its stored temperature clamped to its element's thresholds; only phase 8 compares the stored one against the thresholds. `docs/simulation.md` describes each phase.
- A frame is one `GPUCommandEncoder` and one `submit()`: `simulate()` records the brush pass and all CA steps, then `main.ts` records the render. Each CA dispatch has its own `{ offset, seed }` slot in one uniform buffer (stride `minUniformBufferOffsetAlignment`, selected by dynamic offset, written once per frame). Never submit mid-frame, and never `writeBuffer` a shared uniform between dispatches: all writes land before the first dispatch runs.
- A liquid cell's `life` field holds its sideways direction (0 none, 1 left, 2 right), not a lifetime; only the liquid spread rule reads it (`spreadRow` in `ca.wgsl.ts`).
- The brush runs once per frame, before the CA steps, along the segment from the previous frame's position.
- Block randomness comes from `pcg()` chained on `hash2(blockX, blockY, seed)`; never use a float `fract`-based hash for it.

## Adding an element

1. Add a row to `ELEMENTS` in `src/elements.ts`: the next unused ID, a `key` (generates `ELEMENT.<KEY>` and `EL_<KEY>`), label, color, `state` and `density`. That alone makes it fall, pile, sink or rise as its state and density say. A powder or liquid also takes `gravity` (cells per dispatch squared, default 1/32) and `drag` (share of its speed a flyer loses per dispatch, default 1/64). `flammable: true` makes it ignite beside fire; `life: { start, decay, becomes }` gives it a lifetime (the brush starts the cell at `start`); `temperature` (°C, default 20) is what the brush paints it at; `toolbar: n` makes it paintable, placed by n among the other buttons (the n-th button is selected by number key n).
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
