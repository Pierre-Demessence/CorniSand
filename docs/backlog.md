# Backlog

IDs are stable: B = bug, D = tech debt, I = idea.

## Bugs

- **B1** Large windows render nothing: `requestDevice()` uses default limits (128 MiB per storage binding, 256 MiB per buffer) and a cell is 32 B, so above ~4.19M cells (3440×1440, or 4K at 100% scaling) buffer creation/binding fails, with errors only in the console. Request the adapter's limits and/or cap the grid size or add a cells-per-pixel scale. `src/gpu.ts:23`, `src/main.ts:11-12`
- **B2** Liquid and smoke sideways flow is deterministic: the two candidate moves in each branch are mutually exclusive, so the random/pressure threshold never changes the outcome; direction is fixed by column parity (a lone droplet drifts 1 cell/step). Pick one direction per block and try only that one. `src/shaders/solid-ca.wgsl.ts:213-301`
- **B3** Pressure and velocity never affect movement (their only consumer is the no-op bias of B2), so the two pressure passes per superstep and 12 B/cell are pure cost; the sand-splash pressure impulse also lands on the sand cell, not the liquid. Fix with I1 or remove. `src/shaders/solid-ca.wgsl.ts:170-192`, `src/shaders/pressure.wgsl.ts`
- **B4** Poor randomness: `hash21` is a `fract`-based f32 hash fed with grid coordinates plus a seed up to 10000, so its products reach millions where f32 has no fractional precision. Measured on a 2560×1392 grid: as few as 471 distinct values across 890k blocks, 44–48% above 0.5 instead of 50% (left/right bias in sand slides). Use an integer hash (e.g. PCG) on a `u32` seed. `src/shaders/solid-ca.wgsl.ts:83-87`, `src/simulation.ts:212`
- **B5** Painting loses or duplicates particles at the brush edge: a painted cell returns early, but its block-mates compute the block from the unpainted state (water above a freshly painted cell "falls" into it and vanishes). Apply the brush in its own pass before the CA. `src/shaders/solid-ca.wgsl.ts:113-143`
- **B6** Number keys select by type ID, not toolbar order: `2` selects Wall (6th button), `3` Water (2nd). `src/input.ts:77-82`, `src/main.ts:68-74`, `index.html:127-132`
- **B7** Touch devices cannot erase or change brush size (right click and wheel only), and `pointercancel` is not handled, so a cancelled touch can leave drawing stuck on. `src/input.ts:48-71`
- **B8** Brush ring states (erase red, replace amber, draw white) differ by color only, which is unreadable with red-green colorblindness; add a second cue (dashed ring, icon, label). `src/shaders/display.wgsl.ts:92-108`
- **B9** Toolbar does not wrap or scroll, so items are cut off on narrow screens. `index.html:30-45`
- **B10** No per-grain color variation: `variant` is generated and stored, but the display shader ignores it (the WebGL version shaded sand, wall and water by variant until commit e6a38a9). `src/shaders/display.wgsl.ts:78-90`

## Tech debt

- **D1** Dead code: `src/shaders/simulation.wgsl.ts` (not imported anywhere), `CellBuffer.nextBuffer`, the `CELL_*` field offsets, `VALID_PARTICLE_TYPES`, `ParticleType`, `PARTICLE_PHYSICS` (its densities drive nothing), `FluidUniforms.dt`, and `dispose()` methods that are never called.
- **D2** Particle IDs, the `Cell` struct and the fire max life (200) are duplicated by hand across TS and four shaders. The shaders are already TS template strings: interpolate the constants from `particles.ts` and share one `Cell` struct snippet.
- **D3** No quality gates: `npm run build` does not typecheck, there is no lint and no test setup, and CI deploys whatever builds. Add `tsc --noEmit` to the build, ESLint, and a test runner (needed for I1).
- **D4** One `submit()` per pass (4 per superstep, 128 per frame at "8x"). Pressure passes need no per-step uniforms; CA steps differ only by offset, seed and brush flag, so write them to slots of one uniform buffer (aligned to `minUniformBufferOffsetAlignment`) and use dynamic offsets, then record everything in one encoder.
- **D5** GPU cost per cell: every thread re-reads its whole 2×2 block and re-runs all rules, so block work runs 4×; one thread per block writing four cells would cut it. Cells are 32 B where type, variant and lifetime fit in one `u32`. Worth doing once B1 is addressed, since grid size is bounded by memory.
- **D6** No device-lost recovery and no `uncapturederror` handler, so validation errors (B1) are invisible to the user. `src/gpu.ts:23-35`
- **D7** Speed up/down logic is duplicated four times, and number-key handling is split between `input.ts` (selection) and `main.ts` (button highlight). `src/main.ts:68-100`
- **D8** Dependencies behind: Vite 6.4 (8.x out), TypeScript 5.9 (7.x out), `@webgpu/types` 0.1.69 (0.1.74); GitHub Actions on `@v4` tags. `vite.config.js` could be TypeScript.
- **D9** Speed buttons use the `title` attribute as their only hint (slow, absent on touch). `index.html:142-144`

## Ideas

- **I1** Realistic water, with communicating vessels as the acceptance test. See `docs/research/realistic-water.md`.
- **I2** Smoke never dissipates, so burning oil eventually fills the ceiling for good; give smoke a lifetime.
- **I3** More gas types (steam, toxic gas).
- **I4** Temperature field driving reactions and phase changes (water ↔ steam, ice).
- **I5** More material interactions beyond fire/oil, fire/water and sand/liquid.
- **I6** Velocity-driven movement: advect particles by per-cell velocity, wind sources, momentum transfer on collision.
- **I7** New materials: metal, lava, acid.
- **I8** Debug overlay showing pressure/velocity fields (useful for I1).
