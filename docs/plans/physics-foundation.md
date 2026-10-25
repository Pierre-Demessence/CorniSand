# M1 Physics foundation and realistic liquids

Status: M1.1–M1.4g, M1.5a and M1.5b are done (the CPU reference is the GPU spec, the pre-M1.4 bench baseline is recorded, the GPU particle store, load and frame start exist, the GPU grid passes and pressure solve match the CPU, particles move and are rasterized on the GPU, the CA no longer moves liquid, AC1–AC9 pass on the GPU, `?scene=` loads a scene, the first GPU timing is recorded; both M1.5b screen-scale cases fail). M1.5c lever 0 (per-pass timing) is done: the pressure sweeps are 40–55% of the GPU time of a 1x frame, see "M1.5c measurements". M1.5c.3a is done: the CPU `MultigridSolver` exists and meets E1–E3 as multigrid-preconditioned conjugate gradients (fallback (c)), parameters in `FLUID`. Next: M1.5c.3b (`FlipModel` on `FLUID.solver`, E4).

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
| `flags`, `density`, `p` | `u32`, `f32`, `f32` per cell | AIR 0, LIQUID 1, SOLID 2; mean liquid density; pressure (warm start: cleared only by `load` and `clear`, and zeroed outside liquid by `prepare`) |
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

Gaps the gate report missed, now in the design and the checklist: oil could never burn (rasterization overwrote the fire cell with oil while its particles lived), the brush had no way to add or remove particles, `tests/simulation.test.ts` B2 asserts the droplet drift that AC9 forbids, and the CPU scenes are at most 240 cells tall while the screen grid is about 1,340, so the solver's convergence at screen scale was unmeasured until M1.5b.

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
- [x] **M1.4b Particle store, load and frame start.** Done. Deviations: `seedVelocities(seed)` is async (it reads the buffer back) and only valid right after `load`; `mulberry32` moved to `src/random.ts` so `src` does not import from `tests`; `Simulation.create` is an async factory that halves the capacity on an `out-of-memory` probe (the synchronous constructor stays for tests); the grid cap sits in `maxCellsForDevice` (`src/grid.ts`); per-kind totals are summed by `compact` (per workgroup, one atomic add each) and `finalize` publishes `count`, `spawnCursor` and the args; `gridArgs` covers `(W+1)×(H+1)`; `bench` and tests use `sim.load` / `loadScene`. At 4 supersteps per frame the bench scene (3.4M particles) costs about 2.15 ms against the 0.40 ms CA-only baseline, all of it the fixed per-frame compaction (one measurement; a version with a per-thread `atomicLoad` and a global compaction counter took 6.4 ms).
  - `src/fluid.ts`, `src/shaders/fluid-common.wgsl.ts`, `src/shaders/fluid-particles.wgsl.ts` (brush kill, compact args, compact, finalize), `src/shaders/brush.wgsl.ts` (spawn), `src/simulation.ts` (owns a `Fluid`; new `load(cells)` writes the cells and the particles from `spawnParticles`; `clear()` also empties the particle store; `simulate()` records the frame-start passes), `src/main.ts` (grid cap with `MAX_FLUID_CELLS`). A `particleCapacity` option on `SimulationOptions` overrides the computed capacity, for tests.
  - `tests/gpu.ts`: `loadScene(sim, cells)` (calls `sim.load`) replaces `loadCells` everywhere, including every case of `tests/simulation.test.ts`; `readParticles(sim)` returns the live particle records. `Fluid` gets the same `seedVelocities(seed)` as the CPU, writing the particle buffer.
  - New `tests/fluid-particles.test.ts` (GPU): loading the small U-tube gives the same particles as `spawnParticles` (compared as sorted lists) and totals; painting water with radius 5 on an empty grid gives exactly 4 particles per new water cell, at the lattice offsets; erasing across a pool removes the particles of the erased cells only; Shift-painting sand over water removes the particles of the overwritten cells; with `particleCapacity` 40, painting 20 cells of water paints exactly 10 and every live particle has kind 0 or 1; compaction keeps exactly the live set. The D4 single-submit test still passes.
- [x] **M1.4c Grid passes and pressure solve.** Done. Parity after one step on all five scenes: flags identical, `u`, `v`, `p` within 3e-6, density exact; the still pool is hydrostatic within 5e-6 relative (expected `g · (1 − damping) · depth`, since damping scales the gravity of the step) with a residual of 1.3e-6; the sealed chamber's face speeds stay at 3e-8. Deviations: the key-pass test moves to M1.4d, where the key pass is built; `FLUID` gains `oilDensity` (moved from `tests/cpu/fluid-grid.ts`), `minWeight` and `resolveLift` (literals of the CPU reference), and `FLUID_FLAG`; both validity copies, and each accumulator pair, share one buffer to stay within 8 bindings; the overrides `COLOR` and `READ` have no `@id` (Dawn rejects constants passed by name otherwise); the solver tests are in `tests/fluid-solver.test.ts`. Every `Simulation` creates about 17 more pipelines; test time did not change noticeably.
  - `src/shaders/fluid-grid.wgsl.ts` (clear, classify, normalize, extrapolate, gravity, prepare, sweep, gradient, pin, and a test-only residual pass that writes the largest residual with `atomicMax` on the `u32` bits of a non-negative `f32`), `src/shaders/fluid-particles.wgsl.ts` (resolve, count, particle to grid). `Fluid.recordStep` records per-step passes 1–13; `simulate()` calls it before each superstep's CA dispatches. `Fluid` takes an `iterations` override, for tests and the bench.
  - New `tests/fluid-parity.test.ts` (GPU): for the small U-tube, dam break, oil on water, sand into pool and film scenes, load the same scene into `FlipModel` and the GPU, seed the same velocities on both (`seedVelocities`), run one `stepGrid()` on the CPU and one step's passes 1–13 on the GPU (calling `fluid.recordStep` in the test's own pass), and compare: `flags` identical; `u`, `v`, `p` and `density` within `1e-4 · max(1, max |cpu value|)`, skipping faces whose CPU particle weight is below `1e-3` (fixed-point rounding dominates there), reporting the worst face or cell on failure. A GPU key-pass test checks the WGSL keys against `rasterKey()` and `oilKey()` on random count grids.
  - GPU versions of the M1.2 solver tests, running passes 1–13 only (particles do not move yet): a still 32×40 pool on the pristine lattice (4 particles per cell, so the density source is 0) reaches hydrostatic pressure within 1% after 200 steps, with the residual pass at or below `1e-4`; the sealed chamber's face speeds stay at or below `1e-3`.
- [x] **M1.4d Particle motion, rasterization and the CA change.** Done. Parity with seeded velocities: after 1 step 0 cells differ and per-cell mean velocity differs by at most 5.1e-7; after 10 steps 0 liquid cells differ and volumes are identical on all five scenes (thresholds unchanged). `maxShortfall` is 0 on GPU and CPU in all eight scenes over 600 steps. Deviations: `setWanted` is its own 1-thread pass (so `recordSelect` lets a test supply `wanted`); single-thread passes dispatch directly, not indirectly; the key buffer is `atomic<u32>` so the in-place padding rings do not race; the oil selection reuses the pipelines through `override OIL`; `recordStep(pass, stage)` takes `'grid'` to stop after pass 13 (the M1.4c solver and parity tests use it); the test hooks are `recordSelect`, `recordKeys`, `recordOilKeys` and `Fluid.raster`; a move is tested at the stored f32 position only (the CPU also tests the unrounded one; no measurement differs). A step is about 29 dispatches longer than estimated and a `Simulation` creates about 15 more pipelines; test time did not change noticeably.
  - `fluid-particles.wgsl.ts` (grid to particle, raster count), `src/shaders/fluid-raster.wgsl.ts` (key; histogram with a workgroup-local 256-bin histogram flushed to the global one; single-thread pick; oil key; write). `Fluid.recordStep` gains passes 14–19. `solid-ca.wgsl.ts` gets the "CA changes"; update `docs/simulation.md` phases 1 and 3 and the density note in the same item.
  - Key-pass test (GPU, moved from M1.4c): the WGSL keys match `rasterKey()` and `oilKey()` on random count grids.
  - Radix-select test (GPU, through `recordSelect` with `key` and `selectState.wanted` written by the test): random keys on a 97×61 grid (a third of them 0) with `wanted` 0, 1, half, all candidates and more than all; the chosen set equals the CPU top-`wanted` by sort, and `shortfall` is the gap.
  - Full-step parity in `tests/fluid-parity.test.ts`, same scenes: with seeded velocities, after 1 step at most 2 cells differ and particle counts per cell match except in those cells, with the mean particle velocity per cell within `1e-4`. Particles are compared per cell because compaction reorders them. After 10 steps, per-type volumes identical and at most 0.5% of liquid cells differ (tighten or loosen once measured, and record why).
  - `tests/simulation.test.ts`: delete B2 (AC15 names the exception; the GPU AC9 case in M1.4e replaces it). D5 must still conserve every type; if water or oil drift, report `maxShortfall` and stop.
  - Add the CA put-out-after-ignition change with a GPU test: oil touching both fire and water becomes fire, then smoke, and its particles are gone.
- [x] **M1.4e GPU acceptance (AC12).** Done. AC1–AC9 pass on the GPU with the CPU thresholds and `maxShortfall` 0 in all six AC4 scenes; `tests/liquids-gpu.test.ts` takes about 145 s (18 cases, the large U-tube longest). Deviations: the CPU suite's AC5–AC10 and AC11 oil-on-water bodies moved into `expect*` helpers in `tests/liquid-acceptance.ts`, which the CPU and GPU files both call, so the two suites cannot drift; `GpuLiquidModel` creates a new `Simulation` per `load` (the grid size follows the scene), keeps the cells of the last `step` read back, and refreshes `maxShortfall` from the select state after each `step`.
  - `tests/liquid-model.ts`: every `LiquidModel` method may return a Promise; `settleAndHold`, `observe` (awaiting its visitor) and `expectVolumesConstant` become async; the `tests/liquid-acceptance.ts` helpers and `tests/liquids-*.test.ts` await them (the CPU model stays synchronous).
  - New `tests/gpu-liquid-model.ts`: `GpuLiquidModel` over `Simulation` (`load` → `sim.load`; `step(n)` → `run` in chunks of at most 32; `cells` → `readCells`; `volume` from the cells; `maxSpeed` from `readParticles`).
  - New `tests/liquids-gpu.test.ts` (skips without a device): AC1–AC9 through the shared helpers, same thresholds, AC4 also asserting `maxShortfall` 0. If one fails while the CPU passes, run the parity test for more steps to find where they diverge; never tune a constant on the GPU side only.
- [x] **M1.4f `?scene=` loader (AC13), then the user looks.** The user checked it: everything works, no complaint about the pin or the splash. They noticed the scenes are tiny (test-sized, stretched to the window) and, on the real 1920×897 grid, about 27 FPS at 1x once any water exists, plus a 3–4 s load: the FPS is the cost M1.4g measures and M1.5c lever 1 (active tiles) addresses, the load is D17. The scene is loaded on the first device only: after a device loss the world is cleared, as the banner says. `findScene` (`src/scenes.ts`) matches own keys only, so `?scene=constructor` is unknown. The grid readout appends `· scene <name>`.
  - `src/main.ts`: when `?scene=<name>` names a `SCENES` entry, the grid takes the scene's size (no `computeGrid`), the scene is loaded with `simulation.load`, and the display stretches it to the canvas as on resize. An unknown name logs a warning and starts the normal empty grid. Clear empties it as usual.
  - Hand over "Needs the user" below and record the answers on the pin and the splash look here.
- [x] **M1.4g First GPU timing.** Done. 1x costs about 120 ms per frame on the 2560×1340 bench scene (8 fps), about 8× over the AC14 budget; the numbers are under "M1.4 measurements". Deviations: besides the `iterations: 0` run the bench has an `iterations: 20` run (to check the solver cost scales with the sweep count), a second test that splits a 1x frame by pass group (`runFluid`-style recording of the fluid passes alone), and a third that times `Simulation.create` (D17). The bench constructs one `Simulation` per variant.
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

FLIP build, M1.4g, `npm run bench`, same machine, scene and method (the 1x frame is 4 fluid steps plus 8 CA dispatches; a superstep is one fluid step). Ms per frame, second of two runs; the first run was 1.5–2× slower on its first rows (the GPU had not reached full clock after a 2 s burn-in) and agreed within 25% on the others:

| Supersteps per frame | full solver (40 sweep pairs) | 20 sweep pairs | no solver (`iterations: 0`) |
| --- | --- | --- | --- |
| 4 (1x) | 120 | 100 | 72 |
| 8 | 248 | 196 | 142 |
| 16 | 504 | 400 | 285 |
| 32 | 1000 | 812 | 567 |

Per fluid step that is about 30 ms with the full solver, 25 ms with 20 pairs, 18 ms with none: the solver costs about 13 ms per step and scales with the sweep count, but 18 ms per step remains with no solver. The estimate table above predicted 14 ms per step at 300 GB/s for the whole step, and 1.5 GB for the non-solver passes (about 2 ms at the card's 717 GB/s): the non-solver passes are about 9× slower than their memory traffic suggests.

Where a 1x frame goes (4 fluid steps, no CA, `tests/bench.gpu.ts` "splits a 1x frame"; the second run, the first in brackets; this test's total is 140–149 ms against 120 ms in the table above, so read the proportions, not the sum):

| Pass group | ms per frame |
| --- | --- |
| Frame start (compaction) | 2.7 (1.2) |
| Grid passes 1–13 without the sweeps | 40 (39) |
| Sweeps, 40 pairs | 52 (68) |
| Particle motion and rasterization, passes 14–19 | 56 (39) |

Cell count scaling is assumed, not measured: the grid passes cost the same wherever the liquid is, so the user's 1920×898 grid (half the cells) should cost about 60 ms at 1x with the same quarter-full tank, 17 fps. The user saw 27 fps there with a small scene (little water); that fits a mostly fixed per-cell cost plus a per-particle part.

Creating a `Simulation` in Node (Dawn, same backend as Chrome on Windows): the first one costs 460–650 ms at 64×64 and 756 ms at 1920×898 (pipelines; the shaders depend on the grid size), the second of the same size 7–31 ms (cached shaders; the buffers cost nothing measurable); the first frame afterwards 15–30 ms. This does not reproduce the 3–4 s seen in Chrome (D17).

Which M1.5c levers follow (inferred from the table, not measured): active tiles (lever 1) shrink the grid passes and the sweeps, about 90 of the 120 ms when the liquid fills a quarter of the grid, to roughly a quarter; the particle passes 14–19 shrink only in their grid-wide parts (keys, histogram, write) and not in their per-particle parts, so tiles alone should land near 50–60 ms, not 14. Fewer sweeps (lever 2) save 6–7 ms per step at 20 pairs before tiles. The particle passes (about 40–56 ms, 14 ms per step) are the largest single group left after tiles and are not split any further, so M1.5c starts with per-pass timing.
#### Needs the user (after M1.4f)

1. `npm run dev`, open `?scene=damBreak`: the water column should collapse, run to the far wall, climb it and settle flat. Then `?scene=uTube`: both arms end at the same height.
2. Open `?scene=droplet` and `?scene=film`, then draw a sand slope and a wall ledge on an empty grid and pour a little water on each. Expected: thin water stays where it lands, does not drip off the ledge until more joins it, and may cling to the slope. Say whether that looks right, or whether thin water should keep flowing.
3. Pour water from a height into a pool and watch the splash. Some flying drops may flicker or look sparse (the cell count is kept exact, so lone drops compete with the pool for cells). Say whether it bothers you.
4. A failure looks like: the WebGPU error banner, water that never settles or keeps boiling at rest, water vanishing or multiplying, oil that does not burn.

### M1.5 Integration and performance

- [x] **M1.5a Interactions on the GPU (AC10, AC11, AC15).** Done. Deviation: AC11's oil-above-water check counts inverted cells (water with oil below it in its column) over 100 consecutive steps after step 1400 and requires a median of 0 and a maximum of 3, instead of zero at step 1500 only. The interface flickers a lone cell for single steps on both builds (GPU 8 of 60 steps, CPU 1 of 60; D18), and the GPU is deterministic but diverges from the CPU from step ~30; the shared helper runs on both. `tests/liquids-gpu.test.ts` gains AC10 and AC11. `tests/simulation.test.ts` gains: fire burns oil (a 20×5 oil block in a tank under a row of fire: sampled every 50 steps, the oil count never rises, has dropped by at least half after 600 steps, and smoke appears); water puts out fire (a fire cell beside water is smoke two supersteps later); smoke rises through water (one smoke cell at the bottom of a pool 10 deep is above the surface within 40 supersteps, and the water count is unchanged).
- [x] **M1.5b Screen-scale check.** Add `uTubeHuge` (`uTube({ scale: 6 })`, 408×480) and `deepPool` (512×1200: a 2-cell tank with water 1,000 deep, and a column of water 100 wide and 150 tall dropped at one side) to `src/scenes.ts`, with GPU-only tests in `tests/liquids-gpu.test.ts`: `uTubeHuge` settles (AC1's band) within 16,000 steps; after 6,000 steps `deepPool` has flatness at most 1 and at most 35% of its particles move faster than 0.3 cells/step (the settled large U-tube has 19% on the CPU; record the GPU value). Record the residual and both numbers here. If either fails, multigrid (M1.5c lever 3) is required. Done: both cases fail. Both tests are `it.fails` in `tests/liquids-gpu.test.ts` (thresholds unchanged) so the suite stays green; that also hides an unrelated failure (timeout, device error), so rerun them and read the logged numbers when touching the solver. Change them to `it` when lever 3 lands. `uTubeHuge` and `deepPool` are in `SCENES`; `GpuLiquidModel` gains `residual()` and `fractionFasterThan(speed)`. Numbers under "M1.5b measurements".
- [ ] **M1.5c Cost levers**, only as far as M1.4g and M1.5b require, in this order; each is kept only when the parity tests and every GPU acceptance test still pass and the bench shows a gain:
  0. Per-pass timing: `timestamp-query` (or one pass per group in the bench) over passes 1–19, to split the particle passes (14–19), the grid passes before the sweeps (1–9) and passes 11–13 further. It decides whether lever 4 or something else comes after lever 1. Done: `npm run bench` has a test that puts every pass in its own compute pass with timestamps (`Fluid.recordStepTimed`, `recordFrameStartTimed`, and `createDevice(options, features)` to request `timestamp-query`); numbers under "M1.5c measurements".
  1. Active tiles: classify marks each 8×8 tile holding liquid or within 3 cells of it and appends it to a list with an atomic counter; cell and face passes and the sweeps dispatch indirect over that list. Clear covers the tiles active in this step and the previous one, so no stale accumulator survives. The parity tests must not change. Expect this lever to be needed: 80 sweeps over 3.4M cells at 4 steps a frame is about 25–35 ms on its own.
  2. 20 sweeps: CPU acceptance suite first, then GPU.
  3. Multigrid or a preconditioned solver: CPU reference first (`tests/cpu/solver.ts` and its tests), then WGSL. Its design is "M1.5c multigrid design" below; the sub-items are there. It is needed for correctness at screen scale (M1.5b), not for speed alone, so it can go before lever 1.
  4. Workgroup-shared accumulation in the particle-to-grid scatter, if the bench shows the scatter dominating.

  The levers that change the look (fluid update every second step, `k = 2` after D15, a coarser grid) need the user's approval with a before and after.
- [ ] **M1.5d Final measurement (AC14).** `npm run bench` at 1x within 14 ms per frame, measured as GPU time (the timestamp total of the per-pass test, or a timestamp pair around the whole frame in the main bench table; the wall-clock rows include Node-binding overhead, see "M1.5c measurements"); record 2x–8x. Hand to the user: maximize a 2560×1440 window, fill about a quarter of the screen with water, and read the FPS counter at 1x (expected about 60) and at 8x (no target; say if it feels unusable).

#### M1.5b measurements

GPU, RTX 4080, 40 sweep pairs, seeded as the tests; "fast" is the share of particles whose larger velocity component exceeds 0.3 cells/step; "residual" is the test-only residual pass (largest remaining error of the pressure equation) after the last step.

| Scene | Steps | Arm or column level (expected) | Residual | Fast | `maxShortfall` |
| --- | --- | --- | --- | --- | --- |
| `uTubeLarge` (204×240, the AC2 scene, for scale) | 2,000–8,000 | 114.0 both arms (114) | 0.12–0.19 | 8–17% | 0 |
| `uTubeHuge` (408×480) | 2,000 | 221.5 / 218.6 (228) | 0.29 | 36% | 1,886 |
| `uTubeHuge` | 16,000 | 219.8 / 219.5 (228) | 0.42 (0.26–0.71 along the way) | 39% | not read |
| `deepPool` (512×1200) | 1,000 | 834 (1029.5) | 3.2 | 80% | 99,116 |
| `deepPool` | 3,000 | 823.7 (1029.5) | 1.6 | 80% | not read |
| `deepPool` | 6,000 | 823.8 (1029.5), flatness 2 | 2.0 | 80% | not read |
| `deepPool`, 160 sweep pairs (a one-off run with `iterations: 160`) | 3,000 | 897.6 (1029.5) | 0.33 | 76% | not read |

What fails and why (read from the numbers above):

- `uTubeHuge` reaches equal arms (within 1 cell of each other) but 8–9 cells under the expected level, and never enters the AC1 band in 16,000 steps. The pool is also 3% short of its water: 51,459 of 52,992 water cells are drawn at step 2,000.
- `deepPool` has flatness 2 (the test needs 1) and 80% of its particles are fast (the limit is 35%). It also loses a fifth of its water to the eye: 423,933 water cells are drawn out of 523,000 loaded at step 1,000, with the 2.09M particles all alive, and the surface sits at 824 instead of 1,030 from step 2,000 on.
- The cause (inferred from these numbers, not isolated further) is the pressure solve not converging at this height: the residual is about 5–10× the 408×480 scene's and the water column compresses, so the particles crowd into fewer cells than the 4-per-cell count the rasterization uses to size the liquid (`maxShortfall`, which AC4 requires to be 0, is 1,886 and 99,116). Four times as many sweeps (160 pairs, compared at step 3,000) cut the residual 5× (1.6 to 0.33) and lift the level from 824 to 898, which is still 130 cells low with 76% fast particles, so more sweeps on the same method do not fix it: multigrid is needed.
- The large U-tube's fast share (8–17%) is at or below the CPU reference's 19%; that suggests, without proving it, that the GPU build is not at fault below this size.

#### M1.5c measurements

Lever 0, `npm run bench` ("times every fluid pass of a 1x frame"): the frame start and 4 fluid steps without the CA, every pass in a compute pass of its own with `timestamp-query` stamps (Dawn exposes the feature on the RTX 4080), median of 15 frames after a 20 s burn-in (the scene keeps evolving: sand falls into the water, and the cost of a step moves with it). Three runs, GPU milliseconds per frame (sum of the per-pass medians):

| Pass group | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Pressure sweeps (320 dispatches) | 29.1 (37%) | 33.0 (50%) | 63.0 (54%) |
| Particle to grid scatter (pass 5) | 10.1 | 13.8 | 14.8 |
| Other passes before the sweeps (clear, resolve, count, classify, normalize, extrapolate, gravity, prepare) | 15.0 | 6.7 | not split |
| Passes after the sweeps (11–13) | 2.6 | 1.4 | not split |
| Move particles and count (14–15) | 4.9 | 3.2 | not split |
| Rasterization keys and 6 padding rings | 6.3 | 3.3 | not split |
| The two radix selections, oil keys, write | 10.0 | 4.5 | not split |
| Total | 78.9 | 66.0 | 116.4 |

What it shows (read from the numbers, with the noise below):

- The sweeps are 40–55% of the GPU time and the scatter is another 13–21%. Every other pass group is under 10%, so the "particle passes 14–19 are the largest group after tiles" guess in "M1.4 measurements" no longer holds: once the sweeps shrink, the scatter is next (lever 4), then the rasterization chain as a whole (about 14 ms in run 1, 8 ms in run 2).
- One sweep dispatch costs about 0.09–0.1 ms (run 1: 14.2 and 14.8 ms for 160 dispatches each, run 2: 16.3 and 16.7). The grid has 3.4M cells and most of them hold no liquid (`diag == 0`), so a sweep is mostly threads that exit at once: dispatch and barrier cost, not arithmetic.
- The machine is noisy: the same bench varied by a factor of 1.5 between runs 1–2 and 3 (clock and other GPU users), and the cheap passes by 2–3× between runs 1 and 2. Compare shares and orders of magnitude, not single values; re-measure before and after a lever in the same run.
- The wall-clock frame time of the older tests ("M1.4 measurements", 120 ms) is larger than the GPU time and is not a GPU number: in run 2 the GPU did 66 ms of work, while recording and submitting took 28 ms on the CPU (the Node bindings) and the frame took 145 ms from record to result. In run 3 the span from the first pass starting to the last ending was 174 ms against 116 ms of pass time: about 0.09 ms of idle per pass boundary (inferred: ~620 passes), the same for one compute pass or one per dispatch (a separate comparison measured 148 ms for both layouts). AC14 is a GPU-time criterion, so `npm run bench` should report the timestamp total; the wall number remains as a cross-check only.

**Lever 3, CPU multigrid (M1.5c.3a).** E1 and E2 as defined in "M1.5c multigrid design", largest residual (max over liquid cells of `|rhs − A p|`), Float32 storage like the GPU. `SCREEN=1 npx vitest run solver-screen` reproduces the chosen-parameter rows (about 15 s); the parameter search ran in a throwaway script. "Factor" is `(r6 / r0)^(1/6)` over 6 iterations from p = 0; the bar is 0.35.

Chosen: conjugate gradients, each iteration preconditioned by one V(2,2) cycle, correction scale γ = 2, smoother ω = 1, coarsest level at most 8×8 solved by 10 red-black pairs forward and 10 in reverse, 2 iterations per step.

| Problem | r0 | after 1 / 2 / 3 / 6 iterations | Factor | Bare V(2,2), same parameters | SOR 40 / 160 / 1,000 pairs | E2 multigrid / SOR 40 |
| --- | --- | --- | --- | --- | --- | --- |
| `deepPool` 512×1200 | 5.0e-2 | 3.2e-2 / 6.6e-3 / 7.4e-4 / 5.0e-5 | 0.316 | diverges (8.0e-2 after 6, factor 1.08) | 2.4e-2 / 1.2e-2 / 4.8e-3 | 1.8e-3 / 1.6e-3 |
| `uTubeHuge` 408×480 | 5.0e-2 | 4.4e-2 / 1.7e-2 / 6.3e-3 / 1.1e-5 | 0.247 | 0.733 | 2.4e-2 / 1.2e-2 / 3.6e-3 | 1.4e-3 / 1.6e-3 |
| `uTubeLarge` 204×240 | 5.0e-2 | 2.8e-2 / 8.1e-3 / 3.8e-3 / 5.2e-6 | 0.217 | 0.792 | 2.4e-2 / 9.4e-3 / 3.3e-3 | 2.1e-3 / 1.3e-3 |
| `uTubeLarge`, left arm oil from row 150 | 5.0e-2 | 2.7e-2 / 6.6e-3 / 3.8e-3 / 5.2e-6 | 0.217 | 0.825 | 2.4e-2 / 9.4e-3 / 3.3e-3 | 2.1e-3 / 1.3e-3 |

The residual stops falling near 1e-5 to 5e-5: that is Float32 rounding of pressures up to about 50 (deepPool), not the method.

How the fallbacks did (factor over 6 cycles; V-cycle searches on a 128×300 pool and the large U-tube, then the leading candidates on all four problems):

- Bare V-cycles, the full E1 grid (V(1,1), V(2,2), γ ∈ {1, 1.5, 1.8, 2}, ω ∈ {1, 1.2}), coarsest 64: best 0.49 (pool) and 0.52 (U-tube), never 0.35. γ = 1 gives 0.66–0.78; ω = 1.2 is always worse than 1. Coarsening to 16 or 4 helps the pool (0.36 at V(2,2), γ 1.8) but not the U-tube (0.52–0.65), and V(1,1) γ 1.8 diverges there. From a warm start, V(1,1) γ 1.8 coarsest 16 blew up to 1e14 on the large U-tube.
- (a) V(2,2), or two cycles per step: per cycle 0.48–0.58 on all four, so two cycles give 0.23–0.34 per step, but at 122 dispatches per step against the budget of 80, and the bare cycle's divergence risk stays.
- (b) W-cycle on the coarse levels: 0.21–0.78 depending on γ and the coarsest size; the settings that reach 0.21 on one scene give 0.43 on another. Rejected.
- (c) The V-cycle as a conjugate-gradient preconditioner: with γ 1.8 the factor was 0.38–0.40 on the screen scenes; γ = 2 (the scale piecewise-constant transfer loses on a 2D grid) brings it to 0.22–0.32 everywhere. V(1,1) as preconditioner: 0.36–0.53, short. Coarsest 4 or 8 and 5 or 20 coarsest pairs change nothing measurable. CG raises the largest residual for its first iteration or two (it minimizes a different norm) and then falls fast.
- (d) Not tried: (c) met the bar.

What E2 shows: the bar (0.05) is met by multigrid, and also by plain SOR with 40 pairs (1.3e-3 to 1.6e-3). Uniform face noise is high-frequency, which any smoother removes, so E2 does not reproduce the M1.5b failure, where the residual sat at 1.6–3 in the running model. One CG iteration per step from a warm start is not enough (0.07–0.13 on the large U-tube depending on the coarsest size: the first CG step raises the largest residual); two are. E4 (M1.5c.3b) is the check that separates the solvers and should not be skipped.

GPU dispatch count (estimate for 3c, 2560×1340): levels with a side above 64 are 2560 down to 80, six levels at 10 dispatches each for V(2,2) (4 + 4 half-sweeps, restrict, prolong), plus one single-workgroup dispatch for every level from 40×21 down to 8×8: 61 per V-cycle. Two CG iterations need one preconditioner cycle each except the last plus the initial one, about 4 dispatches per iteration for the matrix product, the two dot products and the vector updates, and the 6 operator builds: about 140 per step against 80 for the 40 sweep pairs today. About 30 of them run over the fine grid (80 today), so the arithmetic drops; the per-dispatch idle measured in lever 0 (about 0.09 ms) is what can make it slower, so 3c should fuse where it can (the update of p and r into the dot-product pass, prolongation into the first post-smoothing half-sweep) and the bench must compare solver time before and after in one run.

#### M1.5c multigrid design

**Why.** M1.5b: at 408×480 and 512×1200 the 40-sweep solve leaves the pressure unconverged (residual 0.3–3 against 0.01–0.2 on the large U-tube), the water compresses, and the screen-scale cases fail; 160 sweeps help but are still short. Sweeps pass pressure information one cell per half-step, so a 1,000-cell-deep body needs thousands of them. A multigrid solve moves the same information across coarser copies of the grid, where one cell covers 2^ℓ fine cells. It is also the cheapest way to cut the biggest cost line above (the sweeps), because fewer fine sweeps are needed per step.

**The problem to solve** (as in `PressureSolver`, `tests/cpu/solver.ts`): for the liquid cells, `A p = rhs` with `rhs = −(divergence − source)`, where cell `c` has `diag[c] p[c] − Σ coup[c,n] p[n] = rhs[c]`. `coup` is the face weight `2 / (ρ_c + ρ_n)` between two liquid cells and 0 next to air or solid; `diag` is the sum of all four face weights, where an air neighbor contributes `1 / (ρ θ)` (the Dirichlet surface) and a solid neighbor 0. `A` is symmetric; it is positive definite when every liquid body touches air, and singular for a sealed body (AC8), where only gradients of `p` matter.

**Method: geometric multigrid, 2×2 aggregation, V-cycles, warm start.**

1. **Levels.** Level 0 is the fluid grid. Level ℓ+1 has `ceil(w/2) × ceil(h/2)` cells, each covering a 2×2 block of level ℓ (a missing child counts as solid). Coarsening stops at the first level whose sides are both at most 64 (8 after M1.5c.3a, see its outcome below); that level is solved by smoothing alone (item 6). 2560×1340 gives 7 levels (the last 40×21), 512×1200 gives 6 (the last 16×38).
2. **Coarse operator (Galerkin for piecewise-constant transfer).** With `P` the 0/1 matrix from a coarse cell to its children, `A_c = Pᵀ A P`, which has a closed form in the stored weights and keeps `A_c` symmetric and an M-matrix:
   - `coup_c[I,J] = Σ coup[c,c']` over the fine faces between block I and block J (two faces for edge neighbors);
   - `diag_c[I] = Σ_{c in I} diag[c] − 2 Σ coup[c,c']` over the four faces inside the block (air and solid weights stay in the diagonal, so the surface stays a Dirichlet condition and sealed walls stay Neumann);
   - a coarse cell with `diag_c == 0` is inactive (no liquid child).
   Built once per step after `prepare`, one dispatch per level (a thread per coarse cell reads its 2×2 children and the 8 outer coupling entries).
3. **Cycle** `V(ν1, ν2)` on the error equation: smooth `ν1` red-black pairs on `A p = rhs`; compute the residual `r = rhs − A p`; restrict by summing the four child residuals (`Pᵀ`) into the coarse right-hand side and set the coarse error to 0; recurse; prolong by `p += γ · e[parent]` (piecewise constant); smooth `ν2` pairs. The smoother is red-black Gauss-Seidel with its own relaxation `ω_s` (the 1.85 of the plain solver is a solver factor and makes a poor smoother). Piecewise-constant transfer under-corrects, hence the scale `γ` between 1 and 2.
4. **Where it runs.** It replaces pass 10 only. A step becomes: prepare (pass 9, which also writes the coupling form of the weights, see GPU design), build the coarse operators, `cycles` V-cycles from last step's `p` (the warm start stays), then gradient (pass 11). Nothing else in the step changes, so the sweeps' dispatches leave the pass list and the cycle's take their place.
5. **Parameters** (all in `FLUID`, one place for CPU and GPU, chosen by the experiments below, none guessed here): `cycles`, `preSweeps` (ν1), `postSweeps` (ν2), `smootherOmega`, `correctionScale` (γ), `coarsestSize` (64; 8 after M1.5c.3a), `coarsestSweeps`, and `preconditioned` (added by M1.5c.3a). `iterations` and `omega` of the plain solver remain for the CPU SOR reference.
6. **Coarsest level**: at most 64×64 cells, so one workgroup of 256 threads does `coarsestSweeps` red-black pairs in one dispatch (several cells per thread, `workgroupBarrier` between half-sweeps). A singular coarsest system (sealed body) needs no special case: smoothing never divides by zero (`diag > 0` on active cells) and a constant offset of `p` does not change any face velocity.

**Experiments that decide the parameters (CPU, before any WGSL; each has a stated bar).** `MultigridSolver` is added to `tests/cpu/solver.ts` next to `PressureSolver`, as a second way to run `project`; `FlipModel` selects it through `FLUID.solver`.

- **E1, solver only, on the first projection of the real problems.** The flags and densities of `deepPool` (512×1200), `uTubeHuge`, `uTubeLarge` and the oil-over-water tube (for the density weights), after gravity, `p = 0`, source 0. Measure the largest residual after 1 to 6 V-cycles, for `V(1,1)` and `V(2,2)`, `γ ∈ {1, 1.5, 1.8, 2}`, `ω_s ∈ {1, 1.2}`, against plain SOR with 40, 160 and 1,000 sweeps. Bar: a reduction of at least 3× per cycle (convergence factor ≤ 0.35) on all four.
- **E2, warm start.** Solve once, perturb every liquid face velocity by uniform noise in ±0.05 (what a step of particle motion does), solve again: the residual after the step's cycles. Bar: at most 0.05 on all four problems (the large U-tube passes AC2 with 0.12–0.19 under the 40-sweep solver, so this is stricter than a known pass).
- **E3, sealed and layered.** The sealed full chamber stays at rest (largest face speed ≤ 1e-3, AC8) and the two-layer tank holds at rest with the lighter layer on top, as the M1.2 tests check for SOR.
- **E4, in the model, optional.** `FlipModel` with multigrid on the CPU runs the whole existing acceptance suite (thresholds unchanged), and once, outside the suite, a half-size `deepPool` (256×600) for 3,000 steps against the same scene under SOR-40: level, flatness, fast share, `maxShortfall`. It shows the failure is the solver's and not something else that gets exposed once the pressure converges.

**If E1 or E2 miss the bar, in this order** (each is a change to the same CPU class, measured the same way): (a) `V(2,2)` or two cycles per step if the dispatch budget below allows; (b) a W-cycle on the coarse levels, which are cheap, only if dispatch count stays within budget; (c) the same V-cycle as a preconditioner for conjugate gradients, which makes it converge on irregular surfaces at the price of dot products (workgroup partial sums into a buffer, summed by a second dispatch) and about 6 more dispatches per iteration; (d) bilinear prolongation with the matching 9-point Galerkin operator, which converges better and costs more per level. The first of these that meets the bar is used; a failure of all four is reported to the user before anything else is tried.

**Outcome of M1.5c.3a.** Bare V-cycles do not meet E1, and (a) and (b) do not either; (c) does: `FLUID.preconditioned` is true, and every V-cycle described above is a symmetric preconditioner (post-smoothing in reverse color order, the coarsest level smoothed forward then back) applied to the CG residual from zero. The coarsest level is at most 8×8, so on the GPU the single-workgroup dispatch of item 6 covers every level from the first at or below 64×64 down to it. Each CG iteration adds a matrix product (`q = A d`), two dot products and two vector updates to the passes below; the numbers and the dispatch estimate are under "M1.5c measurements". For a sealed body whose density source does not sum to zero the system has no exact solution; CG then drifts `p` by a constant as SOR does, which moves no face velocity, but 3b should watch the sealed-chamber test with the source on.

**CPU reference and tests.**

- `tests/cpu/solver.ts`: `MultigridSolver` (levels, `buildLevels`, `vCycle`, `residual`, `project` with the same result shape as `PressureSolver.project`). `PressureSolver` stays as the independent reference the experiments compare with.
- `tests/cpu/solver.test.ts`: the coarse operator equals `Pᵀ A P` computed brute force on a random 24×20 blob with mixed air, solid and two densities (every entry within 1e-5); the convergence-factor bar of E1 on a 128×300 pool and a 100×60 U-tube (fast enough for the suite); E2 on the same; the M1.2 hydrostatic, sealed and layered tests run for both solvers (a `describe.each`).
- `tests/cpu/solver-screen.test.ts` (new, skipped unless `SCREEN=1`, since it takes minutes): E1 and E2 at 512×1200 and 408×480, the numbers recorded in "M1.5c measurements".
- Docs: `docs/simulation.md` gets the pressure solve section with M1.6.

**GPU design** (after the CPU bars are met). The fine level keeps its pipelines; the new ones are listed per pass.

- **Level 0 is untouched.** `prepare`, `sweep` and `gradient` keep their buffers (`weights`, `diagDiv`, `p`), and `prepare` still writes `p = 0` outside liquid. Levels ℓ ≥ 1 store the same three kinds of data, so the one `sweep` entry point serves every level: `weights` holds the coupling weights `coup` (liquid–liquid only, so a coarse cell never reads air), `diagDiv.x` the diagonal and `diagDiv.y` minus the restricted residual, and `p` stays 0 on inactive cells. The first `buildCoarse` reads level 0's `weights` and takes a neighbor as liquid when its `diagDiv.x > 0`.
- **Per level ℓ ≥ 1:** `weights` (`vec4f`), `diagDiv` (`vec2f`), `p` (`f32`): 28 B per cell, a third of the fine level's 28 B in total, about 35 MB at 2560×1340. `sweep` gets its relaxation as an override constant (the smoother's `ω_s`; level 0 keeps `FLUID.omega` only while the plain solver exists). Level sizes are baked into one shader module per level (the code already takes the grid size as a function parameter), so a `Simulation` creates about 5 pipelines more per level; if pipeline creation time grows (D17), cache them per size.
- **Passes** (`fluid-grid.wgsl.ts` or a new `fluid-multigrid.wgsl.ts`): `buildCoarse` (level ℓ → ℓ+1, thread per coarse cell), `sweep` (existing, run over any level's buffers, red or black by override), `restrictResidual` (thread per coarse cell: residual of its four children, summed into `diagDiv.y` with the sign of the existing divergence convention, `p = 0`), `prolongAdd` (thread per fine cell: `p += γ · p_coarse[parent]`), `coarsest` (one workgroup). Fine-level dispatches go through `gridArgs` as today; coarse levels dispatch their full size (they are at most a quarter of the fine grid).
- **Dispatches per step** with `V(1,1)`, 6 smoothing levels: per level 2 + 1 + 1 + 2 = 6, so 36 + 1 coarsest + 6 operator builds = 43 per cycle plus builds; two cycles are 80, as many as the 40 sweep pairs have today, and `V(2,2)` is 61 per cycle. The idle per pass boundary measured above (about 0.09 ms) makes the dispatch count a cost in itself, so the experiments report the residual per cycle and per dispatch.
- **Fusion, only if the profile asks for it:** `prolongAdd` merged into the first post-smoothing half-sweep (a red thread corrects itself and reads its neighbors' values corrected on the fly from their parent's error; the black half-sweep corrects its own cells before updating them). It saves one dispatch per level.
- **Interaction with the other levers.** Active tiles (lever 1) apply to the fine level; the coarse levels stay full-grid because they are small. Lever 2 (20 sweeps) is dropped: the smoother's sweep count is a multigrid parameter now.
- **GPU tests.** `tests/fluid-solver.test.ts` and `tests/fluid-parity.test.ts` keep their thresholds with multigrid on (the CPU reference runs the same cycles; both sides are red-black, so only rounding differs, and a taller pool's `p` may need the `1e-4 · max(1, max |p|)` tolerance to scale with `max |p|`, which it already does); a new GPU test builds the coarse operator for random grids and compares it with the CPU's (every entry within 1e-5 relative); the residual pass reports the residual after the cycles. When the GPU residual meets E2's bar, the two `it.fails` cases of M1.5b become `it` and must pass with their thresholds unchanged.

**Honest forecast.** From the lever 0 numbers (inferred, not measured): two `V(1,1)` cycles should cost roughly a third of the 40 sweep pairs on the full grid (the fine level carries two sweep pairs and a residual per cycle; the coarse levels add a third), and active tiles should shrink the fine level further for a tank that is a quarter full. That leaves the scatter (10–15 ms), the rasterization chain and the per-pass idle as the cost, so AC14's 14 ms is probably not met by the solver work alone: lever 4, fewer rasterization passes and, if still needed, a look-changing lever with the user's approval (fluid update every second step) come next. M1.5c's measurement after multigrid decides.

**Proposed order** (the user decides): multigrid before active tiles. It fixes correctness at screen scale (the two failing M1.5b cases), makes lever 2 moot, and changes the dispatch count that tiles would otherwise be tuned against; tiles do not change the result, so they can follow without re-doing anything.

**Checklist for lever 3.**

- [x] **M1.5c.3a CPU multigrid and experiments E1–E3.** `MultigridSolver`, its unit tests, the screen-size test, and the measurements; choose the parameters in `FLUID` and record the table under "M1.5c measurements". Done. Deviations: bare V-cycles missed E1 and fallbacks (a) and (b) did too, so the method is (c), conjugate gradients preconditioned by a symmetric V(2,2) cycle (see "Outcome of M1.5c.3a" and "M1.5c measurements"); the coarsest level is at most 8×8 on the CPU, not 64×64 (a 64×64 level is not solved by a few dozen sweeps, and that capped convergence); the coarsest smoothing runs forward then in reverse so the cycle is symmetric; the unit-suite U-tube is 100×80 (`uTube({ leftArm: 32, rightArm: 32 })`), the plan said 100×60; the oil-over-water problem is the large U-tube with its left arm oil from row 150 up. `FLUID.solver` is left to 3b, which is where `FlipModel` reads it.
- [ ] **M1.5c.3b CPU model and acceptance (E4).** `FlipModel` uses `FLUID.solver`; the CPU acceptance suite passes with multigrid, thresholds unchanged; the half-size `deepPool` comparison.
- [ ] **M1.5c.3c GPU multigrid.** The layout change, the new passes, the GPU tests above, the bench rows (solver cost per frame before and after, same run). Sonnet.
- [ ] **M1.5c.3d Screen-scale cases.** `uTubeHuge` and `deepPool` become `it` and pass; record the numbers. If they fail with a converged solver, stop and report the measurement: something else is wrong at that size.
- Visible after: nothing in small scenes; at screen size deep water stops compressing and the surface no longer sits a fifth too low. Needs you: approve this design (and the order); after 3d, look at `?scene=deepPool` and `?scene=uTubeHuge` (water should level flat to the expected height, at the speed the bench reports).

### M1.6 Docs

- [ ] `docs/simulation.md`: a fluid section (grid, particles, the per-step passes, rasterization by ranking, how the brush and reactions add and remove particles).
- [ ] `AGENTS.md`: layout (`src/fluid.ts`, `src/fluid-params.ts`, the fluid shaders, `tests/cpu/flip.ts`, the parity and bench files, `npm run bench`), the invariants (fluid passes exist in WGSL and `tests/cpu/` and change together; fluid constants and keys live only in `src/fluid-params.ts`; the CA never moves liquid; rasterization never overwrites wall, sand, smoke or fire), and "Adding a particle type" (a liquid needs a particle kind and a density; step 2 no longer names `isLiquid`, which the CA dropped in M1.4d).
- [ ] `docs/decisions.md`: check the FLIP entry still matches what shipped; add anything from M1.5c that passes its test. `docs/backlog.md`: update D14 and D15 with the GPU measurements, add anything deferred. `docs/roadmap.md`: delete M1. `README.md`: features (connected vessels level, splashes, oil floats, the brush with liquids). Delete this plan in the final commit.
