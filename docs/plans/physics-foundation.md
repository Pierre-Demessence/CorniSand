# M1 Physics foundation and realistic liquids

Status: M1.1–M1.4a are done (the CPU reference is the GPU spec, the pre-M1.4 bench baseline is recorded). No WGSL has been written. Next: M1.4b, then the WGSL items in order.

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
- **AC12** WHEN AC1–AC11 run on the GPU through read-back, THE SYSTEM SHALL pass them with the same thresholds.
- **AC13** WHEN the page is opened with `?scene=<name>`, THE SYSTEM SHALL load that scene so it can be watched.
- **AC14** WHEN the bench scene (2560×1340 grid, the bottom quarter water, M1.4a) runs at 1x (4 steps per frame) on the dev machine (RTX 4080), THE SYSTEM SHALL take at most 14 ms of GPU time per frame in `npm run bench`, and the page SHALL show 60 fps at 1x in a maximized 2560×1440 window. Above 1x the frame rate may drop with the extra steps; the bench reports 2x, 4x and 8x without a threshold.
- **AC15** WHEN sand, smoke, fire and the brush are used as today, THE SYSTEM SHALL behave as before: the existing `tests/simulation.test.ts` cases still pass, except B2 (an isolated droplet drifts sideways), which AC9 replaces (a droplet stays in place); sand piles, smoke rises (also through water), fire burns oil and water puts it out.
- **AC16** WHEN the brush paints water or oil, erases liquid, or paints over it with Shift, THE SYSTEM SHALL add 4 particles per painted liquid cell and remove every particle inside the stroke of an erase or a Shift paint over a non-wall cell; WHEN the particle store is full, THE SYSTEM SHALL paint no further liquid cells.

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

### Liquid representation: FLIP particles

Chosen at the M1.3 gate (`docs/decisions.md`, "Liquids are FLIP particles"); the GPU design below ports `tests/cpu/flip.ts`. The two candidates the spike compared, in the order it tried them:

1. **C1 Velocity CA (lead).** Liquids stay discrete cells in the `u32` grid, so volume is exact and every existing interaction keeps working. Each liquid cell has a sub-cell displacement accumulator (two f16 or f32 per grid cell, separate buffer). Each step it adds the interpolated face velocity, and when the accumulator crosses ±1 on an axis, the cell tries to move one cell that way inside its Margolus block (swap with empty, or with a lighter liquid). A blocked move zeroes that component. Inside a full body the moves are invisible water-water swaps, and only surfaces and holes change. Risks: holes left behind when surface cells move (they are air, so the pressure solve pulls water into them, but they may linger as bubbles: AC5), and quantization of slow flows.
2. **C2 FLIP particles.** Liquid cells become particles with sub-cell position and velocity in a separate buffer: velocity goes particles → grid (with fixed-point `atomicAdd`, since WebGPU has no float atomics), the grid solves pressure, and velocity goes back grid → particles (FLIP/PIC blend). Particles then move and are rasterized into the cell grid. This is the standard technique for game and film liquids; the surface stays sharp and splashes are natural. Risks: particles bunch up or leave gaps (needs density correction), the CA must look up which particle sits in a cell to swap sand with it, and the cost grows with millions of particles.

### CPU reference and parity

`tests/cpu/` holds the TypeScript reference: the fluid grid, the solver, the chosen representation, and the liquid-related CA phases (fall, liquid spread, sand into liquid), structured pass by pass like the GPU. It is test-only code. GPU floats differ in rounding (fused multiply-add, summation order), so CPU and GPU are compared on metrics with tolerances, not bit for bit. The GPU must pass the same acceptance tests (AC12).

`AGENTS.md` gains an invariant: the fluid passes exist in WGSL and in `tests/cpu/` and change together. Every fluid constant lives once in `src/fluid-params.ts`, imported by the CPU reference and interpolated into the WGSL. The key formulas are necessarily written twice (TS function, WGSL function); a GPU test checks they agree.

### Scenes and metrics

- `src/scenes.ts`: scene builders returning a `Uint32Array` in the packed cell format (`cell()` layout), its width and height, and metadata (chamber column ranges, floor y). Shipped, because `?scene=` uses it. Scenes: `uTube({ scale, leftArm, rightArm, liquid })`, `basin`, `damBreak`, `sealedChamber`, `droplet`, `film`, `sandIntoPool`, `oilOnWater`.
- `tests/metrics.ts`: volume per liquid, column level (top of the contiguous liquid run above the floor), chamber level (mean over its columns), flatness, bubble count (empty cells not 4-connected to the grid's open air), foam count, max run-up height on a wall, and expected level from volume and chamber geometry.

### GPU design (M1.4–M1.5)

The GPU runs the same passes as `FlipModel.superstep` after M1.4a, in the same order. `k = 1`, so the fluid grid is the cell grid: `nx = W`, `ny = H`. y = 0 is the bottom row on both sides.

**Files.**

- `src/fluid-params.ts` (shipped): the `FLUID` constants (today's `DEFAULT_FLIP` values plus `PER_CELL = 4`, the lattice offsets, `MAX_SPEED = 1`, `FIXED_SCALE = 2 ** 20`, `COUNT_CLAMP = 12`, the key weights), `rasterKey()` and `oilKey()` (below; build them as `quality * 2 ** 24 + low`, never `quality << 24`, which is a negative int32 in JS from quality 128 up), `spawnParticles(cells, width, height)` (4 particles per water or oil cell on the lattice, returning the packed particle records and per-kind totals), `MAX_FLUID_CELLS = 2 ** 24 - 1` and `MAX_PARTICLES = 65535 * 256` (the largest 1D indirect dispatch). The CPU reference imports all of it; no constant is duplicated in `tests/cpu/`.
- `src/fluid.ts`: class `Fluid`, owned by `Simulation`. Creates the buffers, pipelines and bind groups below (cell buffer A/B × particle buffer A/B variants where a pass binds both); `recordFrameStart(pass, brush: SimulationInput | null)` and `recordStep(pass)` record into the caller's compute pass, and tests call them directly in their own pass; `recordSelect(pass)` records one radix selection alone, for its test; `load(cells)` uploads particles and resets `p`, the particle state and the args; `clear()` does the same with no particles. Buffers are created with `COPY_SRC | COPY_DST` so tests can read and seed them.
- `src/shaders/fluid-common.wgsl.ts` (grid size, capacity and `FLUID` constants as WGSL `const`, the `Particle` struct, flag values, index helpers, fixed-point helpers), `fluid-particles.wgsl.ts`, `fluid-grid.wgsl.ts`, `fluid-raster.wgsl.ts`: one module per group, one entry point per pass. Like the CA, they are template strings that are functions of the grid size.

**Buffers** (all storage; "cell" is `W×H`, "u face" `(W+1)×H`, "v face" `W×(H+1)`):

| Buffer | Type | Content |
| --- | --- | --- |
| `particlesA`, `particlesB` | `array<Particle>`, `Particle { px, py, vx, vy: f32, kind: u32 }` (20 B) | Ping-pong for compaction. `kind` 0 water, 1 oil, 2 dead. Capacity `min(4·W·H, MAX_PARTICLES, floor(min(maxStorageBufferBindingSize, maxBufferSize) / 20))`; if creating them raises an `out-of-memory` error scope, halve the capacity and retry |
| `particleState` | `{ count: u32, spawnCursor, compactCursor, water, oil: atomic<u32> }` | Live count after compaction; `compactCursor` is zeroed by compact args, `water` and `oil` by the pass that recounts them (finalize, raster count) |
| `particleArgs`, `gridArgs` | 3 × `u32` each, `INDIRECT \| STORAGE` | `dispatchWorkgroupsIndirect` arguments: `(ceil(count / 256), 1, 1)` for particle passes; for cell and face passes the full 2D grid, or `(0, 0, 0)` when no live particle exists, so a world without liquid pays nothing for the fluid |
| `u`, `v`, `uPrev`, `vPrev` | `f32` per u / v face | Face velocities; `*Prev` is the copy taken before gravity, for the FLIP difference |
| `uAcc`, `vAcc` | `atomic<i32>`, 2 per face (sum, weight) | Fixed-point particle-to-grid accumulators |
| `uValid`, `vValid` | `u32` per face, two copies each | Extrapolation validity, ping-pong per pass |
| `count`, `oilCount` | `atomic<u32>` per cell | Particles per cell (reused for the post-advection count) |
| `flags`, `density`, `p` | `u32`, `f32`, `f32` per cell | AIR 0, LIQUID 1, SOLID 2; mean liquid density; pressure (warm start: never cleared) |
| `weights`, `diagDiv` | `vec4f`, `vec2f` per cell | Face weights (left, right, bottom, top) and (diagonal, divergence − source) from `prepare` |
| `key`, `oilKeyBuf` | `u32` per cell | Rasterization keys, 0 = not a candidate |
| `histogram` | 256 × `atomic<u32>` | Radix-select bins |
| `selectState` | `{ wanted, round, remaining, prefix, none, shortfall, maxShortfall, chosen, oilWanted, ... }` | Radix-select progress for both selections. The pick pass advances `round`, so the four rounds reuse one pipeline without a `writeBuffer` between dispatches. `wanted == 0` sets `none` (nothing chosen). `maxShortfall` is a running maximum since load, for the tests |

Every pipeline stays within 8 storage-buffer bindings (the WebGPU default `maxStorageBuffersPerShaderStage`); prepare already uses exactly 8, so group buffers into structs where a pass would need more. Atomic arrays are bound `read_write` and read with `atomicLoad`. No dispatch binds `particleArgs` or `gridArgs` as storage while consuming it as `INDIRECT`. At 2560×1340 the fluid buffers take about 300 MB and full-capacity particle buffers about 550 MB; the RTX 4080 has 16 GB.

**Grid cap.** `MAX_FLUID_CELLS` keeps a cell index in 24 bits for the keys, and the widest per-cell fluid buffer (`weights`, 16 B) must fit the binding limit: `main.ts` passes `min(maxCellsForDevice(device), floor(limit / 16), MAX_FLUID_CELLS)` to `computeGrid`, which then coarsens the scale as it already does.

**Pipeline count.** A `Simulation` now creates about 40 pipelines. If the GPU test suites' time grows noticeably (Dawn compiles slowly on a cold cache, `vite.config.ts`), cache the pipelines per device and grid size.

**Frame start** (once per frame, before the first step):

1. *Brush kill* (only while a button is down; particles, indirect): a particle dies when `floor(pos)` is within the brush stroke (the same segment-distance test as `brush.wgsl.ts`) and the brush is erasing, or replacing and the cell's current type is not wall. It runs before the cell brush so it sees the old type.
2. *Brush* (existing pass, extended): when it writes water or oil into a cell, it reserves 4 slots with `atomicAdd(spawnCursor, 4)` from `count`, and writes 4 particles at the lattice offsets with zero velocity. If the reservation passes the capacity, it writes `kind = 2` into the reserved slots that fit and leaves the cell unchanged (AC16).
3. *Compact args* (1 thread): args for `min(spawnCursor, capacity)` particles.
4. *Compact* (particles, indirect): copies live particles from the current to the other particle buffer with an atomic counter; order is not kept (the fixed-point scatter does not depend on order). The particle buffers swap every frame, so the CPU always knows which is current.
5. *Finalize* (1 thread): `count`, `spawnCursor = count`, per-kind totals, `particleArgs`.

**Per step**, mirroring `FlipModel.superstep` (P = particle pass, indirect on `particleArgs`, workgroup 256; C = cell pass, 8×8, indirect on `gridArgs`; F = face pass, 8×8 over `(W+1)×(H+1)` covering both u and v faces, indirect on `gridArgs`). Every particle pass returns at once on `kind == 2`: dead particles stay in the buffer until the next frame's compaction but must not count, scatter or move.

1. *Clear* (C+F): `count`, `oilCount`, `uAcc`, `vAcc`.
2. *Resolve* (P): an oil particle whose cell is fire dies (oil burns); a particle in a wall or sand cell moves up to the first free cell with `vy = 0` (`FlipModel.resolveSolids`).
3. *Count* (P): `count`, `oilCount` with `atomicAdd`.
4. *Classify* (C): solid from the cell type, liquid where `count > 0`, density from the kinds (`classifyFromParticles`).
5. *Particle to grid* (P): the bilinear weights of `particlesToGrid`, added as `i32(round(w · vel · FIXED_SCALE))` and `i32(round(w · FIXED_SCALE))`. Velocities are at most 1 and a face receives at most a few dozen particles, so the sums stay far below 2³¹.
6. *Normalize* (F): `u = sum / weight` where the weight is above `1e-6 · FIXED_SCALE`, else 0; zero solid faces; then the extrapolation init of `solver.ts` `extrapolate`: `valid = face touches a liquid cell`, and `value = 0` on every face that does not (P2G writes into faces of rows next to the liquid that touch none, so this zeroing matters).
7. *Extrapolate* ×2 (F): one pass per ring, as `extrapolate(grid, 2)`. Faces touching a solid are skipped. Values are updated in place (a pass only writes faces that were invalid and only reads faces that were valid), validity ping-pongs.
8. *Gravity* (F): `uPrev = u`, `vPrev = v`, then `gravity / k` on interior v faces next to liquid, damping on every face, zero solid faces.
9. *Prepare* (C): density source (`densitySource`) and the solver weights and divergence (`PressureSolver.prepare`); `p = 0` and `diag = 0` outside liquid.
10. *Sweeps* (C): `2 × iterations` dispatches, red then black, two pipelines from one entry point with an `override` color constant; cells with `diag == 0` are skipped. Red-black updates are independent of thread order, so the GPU result matches the CPU up to float rounding.
11. *Gradient* (F): `PressureSolver.apply`.
12. *Pin films* (u faces): `pinFilms`, when `FLUID.film`.
13. *Extrapolation init* (F, as in pass 6) and *extrapolate* ×2 (F).
14. *Grid to particle* (P): `gridToParticles`: FLIP blend for particles in liquid cells, ballistic gravity otherwise, clamp, axis-by-axis move blocked by wall and sand cells.
15. *Clear counts* (C), *raster count* (P): counts after advection and the per-kind totals; `wanted = floor((water + oil) / 4)`, `oilWanted = floor(oil / 4)`.
16. *Key* (C): `rasterKey` per cell (below), after `FLUID.paddingRings` (6) *padding* passes (C) that grow the candidate set one ring at a time.
17. *Select* ×4 (C histogram + 1-thread pick each): radix select of the `wanted`-th largest key, 8 bits per round from the top.
18. *Oil key* (C), *select* ×4: among the chosen cells, the `oilWanted` largest `oilKey`.
19. *Write* (C): chosen cells become water or oil (variant 0, life 0, as the CPU writes them); other water and oil cells become empty; every other cell is untouched.
20. *CA* ×2: the existing dispatches, with the liquid movement rules removed (M1.4d).

About `2 × iterations + 40` dispatches per step: 120 at 40 sweeps, 480 per frame at 1x, all in the frame's one compute pass. A dispatch that writes `particleArgs` followed by an indirect dispatch reading it is valid inside one compute pass, because each dispatch is its own usage scope.

**Rasterization keys.** The CPU sorts by a float key `count + 0.5·(side counts) + 0.3·(already liquid) + height bias`, ties by index. Multiplied by 10 the first three terms are integers whose order is the same, and the height bias only breaks ties toward lower rows, which the index order already does. So:

- `quality = 10·min(count, 12) + 5·(sideL + sideR) + 3·(cell is water or oil now)`, with a side counted as the cell's own clamped count when the neighbor is wall, sand or outside the grid, else as the neighbor's clamped count. At most 243, and at least 10 for any cell holding a particle.
- A **candidate** is a cell of type empty, water or oil (never wall, sand, smoke or fire, which fixes D16) that holds a particle, or that holds none but lies within `FLUID.paddingRings` (6) steps of one through empty, water and oil cells (the padding rings, picked only when particle cells run out). Ring `r` (1 to 6) has `quality = weightPadding + paddingRings − r`, so nearer rings win and quality stays below 10. One ring was not enough: on the large U-tube the particles pack into fewer cells than the volume needs, and the shortfall reached 299 cells with 1 ring, 160 with 2, 64 with 3 and 0 from 5 (`rasterKeys` in `tests/cpu/flip.ts`). On the GPU each ring is one cell pass, a cell joining the next ring when a 4-neighbor is in the current set. A distance field would be a cheaper alternative if the six passes show up in the bench.
- `rasterKey = quality * 2^24 + (2^24 − 1 − index)`: unique per cell, larger is better, so the selection has no ties and is deterministic. Non-candidates get 0.
- `oilKey = share · 2^24 + (index + 1)` with `share = (255 · oilCount) / count` in integer division, for chosen cells (share 0 for padding cells), 0 otherwise; larger index wins ties, so oil lands on top, as in the CPU's `b − a`. With counts up to 15, two different oil shares differ by more than 1/255, so the 8-bit share keeps the CPU's order; above that, near-equal shares may tie and fall back to the index, which is acceptable.
- If fewer candidates than `wanted` exist, every candidate is chosen and `shortfall` records the gap, `maxShortfall` its running maximum (AC4 scenes must show 0). The CPU grows `FLUID.paddingRings` rings, and the GPU does the same. If the GPU tests show a non-zero `maxShortfall`, compare with the CPU value and report. If `oilWanted` is 0 no cell is oil, and if it reaches the chosen count every chosen cell is. Flooring `wanted` and `oilWanted` only matters after oil burns (counts no longer multiples of 4): up to 3 leftover particles show no cell.

**CA changes.** `isFalling` keeps only sand, Phase 3 (liquid spread) goes, and `canDisplace` keeps only sand into water, oil, smoke or empty. Smoke still rises through liquid cells, fire still ignites oil cells and is put out by water cells, but the put-out rule applies only to cells that were fire before this block's ignition rule ran. Otherwise oil beside both fire and water would turn to fire and to smoke in one dispatch, its particles would survive in the smoke cell, and that oil would never burn away. Now it burns for one step, its particles die, and the fire goes out the step after. Removing Phase 3 shifts the random words the smoke phases use; harmless. Liquid cells move only through rasterization.

### Edge cases and failure modes

- Sand falling into water: sand is solid for the fluid; the CA swap moves the water cell up, and the next classify sees it.
- Fire next to water and oil ignition stay CA rules on the cell types. An oil cell that ignites becomes fire; the oil particles in it die at the next resolve, and rasterization never overwrites fire or smoke, so the burn is visible. Water particles inside a fire cell survive.
- Brush: painting liquid gives it zero velocity; erasing removes it. The brush is outside AC4. Kills go by particle position, so an erase also removes stray particles over empty cells in the stroke; a Shift paint of liquid over liquid with the store full leaves that cell empty until the next rasterization.
- Particles trapped under solid with no free cell above stay counted in `wanted` but cannot be drawn there; their volume shows up elsewhere.
- Particle store full: the brush stops adding liquid cells (AC16); nothing else changes.
- A body cut in two by sand: the solve treats each part separately, with no global bookkeeping.
- Very thin water (one cell high): classification must keep a one-cell film liquid, or it never moves (AC9).
- Solver not converged: residual divergence slowly gains or loses volume in fractional representations, and makes cells jitter in discrete ones. Track it as a metric (max divergence after projection).

## Checklist

Each item: implement, run `npm run lint`, `npm run build` and `npm test`, then tick. Before the first change, record the lint and test baseline in this section.

Baseline before M1.1 (dev machine, with a GPU adapter): `npm run lint` clean (0 problems), `npm run typecheck` clean, `npm run build` clean (27.7 kB JS), `npm test` 4 files / 19 tests pass (the GPU suites ran, they did not skip).

### M1.1 Scenes, metrics and failing acceptance tests

- [x] **Scenes.** `src/scenes.ts` as designed. Small U-tube: 68×80, floor 2 rows, arms 16 wide, partition 32 wide from y = 10, passage 8 tall, left arm filled to y = 70, passage full. Large: the same ×3. Unequal: arms 8 and 32. Unit tests check sizes, the cell format against `tests/gpu.ts` `cell()`, and that the expected level is analytically right for the U-tube (38.0 for the small one).
- [x] **Metrics.** `tests/metrics.ts` as designed, with unit tests on small hand-built grids: a column with a gap, an enclosed bubble versus an open dent, a partial chamber.
- [x] **Acceptance suite, failing.** `tests/liquids-*.test.ts` (four files, so vitest runs them in parallel; shared helpers in `tests/liquid-acceptance.ts`): AC1–AC11 written against a `LiquidModel` interface (`load(scene)`, `step(n)`, `cells()`, `volume()`, `maxSpeed()`, optional `fill()`). "Settled" means the arms stay inside the band for 1,000 consecutive steps starting at or before the deadline (`settleAndHold`); a model that only passes through the band while sloshing does not count. CPU time: the whole suite takes about 100 s wall on the dev machine, about 260 s summed; the large U-tube (AC2) is the longest single case at about 60 s.

### M1.2 CPU fluid core

- [x] **Grid and classification.** `tests/cpu/fluid-grid.ts`: staggered `u`, `v`, `pressure`, `flags`, `k` = 1 or 2, classification from the cell grid. Tests: walls and sand solid, liquid and air flags on a hand-built grid at both `k`.
- [x] **Solver.** `tests/cpu/solver.ts`: red-black SOR (ω = 1.85) with ghost-fluid surface (θ = 0.5), density-weighted faces, projection, velocity extrapolation (2 cells) and semi-Lagrangian advection of the field. Tests: a static pool reaches hydrostatic pressure within 1% and near-zero velocity; the max divergence after a converged projection is below 10⁻⁴; a sealed chamber stays at rest; two liquid layers hold at rest with the lighter one on top; the same hydrostatic check at `k = 2`.
- [x] **Iteration budget.** Measured on the FLIP model (`FlipModel.lastResidual`, the largest deviation of a liquid cell's net outflow from its target after the sweeps, in cells/step, measured before the gradient is applied; the target is zero except where the density correction asks for outflow; warm start from the previous step). "Active" is steps 100–400, "rest" the last 200 of 1,200:

  | Scene | Iterations | Residual active (mean / worst) | Residual at rest | Levels at 1,200 |
  | --- | --- | --- | --- | --- |
  | Small U-tube | 10 | 0.78 / 1.9 | 0.81 | 38.00, 38.00 |
  | | 20 | 0.14 / 0.42 | 4.9e-3 | 38.00, 38.00 |
  | | 40 | 0.040 / 0.15 | 3.7e-4 | 38.00, 38.00 |
  | | 80 | 0.011 / 0.078 | 3.6e-4 | 38.00, 38.00 |
  | | 160 | 4.3e-3 / 0.033 | 1.4e-4 | 38.00, 38.00 |
  | Large U-tube | 20 | 0.70 / 1.5 | 0.69 | 114.00, 114.00 |
  | | 40 | 0.19 / 0.60 | 0.19 | 114.00, 114.00 |
  | | 80 | 0.083 / 0.36 | 0.092 | 114.00, 114.00 |
  | | 160 | 0.037 / 0.18 | 0.034 | 113.88, 114.13 |
  | | 320 | 0.012 / 0.10 | 2.1e-4 | 114.00, 114.00 |

  The solver does not reach the 10⁻⁴ divergence bar on the large tube with fewer than about 300 sweeps, because plain SOR converges slowly on a 240-tall body. The levels do not depend on it: from 20 sweeps up both tubes level the same, since the particles' density correction and the FLIP blend absorb the leftover divergence. The acceptance suite runs at 40. A multigrid or preconditioned solver is the way to get the residual down cheaply on the GPU; that is a M1.4/M1.5 decision, not needed for the criteria.

### M1.3 Liquid representation spike

- [x] **C1 Velocity CA.** Built on the fluid core with the liquid CA phases ported from `solid-ca.wgsl.ts`, run against AC1–AC11, **failed**. Its code is not kept (`tests/cpu/sand-ca.ts` keeps only the sand rules the winner needs). Results below.
- [x] **C2 FLIP particles.** `tests/cpu/flip.ts`, same tests, **passes AC1–AC11** at `k = 1`. Results below.
- [ ] **Gate.** Report to the user: the candidate that passed, the measured table, the chosen `k`, solver iterations and constants, and a GPU cost estimate (passes and bytes per step). Then rewrite M1.4–M1.6 below in full detail. No WGSL work starts before the user approves.

#### M1.3 results (gate report)

**C1 Velocity CA failed**, after three distinct attempts:

1. Plain spec: air holes in the body are pressure sinks, liquid falls where the cell's own accumulator allows. Very slow leveling and heavy foam.
2. Holes count as liquid for the solver, and the CA fall rule follows the field (a cell falls unless the field lifts it faster than 0.01 cells/step). The U-tube levels in about 1,000–1,500 steps, but the surface keeps a froth of 8–18 bubbles, the body never comes to rest (mean speed 0.5–0.8), a dam-break front thins to a film and stalls before the far wall, and a one-cell film spreads.
3. Tuning and mechanisms on top of 2, measured over steps 1,500–3,000 of the small U-tube: gravity 0.01–0.05 and damping 0.005–0.1 (best g = 0.03, damping 0.02: arm levels range 35.3–38.4, bubbles mean 7.9 and max 17); accumulator decay 0.05–0.2 (worse: levels 17–54, mean speed 1.5); a lift threshold of 0.3–1 (bubbles drop to 0–3 but gravity then always wins and the tube freezes at levels 10 and 65).

The full suite with the best variant: AC4, AC8 and AC10 pass; AC1, AC2 (233 s, not settled), AC3, AC5, AC6 (flatness 16), AC7 (run-up −6.1: the front never reached the far wall), AC9 and AC11 fail. The cause is structural: volume only moves through the body by vacancy chains hopping against the flow, limited by the displacement credits the cells hold, so the pressure field cannot move liquid quickly where it must, and the surface cannot close. Tuning moves the failures around but does not remove them.

**C2 FLIP passes** AC1–AC11 at `k = 1`. Measured on the CPU reference with the shipped constants (`DEFAULT_FLIP`):

| AC | Result | Measurement at `k = 1` | At `k = 2` |
| --- | --- | --- | --- |
| AC1 | pass | settled from step 425, held 1,000 | pass (325) |
| AC2 | pass | settled from step 500 (59 s CPU) | fail: never inside the band for 1,000 steps by step 8,000 |
| AC3 | pass | settled from step 325 | pass (200) |
| AC4 | pass | exact in all six scenes over 1,500 steps | pass |
| AC5 | pass | 0 bubbles at step 3,000 in U-tube, basin, dam break and sand pool; no foam (cells are binary, `fill()` is not offered) | fail: 1 bubble in the basin |
| AC6 | pass | flatness 0 at step 3,000 (never above 0 over steps 2,500–3,000) | fail: flatness 3 |
| AC7 | pass | far-wall column peaks at 25 at step 210, rest level 6.12: run-up 18.9 | pass |
| AC8 | pass | largest particle speed 1.3e-4 (the "no cell changes" half is vacuous for particles: a full chamber always rasterizes to the same cells) | pass |
| AC9 | pass | droplet and film unchanged for 500 steps | pass |
| AC10 | pass | water volume constant, no unsupported sand; the mean level 21.32 equals the expected value by volume bookkeeping, so the displacement itself is not an independent measurement | pass |
| AC11 | pass | oil tube settled from step 275, oil stays above water, volume exact | fail: water above oil |

The `k = 2` column comes from the full suite with damping 0.002 and FLIP ratio 0.9; it was tuned only on the water scenes and not further after AC6 stayed at flatness 3 with the surface-ranking weights tried. CPU time per step: small U-tube 4.3 ms at `k = 1` (5,888 particles) and 2.4 ms at `k = 2`; large U-tube 38 ms (52,992 particles) and 21 ms.

**Constants** (`DEFAULT_FLIP`): `k = 1`; 4 particles per liquid cell on a 2 × 2 lattice at load; gravity 0.05 cells/step²; 40 red-black SOR sweeps, ω = 1.85, θ = 0.5; velocities clamped to ±1 cell/step; damping 0.005 per step; FLIP ratio 0.8 (the rest PIC); density correction stiffness 0.5 and pull 0.5; rasterization side-neighbor weight 0.5.

**What the winner needs beyond the plan's description**, each found by a failing measurement:

- **Density correction in both directions.** A cell above rest density asks the projection for outflow, and an under-dense cell surrounded by liquid asks for inflow. Without the inflow term the liquid swells: the basin settles to a mean level of about 4 (expected 10), a sparse layer of half-full cells that fills the whole tank width.
- **Rasterization by ranking.** The cell grid gets as many liquid cells as the particles add up to (count ÷ 4 per liquid, the oiliest of them oil), choosing the most crowded cells, with a bonus for cells whose side neighbors are crowded. This makes each liquid's cell count exact by construction (AC4 is structural, not emergent), and without the side weight stray cells over the surface left the basin at flatness 2–3. If packed particles cover fewer cells than needed, the shortfall is filled with empty cells beside the liquid, lowest first.
- **Classification from particles.** A cell is liquid when a particle sits in it; classifying from the rasterized cells instead leaves holes that act as pressure sinks and the body disperses.
- **Wetting pin.** A one-cell-deep layer resting on a solid does not flow sideways (its `u` faces to other such cells and to air are zeroed after projection). An inviscid liquid without surface tension would spread a droplet or film thin; AC9 asks it to stay. The pin only affects layers one fluid cell deep.
- **Sand.** Sand keeps its Margolus rules and swaps with the liquid cell below; particles left inside a cell that became sand are pushed up to the first free cell at the start of the next step.
- **Settling criterion.** AC1–AC3 and AC11 count the arms as settled only when they stay inside the band for 1,000 consecutive steps; the earlier "first time inside the band" rule was satisfied by a sloshing tube passing through it.

**Known weakness.** The particles keep moving at rest: in the settled large U-tube about 19% of them move faster than 0.3 cells/step (FLIP noise). The ranked cell output hides it (the arm levels stay within ±0.5 of 114 and the criteria pass), but it should be damped before sand sinks through water (backlog D14).

**GPU cost estimate** (inferred from the algorithm and the buffer sizes, not measured; assumes a 3.5M-cell grid, 25% of it liquid, so 0.9M liquid cells and 3.5M particles, and about 300 GB/s of effective bandwidth, which is a guess for the dev GPU). One step is about `2N + 22` dispatches: clear, particle count, classify, particle-to-grid scatter, normalize with gravity, extrapolate (four face passes), density source, weights, `2N` red-black sweeps, gradient update, wetting pin, grid-to-particle with advection, rasterization (count, key, histogram, threshold, write), sand CA ×2.

| | `k = 1`, N = 40 | `k = 1`, N = 20 | `k = 2`, N = 40 | `k = 2`, N = 20 |
| --- | --- | --- | --- | --- |
| Dispatches per step | 102 | 62 | 102 | 62 |
| Solver sweeps (about 20 B per updated cell, half the cells per sweep) | 2.8 GB | 1.4 GB | 0.7 GB | 0.35 GB |
| Other cell and face passes | 1.0 GB | 1.0 GB | 0.45 GB | 0.45 GB |
| Particle passes (about 150 B per particle, 16 atomic adds in the scatter) | 0.5 GB | 0.5 GB | 0.5 GB | 0.5 GB |
| Bytes per step | about 4.3 GB | about 2.9 GB | about 1.65 GB | about 1.3 GB |
| Time per step at 300 GB/s | about 14 ms | about 10 ms | about 5.5 ms | about 4.3 ms |
| Time per frame at 1x (4 steps) | about 57 ms | about 38 ms | about 22 ms | about 17 ms |

The 16.7 ms frame budget of AC14 is missed by 2–3× at `k = 1` and is borderline at `k = 2`. The levers, in the order I would try them: skip solver tiles with no liquid (the liquid is rarely the whole grid); fewer sweeps (20 sweeps level both tubes the same on the CPU); a multigrid or preconditioned solver; running the fluid update every second step while the sand CA keeps its rate; `k = 2` once its surface noise is fixed (the CPU `k = 2` model fails AC2, AC5, AC6 and AC11). The GPU-specific risks: the scatter needs fixed-point `atomicAdd` on `u`, `v` and their weights; the rasterization needs a global "N most crowded cells" selection (a histogram of the integer keys plus a threshold pass, with ties broken by an atomic counter, and a second one for the oil split); and the result must be compared with the CPU reference by metrics with tolerances, not bit for bit.

#### M1.3 gate decisions

Taken by the agent on the user's behalf: none of the three changes something the user can judge from a description (`AGENTS.md`, "Working with the user"). The user approves the plan as a whole, and looks at the one visible effect (3) in M1.4f.

1. **FLIP particles at `k = 1`.** The only candidate that passed, and the standard technique for game and film liquids. `k = 2` stays a cost lever, usable only once D15 is fixed.
2. **AC14 revised** (criteria above). The old 8x clause compared against the CA-only commit, but 8x runs 32 fluid steps per frame, each costing more than the whole CA, so no liquid model with a global solve could meet it. 1x at 60 fps on the dev machine stays the target; higher speeds are measured, not gated. The cost table above assumed 300 GB/s, while the RTX 4080 peaks at about 717 GB/s, so it is pessimistic; M1.4g replaces it with a measurement. Levers that do not change the result (active tiles, fewer sweeps if every test still passes, multigrid, shared-memory accumulation) are applied without asking. Levers that change the look (fluid update every second step, `k = 2`, a coarser grid) need the user's approval, shown as a before and after on a `?scene=`.
3. **Wetting pin kept.** Visible effect: a layer of liquid one cell thin stays where it is; it does not creep sideways or drip off a ledge until more liquid joins it, and can cling to a sand slope. AC9 asks for this, and it is one switch (`FLUID.film`).

Gaps the gate report missed, now in the design and the checklist: oil could never burn (rasterization overwrote the fire cell with oil while its particles lived), the brush had no way to add or remove particles, `tests/simulation.test.ts` B2 asserts the droplet drift that AC9 forbids, and the CPU scenes are at most 240 cells tall while the screen grid is about 1,340, so the solver's convergence at screen scale is unmeasured (M1.5b).

### M1.4 GPU port

Order matters: each item builds on the previous one. Every item that adds WGSL keeps the game running (`npm run dev` shows no WebGPU error banner) and must show that the GPU suites ran, not skipped, on the dev machine. Each item is sized for one Sonnet sub-agent given this plan; on a parity failure with an unclear cause, stop and report instead of tuning.

- [x] **M1.4a CPU reference as the GPU spec** (TypeScript only, no WGSL). Done. Deviation: 6 padding rings instead of 1 (see "Rasterization keys"); with 6, `maxShortfall` is 0 in all six AC4 scenes and every threshold is unchanged. Settle steps on the CPU are now AC1 250 (was 425), AC2 500, AC3 350 (325), AC11 475 (275, budget 2,000), AC7 run-up 18.88; the suite takes about 117 s.
  - Create `src/fluid-params.ts` as in "GPU design / Files". `tests/cpu/flip.ts` builds `DEFAULT_FLIP` from `FLUID` and uses `spawnParticles` in `load`.
  - Split `FlipModel.superstep` into public methods called in this order, so tests can stop between them: `stepGrid()` (resolve, count, classify, particle to grid, through the second extrapolate), `stepParticles()` (grid to particle), `stepRaster()`, `stepCa()`. Add `debugState()` returning the particle arrays and the grid's `u`, `v`, `p`, `flags` and `density`.
  - `resolveSolids`: an oil particle whose cell is fire is removed from the particle arrays.
  - `rasterize`: candidates, `rasterKey`, the padding ring, `oilKey` and the floors of `wanted` and `oilWanted` exactly as in "GPU design / Rasterization keys", selecting by sorting on the integer keys. Delete `padToVolume` and the `smooth` option (the weights are in the key). Record `shortfall` and its running maximum `maxShortfall`; the AC4 scenes assert `maxShortfall` 0 (if not, add a second padding ring on both sides and say so).
  - Add `seedVelocities(seed)` to `FlipModel`: random particle velocities in ±0.5 from `mulberry32`, so the parity tests exercise a non-zero field.
  - New `tests/cpu/flip.test.ts`: (1) on 10,000 random small count grids (`mulberry32`), sorting by `rasterKey` gives the same order as the old float key (copy the old formula into the test) whenever no count exceeds 12; (2) a smoke cell and a fire cell touching a resting pool are still smoke and fire after 100 steps, and the water volume is unchanged (D16); (3) an oil particle inside a fire cell is gone after one step and `oilWanted` drops accordingly; (4) a model holding 4·n + 3 particles shows n liquid cells.
  - The whole acceptance suite still passes with unchanged thresholds. If a criterion fails, stop and report the measurement; do not retune constants.
  - Bench baseline: `tests/bench.gpu.ts` and `vitest.bench.config.ts` (includes only that file; covered by `tsconfig` and ESLint), script `"bench": "vitest run --config vitest.bench.config.ts"`. `tests/gpu.ts` exports `createDevice(options)` (keeping the module-level GPU reference) so the bench can request the adapter with `powerPreference: 'high-performance'`; the bench config sets a test timeout of 10 minutes. It and prints `adapter.info.vendor`, `architecture` and `description` (the machine also has an Intel UHD 770; only numbers from the RTX 4080 count). Bench scene, built in the file: a 2560×1340 tank (2-cell walls and floor), water in the bottom quarter, a 200×200 sand block above it. For 4, 8, 16 and 32 supersteps per frame: 20 warm-up frames, then 60 frames of `simulate` + `submit` + `await device.queue.onSubmittedWorkDone()`; print the median ms per frame and per step. Write the numbers for the current CA under "M1.4 measurements" as the pre-M1.4 baseline.
  - Delete D16 from `docs/backlog.md`.
- [ ] **M1.4b Particle store, load and frame start.**
  - `src/fluid.ts`, `src/shaders/fluid-common.wgsl.ts`, `src/shaders/fluid-particles.wgsl.ts` (brush kill, compact args, compact, finalize), `src/shaders/brush.wgsl.ts` (spawn), `src/simulation.ts` (owns a `Fluid`; new `load(cells)` writes the cells and the particles from `spawnParticles`; `clear()` also empties the particle store; `simulate()` records the frame-start passes), `src/main.ts` (grid cap with `MAX_FLUID_CELLS`). A `particleCapacity` option on `SimulationOptions` overrides the computed capacity, for tests.
  - `tests/gpu.ts`: `loadScene(sim, cells)` (calls `sim.load`) replaces `loadCells` everywhere, including every case of `tests/simulation.test.ts`; `readParticles(sim)` returns the live particle records. `Fluid` gets the same `seedVelocities(seed)` as the CPU, writing the particle buffer.
  - New `tests/fluid-particles.test.ts` (GPU): loading the small U-tube gives the same particles as `spawnParticles` (compared as sorted lists) and totals; painting water with radius 5 on an empty grid gives exactly 4 particles per new water cell, at the lattice offsets; erasing across a pool removes the particles of the erased cells only; Shift-painting sand over water removes the particles of the overwritten cells; with `particleCapacity` 40, painting 20 cells of water paints exactly 10 and every live particle has kind 0 or 1; compaction keeps exactly the live set. The D4 single-submit test still passes.
- [ ] **M1.4c Grid passes and pressure solve.**
  - `src/shaders/fluid-grid.wgsl.ts` (clear, classify, normalize, extrapolate, gravity, prepare, sweep, gradient, pin, and a test-only residual pass that writes the largest residual with `atomicMax` on the `u32` bits of a non-negative `f32`), `src/shaders/fluid-particles.wgsl.ts` (resolve, count, particle to grid). `Fluid.recordStep` records per-step passes 1–13; `simulate()` calls it before each superstep's CA dispatches. `Fluid` takes an `iterations` override, for tests and the bench.
  - New `tests/fluid-parity.test.ts` (GPU): for the small U-tube, dam break, oil on water, sand into pool and film scenes, load the same scene into `FlipModel` and the GPU, seed the same velocities on both (`seedVelocities`), run one `stepGrid()` on the CPU and one step's passes 1–13 on the GPU (calling `fluid.recordStep` in the test's own pass), and compare: `flags` identical; `u`, `v`, `p` and `density` within `1e-4 · max(1, max |cpu value|)`, skipping faces whose CPU particle weight is below `1e-3` (fixed-point rounding dominates there), reporting the worst face or cell on failure. A GPU key-pass test checks the WGSL keys against `rasterKey()` and `oilKey()` on random count grids.
  - GPU versions of the M1.2 solver tests, running passes 1–13 only (particles do not move yet): a still 32×40 pool on the pristine lattice (4 particles per cell, so the density source is 0) reaches hydrostatic pressure within 1% after 200 steps, with the residual pass at or below `1e-4`; the sealed chamber's face speeds stay at or below `1e-3`.
- [ ] **M1.4d Particle motion, rasterization and the CA change.**
  - `fluid-particles.wgsl.ts` (grid to particle, raster count), `src/shaders/fluid-raster.wgsl.ts` (key; histogram with a workgroup-local 256-bin histogram flushed to the global one; single-thread pick; oil key; write). `Fluid.recordStep` gains passes 14–19. `solid-ca.wgsl.ts` gets the "CA changes"; update `docs/simulation.md` phases 1 and 3 and the density note in the same item.
  - Radix-select test (GPU, through `recordSelect` with `key` and `selectState.wanted` written by the test): random keys on a 97×61 grid (a third of them 0) with `wanted` 0, 1, half, all candidates and more than all; the chosen set equals the CPU top-`wanted` by sort, and `shortfall` is the gap.
  - Full-step parity in `tests/fluid-parity.test.ts`, same scenes: with seeded velocities, after 1 step at most 2 cells differ and particle counts per cell match except in those cells, with the mean particle velocity per cell within `1e-4`. Particles are compared per cell because compaction reorders them. After 10 steps, per-type volumes identical and at most 0.5% of liquid cells differ (tighten or loosen once measured, and record why).
  - `tests/simulation.test.ts`: delete B2 (AC15 names the exception; the GPU AC9 case in M1.4e replaces it). D5 must still conserve every type; if water or oil drift, report `maxShortfall` and stop.
  - Add the CA put-out-after-ignition change with a GPU test: oil touching both fire and water becomes fire, then smoke, and its particles are gone.
- [ ] **M1.4e GPU acceptance (AC12).**
  - `tests/liquid-model.ts`: every `LiquidModel` method may return a Promise; `settleAndHold`, `observe` (awaiting its visitor) and `expectVolumesConstant` become async; the `tests/liquid-acceptance.ts` helpers and `tests/liquids-*.test.ts` await them (the CPU model stays synchronous).
  - New `tests/gpu-liquid-model.ts`: `GpuLiquidModel` over `Simulation` (`load` → `sim.load`; `step(n)` → `run` in chunks of at most 32; `cells` → `readCells`; `volume` from the cells; `maxSpeed` from `readParticles`).
  - New `tests/liquids-gpu.test.ts` (skips without a device): AC1–AC9 through the shared helpers, same thresholds, AC4 also asserting `maxShortfall` 0. If one fails while the CPU passes, run the parity test for more steps to find where they diverge; never tune a constant on the GPU side only.
- [ ] **M1.4f `?scene=` loader (AC13), then the user looks.**
  - `src/main.ts`: when `?scene=<name>` names a `SCENES` entry, the grid takes the scene's size (no `computeGrid`), the scene is loaded with `simulation.load`, and the display stretches it to the canvas as on resize. An unknown name logs a warning and starts the normal empty grid. Clear empties it as usual.
  - Hand over "Needs the user" below and record the answers on the pin and the splash look here.
- [ ] **M1.4g First GPU timing.** Extend `tests/bench.gpu.ts` to the FLIP build: the same scene and speeds, plus a run with `iterations: 0` to separate the solver's cost. Add the numbers under "M1.4 measurements" next to the baseline. Report to the user in plain words (does 1x reach 60 fps, how choppy is 8x) and list which M1.5c levers follow.

#### M1.4 measurements

Filled by M1.4a (baseline) and M1.4g.

Pre-M1.4 baseline, M1.4a, `npm run bench` on the RTX 4080 (adapter vendor nvidia, architecture lovelace), CA only (no fluid), 2560×1340 bench scene, median of 60 frames after 20 warm-up frames and a 2 s burn-in:

| Supersteps per frame | ms per frame | ms per superstep |
| --- | --- | --- |
| 4 (1x) | 0.40 | 0.101 |
| 8 | 1.13 | 0.142 |
| 16 | 2.57 | 0.161 |
| 32 | 4.89 | 0.153 |

The numbers move by up to a factor of 2 between runs (the 16-superstep frame measured 1.8 to 4.3 ms over five runs); the 1x frame is about 0.4 ms and the 32-superstep frame 5–8 ms.

#### Needs the user (after M1.4f)

1. `npm run dev`, open `?scene=damBreak`: the water column should collapse, run to the far wall, climb it and settle flat. Then `?scene=uTube`: both arms end at the same height.
2. Open `?scene=droplet` and `?scene=film`, then draw a sand slope and a wall ledge on an empty grid and pour a little water on each. Expected: thin water stays where it lands, does not drip off the ledge until more joins it, and may cling to the slope. Say whether that looks right, or whether thin water should keep flowing.
3. Pour water from a height into a pool and watch the splash. Some flying drops may flicker or look sparse (the cell count is kept exact, so lone drops compete with the pool for cells). Say whether it bothers you.
4. A failure looks like: the WebGPU error banner, water that never settles or keeps boiling at rest, water vanishing or multiplying, oil that does not burn.

### M1.5 Integration and performance

- [ ] **M1.5a Interactions on the GPU (AC10, AC11, AC15).** `tests/liquids-gpu.test.ts` gains AC10 and AC11. `tests/simulation.test.ts` gains: fire burns oil (a 20×5 oil block in a tank under a row of fire: sampled every 50 steps, the oil count never rises, has dropped by at least half after 600 steps, and smoke appears); water puts out fire (a fire cell beside water is smoke two supersteps later); smoke rises through water (one smoke cell at the bottom of a pool 10 deep is above the surface within 40 supersteps, and the water count is unchanged).
- [ ] **M1.5b Screen-scale check.** Add `uTubeHuge` (`uTube({ scale: 6 })`, 408×480) and `deepPool` (512×1200: a 2-cell tank with water 1,000 deep, and a column of water 100 wide and 150 tall dropped at one side) to `src/scenes.ts`, with GPU-only tests in `tests/liquids-gpu.test.ts`: `uTubeHuge` settles (AC1's band) within 16,000 steps; after 6,000 steps `deepPool` has flatness at most 1 and at most 35% of its particles move faster than 0.3 cells/step (the settled large U-tube has 19% on the CPU; record the GPU value). Record the residual and both numbers here. If either fails, multigrid (M1.5c lever 3) is required.
- [ ] **M1.5c Cost levers**, only as far as M1.4g and M1.5b require, in this order; each is kept only when the parity tests and every GPU acceptance test still pass and the bench shows a gain:
  1. Active tiles: classify marks each 8×8 tile holding liquid or within 3 cells of it and appends it to a list with an atomic counter; cell and face passes and the sweeps dispatch indirect over that list. Clear covers the tiles active in this step and the previous one, so no stale accumulator survives. The parity tests must not change. Expect this lever to be needed: 80 sweeps over 3.4M cells at 4 steps a frame is about 25–35 ms on its own.
  2. 20 sweeps: CPU acceptance suite first, then GPU.
  3. Multigrid or a preconditioned solver: CPU reference first (`tests/cpu/solver.ts` and its tests), then WGSL. It gets its own design section in this plan, written with Opus, before implementation.
  4. Workgroup-shared accumulation in the particle-to-grid scatter, if the bench shows the scatter dominating.

  The levers that change the look (fluid update every second step, `k = 2` after D15, a coarser grid) need the user's approval with a before and after.
- [ ] **M1.5d Final measurement (AC14).** `npm run bench` at 1x within 14 ms per frame; record 2x–8x. Hand to the user: maximize a 2560×1440 window, fill about a quarter of the screen with water, and read the FPS counter at 1x (expected about 60) and at 8x (no target; say if it feels unusable).

### M1.6 Docs

- [ ] `docs/simulation.md`: a fluid section (grid, particles, the per-step passes, rasterization by ranking, how the brush and reactions add and remove particles).
- [ ] `AGENTS.md`: layout (`src/fluid.ts`, `src/fluid-params.ts`, the fluid shaders, `tests/cpu/flip.ts`, the parity and bench files, `npm run bench`), the invariants (fluid passes exist in WGSL and `tests/cpu/` and change together; fluid constants and keys live only in `src/fluid-params.ts`; the CA never moves liquid; rasterization never overwrites wall, sand, smoke or fire), and "Adding a particle type" (a liquid needs a particle kind and a density).
- [ ] `docs/decisions.md`: check the FLIP entry still matches what shipped; add anything from M1.5c that passes its test. `docs/backlog.md`: update D14 and D15 with the GPU measurements, add anything deferred. `docs/roadmap.md`: delete M1. `README.md`: features (connected vessels level, splashes, oil floats, the brush with liquids). Delete this plan in the final commit.
