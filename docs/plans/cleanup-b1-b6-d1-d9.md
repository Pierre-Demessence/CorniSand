# B1–B6, D1–D9 Project cleanup

Status: approved, not started. Baseline before the work: `tsc --noEmit` 0 errors, `npm run build` OK, no lint or test setup.

## Goal

Fix the simulation bugs B1–B6 and clear tech debt D1–D9 from `docs/backlog.md`: a packed 4-byte cell, one GPU thread per Margolus block, a proper hash, a separate brush pass, one command encoder per frame, quality gates (typecheck, lint, tests including real-GPU tests), and current dependencies.

## Acceptance criteria

Simulation (each GPU criterion is checked by a Vitest test running the real WGSL through Dawn's Node bindings, see Design):

- **B1** WHEN the page loads, THE SYSTEM SHALL request the adapter's `maxStorageBufferBindingSize` and `maxBufferSize`, and IF the CSS-pixel grid would not fit those limits THEN THE SYSTEM SHALL use the smallest integer cells-per-pixel scale that fits. (Unit test of the sizing function.)
- **B2** WHEN isolated liquid or smoke cells move sideways, THE SYSTEM SHALL pick one direction per block at random and try only that one. (GPU test: 100 isolated water droplets on a floor, 200 steps: mean horizontal displacement within ±2 cells, and both directions occur.)
- **B3** THE SYSTEM SHALL have no pressure or velocity fields and no pressure passes.
- **B4** THE SYSTEM SHALL draw block randomness from an integer (PCG) hash of block coordinates and a `u32` seed. (GPU test over a 1280×696 block grid: ≥ 99.9% distinct values, fraction above 0.5 within 0.5 ± 0.003, for several seeds.)
- **B5** WHEN the brush paints, THE SYSTEM SHALL apply it in its own pass before the CA steps, so no particle is lost or duplicated at the brush edge. (GPU test: water directly above a freshly painted cell is conserved.)
- **D5** THE SYSTEM SHALL store a cell as one `u32` (type, variant, lifetime) and run one thread per 2×2 block that writes its four cells. (GPU tests on an odd-sized grid: per-type counts of sand, water, oil, smoke and wall are conserved over 100 steps of a random scene; a sand grain over empty space falls one cell per CA step; smoke rises one cell per step.)
- **D4** WHEN a frame is simulated, THE SYSTEM SHALL record the brush pass, all CA steps and the render into one command encoder and one `submit()`. (GPU test: `simulate()` at 32 supersteps calls `queue.submit` once.)
- **D2** THE SYSTEM SHALL declare particle IDs, the fire max life and the cell layout once in TypeScript and interpolate them into every shader.
- **D6** IF a WebGPU validation error occurs THEN THE SYSTEM SHALL show it on screen. IF the device is lost for a reason other than `destroyed` THEN THE SYSTEM SHALL re-create the device and simulation (world cleared) and say so; IF that fails THEN it SHALL show the reload overlay.

UI and code:

- **B6** WHEN the user presses `1`–`6`, THE SYSTEM SHALL select the toolbar button at that position (Sand, Water, Oil, Fire, Smoke, Wall).
- **D7** THE SYSTEM SHALL change speed through one function, and handle tool selection (click and number key, including the highlight) in one place.
- **D9** WHEN the user hovers, focuses or taps a speed button, THE SYSTEM SHALL show a tooltip ("Slow down ([)" / "Speed up (])"); the buttons carry an `aria-label` and no `title`.
- **D1** THE SYSTEM SHALL contain none of the dead code listed in D1.

Tooling:

- **D3** `npm run build` SHALL fail on type errors; `npm run lint` (ESLint, typescript-eslint) and `npm test` (Vitest) SHALL exist and pass; CI SHALL run typecheck, lint and tests before deploying.
- **D8** Vite 8, `@webgpu/types` 0.1.74, TypeScript at the newest version typescript-eslint supports (6.0.x; see Design), current GitHub Actions majors, and `vite.config.ts`.

## Design

### Cell format (D5, B3, D2)

One `u32` per cell: bits 0–7 type, 8–15 variant, 16–31 lifetime. 4 B instead of 32 B, so a 4K grid (8.3M cells) needs 33 MB per buffer, well under the default 128 MiB binding limit. Future per-cell floats (I1's water mass) go in a separate buffer rather than widening this word.

`src/shaders/cell.wgsl.ts` exports one WGSL snippet included by every shader: `TYPE_*` constants and `FIRE_MAX_LIFE` interpolated from `src/particles.ts`, `cellType()`, `cellVariant()`, `cellLife()`, `makeCell(type, variant, life)`, and the PCG hash. `CELL_BYTES` (4) lives next to it. The inline count shader and the display shader use the snippet instead of literal IDs.

Removed with B3: `pressure.wgsl.ts`, the pressure pipeline, uniforms and bind groups, the splash/fall pressure code and the velocity damping in the CA.

### Passes (B5, D4, D5)

Per frame, recorded into one encoder:

1. **Brush pass** (only while a button is down): one thread per cell, in place on the current buffer (`read_write`, each thread touches only its own cell, so no swap). Own uniform: segment endpoints, radius, type, erase/replace flags, seed.
2. **CA steps**: `2 × stepsPerFrame` dispatches, offsets alternating 0/1. One thread per block: `ceil((W + offset) / 2) × ceil((H + offset) / 2)` blocks, origin `2·b − offset`; out-of-bounds reads are walls, out-of-bounds writes are skipped. Per-step uniforms `{ offset: u32, seed: u32 }` sit in 256-byte slots (`minUniformBufferOffsetAlignment`) of one buffer sized for the maximum 64 steps, written with one `writeBuffer` per frame and selected with a dynamic offset. Grid size is a shader constant.
3. **Render** of the final buffer.

The particle count keeps its own occasional submit.

### Randomness (B4, B2)

`pcg(u32) -> u32` (PCG-RXS-M-XS 32). A block's random word is `pcg(bx ^ pcg(by ^ seed))`; later phases chain `pcg()` on it. Seeds are `u32` from `crypto.getRandomValues` per step. Variant at paint time comes from the cell coordinates and the brush seed.

B2: each sideways phase (liquid bottom row, liquid top row, smoke top row, smoke bottom row) picks one direction from a bit of the block's random word and tries only that move. Consequence: an isolated droplet now moves sideways on half the steps instead of every step, so liquids spread about half as fast. This is the backlog's prescribed fix; speed can be retuned later with a measured check.

### Grid size and device (B1, D6)

`computeGrid(cssW, cssH, maxCells)` (pure, unit-tested) returns `{ width, height, scale }` with the smallest integer `scale` such that `ceil(cssW/scale) × ceil(cssH/scale) ≤ maxCells`, where `maxCells = floor(min(maxStorageBufferBindingSize, maxBufferSize) / CELL_BYTES)` from the device actually created. The device is requested with the adapter's values for those two limits. Input mapping already uses grid size, so it follows the scale.

`gpu.ts` adds a `device.onuncapturederror` handler that logs and shows a small dismissable error banner. On `device.lost` with a reason other than `destroyed`, `main.ts` re-runs its GPU setup (device, simulation, display) once; the frame loop and input keep running against whatever is current. A second failure shows the existing overlay.

### UI (B6, D7, D9)

`main.ts` owns tool selection: `selectTool(button)` sets `input.particleType` and the `active` class; clicks call it and number keys call it with the n-th `.tool-btn[data-type]` (toolbar order). `input.ts` drops its number-key handling. `changeSpeed(delta)` replaces the four copies. Speed buttons get `aria-label` plus a small CSS tooltip (`data-tip`, shown on `:hover`, `:focus-visible`, and for 1.5 s after a touch `pointerdown`).

### Tooling (D3, D8)

- Scripts: `build` = `tsc --noEmit && vite build`, `typecheck`, `lint` = `eslint .`, `test` = `vitest run`.
- ESLint 10 flat config (`eslint.config.js`) with `@eslint/js` recommended and typescript-eslint recommended (type-aware).
- Vitest 5, tests in `tests/`. `tests/gpu.ts` creates a device with the `webgpu` package (Dawn's Node bindings, dev dependency) and helpers to upload a scene and read cells back. GPU suites use `describe.skipIf(!adapter)`: they run locally on a real GPU and are reported as skipped on CI runners without one.
- **TypeScript version (decided):** typescript-eslint 8.72 (latest) supports `typescript <6.1`, and TypeScript 7 (the native Go port) is not usable by it. Use TypeScript 6.0.3 and add a backlog item to move to 7 when typescript-eslint supports it.
- **`webgpu` dev dependency (decided):** approved for the GPU tests. Verified working on the dev machine (NVIDIA, D3D12) with `webgpu@0.6.2`; CI runners report those suites as skipped.
- `tsconfig.json` includes `src`, `tests` and `vite.config.ts`; checked against TS 6 deprecations.
- CI: `actions/checkout@v7`, `setup-node@v7` (Node 22, which Vite 8, ESLint 10 and Vitest 5 accept), `upload-pages-artifact@v5`, `deploy-pages@v5`; steps `npm ci` → `npm run lint` → `npm test` → `npm run build`.

### Edge cases

- Odd grid sizes and offset 1: partial blocks at every edge; covered by the odd-sized conservation test.
- Brush with `scale > 1`: brush radius stays in cells.
- Device loss during a `mapAsync` of the count buffer: the old simulation is dropped; its rejected promise is already caught.

## Checklist

- [ ] **1. D8 + D3 tooling.** Upgrade `vite`, `@webgpu/types`, `typescript@6.0.3`; add `eslint`, `@eslint/js`, `typescript-eslint`, `globals`, `vitest`, `webgpu`. Rename `vite.config.js` → `vite.config.ts`. Add `eslint.config.js`, scripts, tsconfig includes, CI workflow update. Verify: `npm run build`, `npm run lint`, `npm test` (with a placeholder-free first test from step 2) run.
- [ ] **2. D1 + B3 removal.** Delete `src/shaders/simulation.wgsl.ts`, `pressure.wgsl.ts`, pressure pipeline/passes, `CellBuffer.nextBuffer`, `CELL_*` offsets, `VALID_PARTICLE_TYPES`, `ParticleType`, `PARTICLE_PHYSICS`, all `dispose()` methods, pressure/velocity code in the CA. Verify: typecheck, lint.
- [ ] **3. D2 + D5 + B4 + B2 + B5 + D4 simulation rewrite.** `src/shaders/cell.wgsl.ts`; rewrite `solid-ca.wgsl.ts` (block threads, packed cells, PCG, one-direction sideways moves, no brush); new `brush.wgsl.ts`; `simulation.ts` with dynamic-offset uniform slots and a `simulate(encoder, …)` that records into the caller's encoder; display and count shaders on the packed format. Tests in `tests/`: hash distribution (B4), droplet drift (B2), brush conservation (B5), odd-grid conservation, fall and rise speed (D5), single submit (D4). Verify: all tests pass.
- [ ] **4. B1 + D6 device.** Limits in `requestDevice`, `computeGrid` with unit tests, error banner, device-lost re-creation in `main.ts`. Verify: tests, and a browser check that a forced validation error shows the banner.
- [ ] **5. B6 + D7 + D9 UI.** `selectTool`, `changeSpeed`, key mapping by toolbar order, tooltip CSS and touch handling, `aria-label`s. Verify: browser check of keys 1–6, speed buttons, tooltip on hover and focus.
- [ ] **6. Docs.** `docs/simulation.md` (cell format, passes, block threads, randomness, sideways rule; delete the pressure section), `docs/decisions.md` (cell storage entry now a packed `u32`; grid entry gains the scale fallback), `AGENTS.md` (commands, layout, invariants: cell word, one encoder per frame with uniform slots, brush pass; "Adding a particle type" steps), `README.md` (key order), `docs/research/realistic-water.md` (current-state wording), `docs/backlog.md` (delete B1–B6, D1–D9; add TypeScript 7 and any deferrals). Verify: present-tense scan.
- [ ] **7. Review.** Peer review (Sonnet, read-only) against these criteria; fix blocking findings, at most 3 rounds.
