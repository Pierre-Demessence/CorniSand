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

## Ideas

- **I3** More gas types (steam, toxic gas).
- **I4** Temperature field driving reactions and phase changes (water ↔ steam, ice).
- **I5** More material interactions beyond fire/oil, fire/water and sand/liquid.
- **I7** New materials: metal, lava, acid.
- **I8** Debug overlay for the fluid fields of M1 (velocity, pressure), once they exist.
