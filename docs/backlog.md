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
- **D11** The GPU test suites (`tests/simulation.test.ts`, `tests/hash.test.ts`, `tests/gpu.test.ts`, `tests/proto-movement.test.ts`) skip themselves on machines without a GPU, which includes the GitHub Actions runners, so CI only runs the unit tests. A software adapter on the runner (for example Dawn with SwiftShader) would let CI run them.
- **D12** ESLint uses typescript-eslint's recommended type-checked rules (`eslint.config.js`), not the `create-corniflex` template (`@antfu/eslint-config`).
- **D23** The 8x row of `npm run bench` jumps: `tank` and `mix75` cost 0.08 ms per superstep at 1x to 4x and 0.27–0.43 ms per superstep at 8x (about 11 ms a frame instead of 2.5), reproduced in three runs. Not yet known whether it is the GPU (a clock or cache effect at 64 dispatches), the dynamic-offset uniform slots or the Node binding's per-call cost; time the passes with timestamp queries before M4.6. `tests/bench.gpu.ts`
- **D24** A liquid at rest still rewrites its cells: a cell facing a non-empty neighbor turns around every dispatch (its direction is in `life`), so the words of a still pool keep changing. It blocks any "skip writes for blocks that did not change" saving in M4.3 or M4.6; if that lever is wanted, turn only cells that have empty space beside them or above. `src/shaders/ca.wgsl.ts` `spreadRow`
- **D17** Page load stalls 2–4 s before the first frames run (seen in the browser at 1920×898 before the liquids moved to CA rules). In Node, creating the `Simulation` at that size takes about 0.13 s the first time (pipelines) and 2 ms after (`npm run bench`), so profile the load in the browser again before optimizing; if it still stalls, create the pipelines with `createComputePipelineAsync` and show a loading state. `src/simulation.ts`

## Ideas

- **I10** Bigger scenes for `?scene=`: `uTube` (68×80) and `damBreak` (200×60) are too small to enjoy or to judge whether the physics looks right; they are fine as tests. `src/scenes.ts`
- **I11** A separate realistic-physics sandbox built from the FLIP liquids that M4 removes, only worth starting if its hook is the interplay of a few deep materials (heat boiling water into steam that expands, pushes and condenses; lava flashing water to steam; burning oil; explosions throwing water; objects that float or sink), not water alone. Desktop GPU first; liquids at 2 pixels per cell with a smooth rendered surface, foam and spray; gases as a grid-only solve on a coarse grid. Start from the last CorniSand commit that has `src/fluid.ts`, and carry over the FLIP items M4.2 deleted from this backlog (B12, D13–D15, D18–D22, I9) as its known issues.
- **I13** (M5–M6) Flyers in flight are outside the grid, so only wind reaches them: a blast, pressure, heat and reactions act on grid cells only (on `proto.html`'s pour, a click blasts the falling stream under A but not under C, whose falling grains are flyers). Whatever pushes or reacts with cells must also act on the flyers in its area: pressure and explosions push them (M6), heat and reactions reach them in flight or at landing (M5). `src/proto/shaders.ts` `blastWGSL`
- **I12** Choose a license for CorniSand. With no license file nobody may reuse the code; a permissive license (MIT, Apache-2.0) lets others reuse it without requiring them, or this project, to publish source. Decide before accepting outside contributions.
