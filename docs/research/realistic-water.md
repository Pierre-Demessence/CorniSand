# Realistic water

Backlog I1. Goal: water that behaves like a liquid rather than like flowing sand. Acceptance test: **communicating vessels**. Two chambers joined by a passage at the bottom, water poured into one, both free surfaces end at the same height.

## Why the current model cannot pass the test

- **No upward movement.** One particle per cell, and the only liquid moves are fall and sideways-into-empty. In a U-tube the low arm can only rise if water in the full passage moves up, and no rule does that. Water simply stops once the passage is full.
- **No hydrostatic pressure.** Cells hold only type, variant and lifetime; nothing depends on depth. An earlier pressure overlay was removed because no rule read it, which is why tuning its constants changed nothing visible.
- **Sideways flow is a random walk.** Each block picks one random direction, so surfaces level only by diffusion and a lone droplet drifts sideways on about half the steps; there is no force that evens out two connected columns.

## What was tried

1. **Eulerian grid solver** (semi-Lagrangian advection plus Jacobi pressure projection). Abandoned: advection traced back into empty cells and zeroed velocity, so water stopped moving. Free-surface fluids on a grid need explicit handling of the liquid/air boundary, which the attempt did not have.
2. **Pressure overlay on the CA.** Liquids carried pressure and velocity that were diffused between liquid neighbors and meant to bias sideways flow. In practice it had no effect, and it was removed.
3. **Stabilization tuning**: more diffusion passes, retuned decay and bias constants. Discarded: the constants feed no movement rule.
4. **Hydrostatic floor plus a "pressure lift" rule**: pressure is at least the pressure above plus a constant per liquid cell, and liquid next to a wall may move up when its pressure crosses a threshold. The low chamber rose somewhat but never equalized, and stronger settings left holes in the water (cavitation). Discarded.

Attempts 3 and 4 were checked only by looking at the browser, with no measured pass/fail criterion.

## Options

### A. Mass-based, slightly compressible liquid CA (recommended)

Each cell stores a water mass instead of "occupied or not". Each step moves mass: down first, then sideways toward equal mass, then up from any cell holding more than a full cell. A cell under a column of water is allowed to hold slightly more than 1 (for example 1 + 0.02 per cell of depth). That excess is what pushes water up the low arm, so U-tubes equalize without computing pressure at all. This is the well-known approach from W-Shadow's [Simple Fluid Simulation With Cellular Automata](https://w-shadow.com/blog/2009/09/01/simple-fluid-simulation) and from games with similar water.

- GPU fit: compute the flow across each edge from that edge's two cells only. Both cells then compute the same value from the same input, so one gains exactly what the other loses and mass is conserved without atomics.
- Rendering: a cell with mass below 1 is partly filled. Draw it as a fill fraction or with a threshold.
- Open questions: how sand displaces partial water (move the mass into a neighbor?); whether oil gets its own mass channel or stays a particle; how fire and smoke interact with partial cells; how many sub-steps a pass needs to equalize in reasonable time on a ~3M-cell grid.

### B. Keep particles, add an explicit pressure solve

Compute hydrostatic pressure from connected liquid (depth below the free surface), then move surface particles from the high-head chamber to the low one. Connectivity is a global flood-fill problem, which suits the GPU poorly and needs many passes. Not recommended.

### C. Particle fluid (SPH or position-based fluids)

Physically the best, but it is a different simulation alongside the grid, with its own neighbor search and its own rendering, and it changes the falling-sand look. Out of proportion for this project.

## The check comes first

Whatever option is chosen, build the measurable check before the model:

1. A CPU reference of the liquid rules in TypeScript, with Vitest.
2. A U-tube scene test: after N steps, both surface heights are within one cell of each other and total mass is conserved within a small epsilon. A basin test: a resting pool's surface is flat within one cell.
3. Port the rules to WGSL only once the CPU tests pass, then run the same scene on the real WGSL with the `tests/gpu.ts` helpers (load a scene, run N supersteps, read the buffer back), so the GPU result is checked against the same numbers.
