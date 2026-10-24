# CorniSand — agent guide

Falling-sand sandbox running entirely on the GPU: WGSL compute shaders run a Margolus cellular automaton over storage buffers, and a fullscreen-triangle render pass draws the result. TypeScript, Vite, native WebGPU, no framework.

## Commands

```bash
npm run dev       # Vite dev server
npm run build     # Production build → dist/ (does NOT typecheck)
npm run preview   # Serve dist/
npx tsc --noEmit  # Typecheck (strict); run it, the build does not
```

There is no lint or test setup yet (see `docs/backlog.md`).

## Stack facts not in config

- WebGPU only, no WebGL fallback. Targets Chrome 113+, Edge 113+, Safari 18.2+.
- `.github/workflows/deploy-pages.yml` builds and deploys to GitHub Pages on every push to `main`; `vite.config.js` sets `base: './'` for that.
- The simulation grid is one cell per CSS pixel of the canvas, sized once at load (`src/main.ts`); resizing stretches it (see `docs/decisions.md`).

## Layout

- `src/main.ts` — entry: WebGPU init, UI wiring, speed control, frame loop.
- `src/gpu.ts` — adapter/device/context setup, device-lost overlay.
- `src/simulation.ts` — compute pipelines (CA, pressure, particle count) and per-frame step orchestration.
- `src/cell-buffer.ts` — ping-pong pair of cell storage buffers.
- `src/display.ts` — render pipeline drawing the current cell buffer plus the brush ring.
- `src/input.ts` — pointer, keyboard and wheel state.
- `src/particles.ts` — particle type IDs (TS side).
- `src/shaders/*.wgsl.ts` — WGSL sources exported as template strings: `solid-ca` (all particle rules), `pressure` (pressure/velocity diffusion), `display`.

## Docs map

- `docs/simulation.md` — how the step pipeline and the CA rules work. Update it when rules, passes or the cell format change.
- `docs/decisions.md` — architectural decisions and the alternatives they rule out.
- `docs/backlog.md` — known bugs, tech debt and ideas, one line each.
- `docs/research/` — undecided topics with options and open questions.
- `docs/plans/` — plans in progress only; deleted when the feature ships.

## Invariants

- A cell is a 32-byte struct `{ pType: u32, variant, lifetime, pressure, velocityX, velocityY, _pad0, _pad1: f32 }`. The struct is declared separately in `solid-ca`, `pressure`, `display` and the inline count shader in `simulation.ts`, and `CELL_BYTES` in `cell-buffer.ts` must match: change all of them together.
- Particle type IDs are hard-coded in `particles.ts`, `solid-ca.wgsl.ts`, `pressure.wgsl.ts`, the display shader's `pType == Nu` branches, the count shader (`2u` = wall) and `index.html` `data-type` attributes. Keep them in sync.
- Every pass reads the current buffer and writes the other one, then `CellBuffer.swap()`. Bind groups for both directions are pre-created; pick them from `currentBuffer`.
- Out-of-bounds reads (`readCell`) return a wall cell; that is the world boundary.
- The Margolus offset alternates 0 then 1 within each superstep; never run two steps with the same offset in a row.
- Each pass gets its own `GPUCommandEncoder` and `submit()`. For CA steps this is required: all steps share one uniform buffer and `writeBuffer` calls before a single submit would all land before any dispatch. Batching needs per-step uniform slots first (backlog D4).
- Brush input is applied only on the first CA step of a frame, interpolated along the segment from the previous frame's position.

## Adding a particle type

1. Add the ID to `PARTICLE_TYPES` in `src/particles.ts`.
2. Add `TYPE_X` and an `isX()` helper in `src/shaders/solid-ca.wgsl.ts`; update `isFalling`, `isLiquid`, `isGas`, `canDisplace`, `canRiseThrough` as needed, plus `isLiquid` in `pressure.wgsl.ts` if it is a liquid.
3. Add movement or reaction rules in the CA phases; use `makeCellWithLife()` in the brush branch if it has a lifetime.
4. Add its color in `src/shaders/display.wgsl.ts`.
5. Add a toolbar button in `index.html` (`data-type` = the ID) and the number-key mapping in both `src/input.ts` and `typeMap` in `src/main.ts`.
6. Update the density ordering and phase list in `docs/simulation.md`.

## Never

- Never claim a water or physics behavior works from a visual check alone. Water realism failed repeatedly that way; any physics change needs a measurable, repeatable check (see `docs/research/realistic-water.md`).
- Never tune a constant without confirming that the value actually reaches a rule that moves particles (`pressure` and `velocity` currently do not, see `docs/simulation.md`).
