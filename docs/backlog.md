# Backlog

IDs are stable: B = bug, D = tech debt, I = idea.

## Bugs

- **B7** Touch devices cannot erase or change brush size (right click and wheel only), and `pointercancel` is not handled, so a cancelled touch can leave drawing stuck on. `src/input.ts:50-73`
- **B8** Brush ring states (erase red, replace amber, draw white) differ by color only, which is unreadable with red-green colorblindness; add a second cue (dashed ring, icon, label). `src/shaders/display.wgsl.ts:85-101`
- **B9** Toolbar does not wrap or scroll, so items are cut off on narrow screens. `index.html:30-45`
- **B10** No per-grain color variation: `variant` is generated and stored, but the display shader ignores it (the WebGL version shaded sand, wall and water by variant until commit e6a38a9). `src/shaders/display.wgsl.ts:71-82`
- **B11** Number keys ignore modifiers, so Ctrl+1 (browser tab switch) also selects a tool. `src/main.ts:112-115`

## Tech debt

- **D10** Move to TypeScript 7 (the native port) once typescript-eslint supports it: 8.x accepts `typescript <6.1`, so the project is on 6.0.x.
- **D11** The GPU test suites (`tests/simulation.test.ts`, `tests/hash.test.ts`) skip themselves on machines without a GPU, which includes the GitHub Actions runners, so CI only runs the unit tests. A software adapter on the runner (for example Dawn with SwiftShader) would let CI run them.
- **D12** ESLint uses typescript-eslint's recommended type-checked rules (`eslint.config.js`), not the `create-corniflex` template (`@antfu/eslint-config`).
- **D13** The CPU liquid acceptance suite (`tests/liquids-*.test.ts`) takes about 100 s wall (260 s summed) on the dev machine and runs on CI too; shrink the large scenes or step counts, or run it on demand, if CI time matters.
- **D14** FLIP particles keep moving at rest: about 19% exceed 0.3 cells/step in the settled large U-tube. The ranked cell output hides it, but it needs damping before sand sinks through water. `tests/cpu/flip.ts` `gridToParticles`
- **D15** FLIP at `k = 2` fails AC2, AC5, AC6 and AC11 (stray cells over the surface, oil mixing into water); only needed if the GPU cost requires the coarser solve. `tests/cpu/flip.ts`
- **D17** Page load stalls 2–4 s before the first frames run (seen in the browser at 1920×898 on `main`). In Node, creating the `Simulation` at that size takes about 0.8 s the first time (pipelines) and nothing measurable after, so pipeline compilation explains at most a part of it; profile the load in the browser first, then create the pipelines with `createComputePipelineAsync` and show a loading state. `src/simulation.ts`, `src/fluid.ts`

## Ideas

- **I3** More gas types (steam, toxic gas).
- **I4** Temperature field driving reactions and phase changes (water ↔ steam, ice).
- **I5** More material interactions beyond fire/oil, fire/water and sand/liquid.
- **I7** New materials: metal, lava, acid.
- **I8** Debug overlay for the fluid fields of M1 (velocity, pressure), once they exist.
- **I9** Liquid falls at most 1 cell per step (the FLIP velocity clamp), half the speed of falling sand; a swept wall test in the particle move would allow a clamp of 2 without particles crossing thin walls. `tests/cpu/flip.ts` `gridToParticles`
