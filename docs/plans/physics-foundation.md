# M1 Physics foundation and realistic liquids

Status: plan awaiting approval. Nothing implemented. M1.1–M1.3 are specified in full. M1.4 and later are an outline, to be rewritten in detail at the M1.3 gate once the liquid representation is chosen.

## Goal

Add a velocity grid and a global pressure solve to the simulation, and make water and oil move with them. The result is communicating vessels (a U-tube's two arms settle at the same level), plus momentum: water sloshes, splashes and runs up walls. Every claim is checked by scene tests: first on a CPU reference, then on the GPU through read-back.

## Background

Why the cell CA alone cannot do it, with the measurements behind the decision in `docs/decisions.md` ("Liquids move by a velocity field and a global pressure solve"):

- Pressure is not local. When one arm of a U-tube is higher, the other arm must rise right away, so the information has to cross the whole body of water at once. Rules that only swap neighbors pass it on one cell per step, and it spreads slowly, like heat.
- Compressible-mass CA (W-Shadow style): stores pressure as extra mass, so deep water shrinks (300 poured cells show 130 at compression 0.02), and it is slow (37,600 steps on a 68×80 U-tube).
- Hidden vacancy and surplus cells routed through the body: correct final levels with exact volume (~1,500 steps on 68×80, ~7,500 on 196×240), but the only GPU-friendly version tried jammed, and water has no momentum.
- Free-surface MAC grid (staggered velocity, pressure projection, fill per cell), quick prototype: arms within ~2 cells in ~1,000 steps with exact volume. But the fill smeared into a foam band ~10 cells deep at the surface, and naive fill limiting stalled the flow. Tracking the surface needs a proper technique, and it is what killed the earlier Eulerian attempt (`git show 6eaac45:docs/research/realistic-water.md`).

## Acceptance criteria

Scenes and expected levels are defined in `src/scenes.ts` (M1.1). A **step** is one superstep: one fluid update plus the two CA dispatches. 1x speed is 4 steps per frame, about 240 per second at 60 fps. The budgets below are first estimates from the prototypes; they may be revised at the M1.3 gate with the user's approval.

- **AC1** WHEN the small U-tube (68×80) runs, THE SYSTEM SHALL bring both arms within 1 cell of the expected level within 2,000 steps, and keep them there for the next 1,000.
- **AC2** WHEN the large U-tube (196×240) runs, THE SYSTEM SHALL meet AC1's condition within 8,000 steps.
- **AC3** WHEN a U-tube with arms 8 and 32 cells wide runs, THE SYSTEM SHALL meet AC1's condition within 4,000 steps.
- **AC4** WHILE any scene runs without brush input, THE SYSTEM SHALL keep each liquid's volume constant: exactly (cell or particle count) for a discrete representation, within 10⁻⁵ relative for a fractional one.
- **AC5** WHEN a scene has settled, THE SYSTEM SHALL show no empty cell enclosed by liquid (no bubbles) and, for a fractional representation, no cell between 5% and 95% full more than 1 cell below the surface (no foam).
- **AC6** WHEN the basin scene (a 40×49 block released at one end of a 200×60 tank) runs for 3,000 steps, THE SYSTEM SHALL leave every column's level within 1 cell of every other.
- **AC7** WHEN a water column is released against one wall of a tank (dam break), THE SYSTEM SHALL let the front reach the far wall and climb at least 5 cells above the final rest level before settling (momentum; a leveling-only model fails this).
- **AC8** IF a liquid body has no free surface (sealed full chamber), THEN THE SYSTEM SHALL keep it at rest: no cell changes and no velocity above 10⁻³ cells/step.
- **AC9** WHEN a single water cell or a one-cell-thick film rests on a floor, THE SYSTEM SHALL keep it in place without losing it.
- **AC10** WHEN sand is dropped into a pool, THE SYSTEM SHALL let the sand reach the bottom, keep water volume unchanged and raise the surface by the displaced volume (within 1 cell).
- **AC11** WHEN the small U-tube is filled with oil, THE SYSTEM SHALL meet AC1; WHEN oil is poured onto water, THE SYSTEM SHALL keep the oil above the water.
- **AC12** WHEN AC1, AC6 and AC7 run on the GPU through read-back, THE SYSTEM SHALL pass them with the same thresholds.
- **AC13** WHEN the page is opened with `?scene=<name>`, THE SYSTEM SHALL load that scene so it can be watched.
- **AC14** WHILE running at 1x on the default grid, THE SYSTEM SHALL keep 60 fps on the dev machine, and at 8x SHALL lose at most 25% frame rate compared to the commit before M1.4.
- **AC15** WHEN sand, smoke, fire and the brush are used as today, THE SYSTEM SHALL behave as before: the existing `tests/simulation.test.ts` cases still pass, and sand piles, smoke rises, fire burns oil and water puts it out.

## Design

### What stays

The packed `u32` cell grid, the Margolus CA for sand, smoke and fire, the brush pass, one encoder and one submit per frame, and the per-dispatch uniform slots. Fluid state goes in separate buffers, as `docs/decisions.md` already prescribes for per-cell floats.

### Fluid grid (common to every candidate)

- **Resolution.** One fluid cell covers `k×k` grid cells, with `k = 1` or `2` chosen by the spike for cost (k = 2 makes the pressure solve 4× cheaper on a 3.5M-cell grid).
- **Staggered velocity (MAC layout).** `u` on vertical faces (`(W+1)×H` f32), `v` on horizontal faces (`W×(H+1)` f32), `pressure` per fluid cell (f32), and a `flags` byte per fluid cell: solid, liquid, air. Staggering is the standard layout for pressure projection: each face velocity sits between the two pressures that drive it.
- **Classification.** Walls and sand are solid, with face velocity 0. A fluid cell is liquid when its liquid content is at least half (the exact rule depends on the representation). Everything else is air, with pressure 0.
- **Update per step**, in order: classify; apply gravity to faces next to liquid; project (pressure solve, then subtract the pressure gradient); extrapolate liquid velocity one or two cells into air, so the surface can move; move the liquid (representation-specific); write liquid occupancy into the cell grid, so CA rules see water where it is.
- **Pressure solve.** Red-black Gauss-Seidel: two dispatches per iteration, each updating every other cell like a checkerboard, so neighbors never update at the same time. Warm-started from the previous step's pressure. Air is a Dirichlet boundary (p = 0) placed at the sub-cell surface position (ghost fluid), walls are Neumann (no flow through). The CPU reference measures how many iterations per step AC1–AC7 need. If the count is too high for AC14, add multigrid (solving the same problem on coarser grids to carry long-range pressure quickly) as a separate checklist item.
- **Gravity and units.** Cells and steps; gravity `g` is tuned so free-falling water looks as fast as falling sand (2 cells per step at most). Velocities are clamped to 1 cell per step (CFL limit: nothing may skip a cell in one step).

### Liquid representation: the spike decides

The CPU spike (M1.3) runs the acceptance tests on these candidates, in this order, and stops at the first that passes:

1. **C1 Velocity CA (lead).** Liquids stay discrete cells in the `u32` grid, so volume is exact and every existing interaction keeps working. Each liquid cell has a sub-cell displacement accumulator (two f16 or f32 per grid cell, separate buffer). Each step it adds the interpolated face velocity, and when the accumulator crosses ±1 on an axis, the cell tries to move one cell that way inside its Margolus block (swap with empty, or with a lighter liquid). A blocked move zeroes that component. Inside a full body the moves are invisible water-water swaps, and only surfaces and holes change. Risks: holes left behind when surface cells move (they are air, so the pressure solve pulls water into them, but they may linger as bubbles: AC5), and quantization of slow flows.
2. **C2 FLIP particles.** Liquid cells become particles with sub-cell position and velocity in a separate buffer: velocity goes particles → grid (with fixed-point `atomicAdd`, since WebGPU has no float atomics), the grid solves pressure, and velocity goes back grid → particles (FLIP/PIC blend). Particles then move and are rasterized into the cell grid. This is the standard technique for game and film liquids; the surface stays sharp and splashes are natural. Risks: particles bunch up or leave gaps (needs density correction), the CA must look up which particle sits in a cell to swap sand with it, and the cost grows with millions of particles.

If neither passes, stop and report: list what was tried, the measurements, and the options left (grid VOF with interface reconstruction, or the hidden-carrier fallback from the background).

### CPU reference and parity

`tests/cpu/` holds the TypeScript reference: the fluid grid, the solver, the chosen representation, and the liquid-related CA phases (fall, liquid spread, sand into liquid), structured pass by pass like the GPU. It is test-only code. GPU floats differ in rounding (fused multiply-add, summation order), so CPU and GPU are compared on metrics with tolerances, not bit for bit. The GPU must pass the same acceptance tests (AC12).

`AGENTS.md` gains an invariant: the fluid passes exist in WGSL and in `tests/cpu/` and change together.

### Scenes and metrics

- `src/scenes.ts`: scene builders returning a `Uint32Array` in the packed cell format (`cell()` layout), its width and height, and metadata (chamber column ranges, floor y). Shipped, because `?scene=` uses it. Scenes: `uTube({ scale, leftArm, rightArm, liquid })`, `basin`, `damBreak`, `sealedChamber`, `droplet`, `film`, `sandIntoPool`, `oilOnWater`.
- `tests/metrics.ts`: volume per liquid, column level (top of the contiguous liquid run above the floor), chamber level (mean over its columns), flatness, bubble count (empty cells not 4-connected to the grid's open air), foam count, max run-up height on a wall, and expected level from volume and chamber geometry.

### Frame schedule (GPU, from M1.4)

Per step: the fluid passes (classify, gravity, `N` solver iterations, project, extrapolate, move liquid, write occupancy), then the two CA dispatches. Everything stays in the frame's one encoder. Fluid uniforms are constant per frame, except a per-step seed if the representation needs one, which gets a slot like the CA's.

### Edge cases and failure modes

- Sand falling into water: sand is solid for the fluid; the CA swap moves the water cell up, and the next classify sees it.
- Fire next to water and oil ignition stay CA rules on the cell types.
- Brush: painting liquid gives it zero velocity; erasing removes it. The brush is outside AC4.
- A body cut in two by sand: the solve treats each part separately, with no global bookkeeping.
- Very thin water (one cell high): classification must keep a one-cell film liquid, or it never moves (AC9).
- Solver not converged: residual divergence slowly gains or loses volume in fractional representations, and makes cells jitter in discrete ones. Track it as a metric (max divergence after projection).

## Checklist

Each item: implement, run `npm run lint`, `npm run build` and `npm test`, then tick. Before the first change, record the lint and test baseline in this section.

### M1.1 Scenes, metrics and failing acceptance tests

- [ ] **Scenes.** `src/scenes.ts` as designed. Small U-tube: 68×80, floor 2 rows, arms 16 wide, partition 32 wide from y = 10, passage 8 tall, left arm filled to y = 70, passage full. Large: the same ×3. Unequal: arms 8 and 32. Unit tests check sizes, the cell format against `tests/gpu.ts` `cell()`, and that the expected level is analytically right for the U-tube (38.0 for the small one).
- [ ] **Metrics.** `tests/metrics.ts` as designed, with unit tests on small hand-built grids: a column with a gap, an enclosed bubble versus an open dent, a partial chamber.
- [ ] **Acceptance suite, failing.** `tests/liquids.test.ts`: AC1–AC11 written against a `LiquidModel` interface (`load(scene)`, `step(n)`, `cells()`, `volume()`, plus a fill or velocity view for metrics). It starts with no implementation, so the cases are marked `it.todo`, or `it.fails` once a model is wired in. Note the CPU time of the large scenes here.

### M1.2 CPU fluid core

- [ ] **Grid and classification.** `tests/cpu/fluid-grid.ts`: staggered `u`, `v`, `pressure`, `flags`, `k` = 1 or 2, classification from the cell grid. Tests: walls and sand solid, liquid and air flags on a hand-built grid at both `k`.
- [ ] **Solver.** Red-black Gauss-Seidel with ghost-fluid surface, projection, velocity extrapolation. Tests: a static pool reaches hydrostatic pressure (pressure = depth × g within 1%) and near-zero velocity; after projection, the max divergence in liquid cells is below 10⁻⁴; a sealed chamber stays at rest (AC8 at the solver level).
- [ ] **Iteration budget.** Measure the residual against the iteration count per step on the small and large U-tubes, with a warm start; record the numbers here.

### M1.3 Liquid representation spike

- [ ] **C1 Velocity CA.** `tests/cpu/velocity-ca.ts` on top of the fluid core, plus the liquid CA phases ported from `solid-ca.wgsl.ts`. Run AC1–AC11 and record the results here (steps to settle, peak run-up, bubbles, volume).
- [ ] **C2 FLIP particles**, only if C1 fails an AC it cannot reasonably be tuned to pass (three distinct attempts at most). `tests/cpu/flip.ts`, same tests, same record.
- [ ] **Gate.** Report to the user: the candidate that passed, the measured table, the chosen `k`, solver iterations and constants, and a GPU cost estimate (passes and bytes per step). Then rewrite M1.4–M1.6 below in full detail. No WGSL work starts before the user approves.

### M1.4 GPU port (outline, detailed at the gate)

- Fluid buffers and WGSL passes for the fluid core, wired into `simulate()` within the frame's one encoder.
- The chosen representation in WGSL, with the CA phases changed to match.
- GPU tests: hydrostatic pool and divergence (the M1.2 tests on the GPU), then AC1, AC6 and AC7 (AC12).
- `?scene=` loader in `main.ts` (AC13).

### M1.5 Integration and performance (outline)

- Interactions on the GPU: sand into a pool, oil on water, fire and water (AC10, AC11, AC15).
- Frame-rate measurement before and after at 1x and 8x (AC14); multigrid or a larger `k` if the budget is missed.

### M1.6 Docs (outline)

- `docs/simulation.md` (fluid grid, passes, liquid movement), `AGENTS.md` (layout, invariants, fluid buffers), `docs/decisions.md` (the representation chosen and why the other candidate lost), `docs/backlog.md` (anything deferred), `docs/roadmap.md` (delete M1), `README.md` features. Delete this plan.
