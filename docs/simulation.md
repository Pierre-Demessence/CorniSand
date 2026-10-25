# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/shaders/cell.wgsl.ts`, `src/shaders/solid-ca.wgsl.ts`, `src/shaders/brush.wgsl.ts`, and for liquids `src/fluid.ts` and the fluid shaders.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. All of it is recorded into one command encoder and sent with one `submit()` (`main.ts`). A frame is:

1. **Frame start** (`Fluid.recordFrameStart`): while a mouse button is down, the brush pass, one thread per cell, in place on the current buffer (each thread touches only its own cell, so there is no second buffer and no swap), preceded by the particle kill and followed by the compaction of the liquid particles; the compaction runs every frame (see Liquids).
2. **Supersteps**: `stepsPerFrame` of them, each a fluid update (`Fluid.recordStep`, which edits the current cell buffer in place) followed by two CA dispatches with Margolus offset 0, then 1. Each CA dispatch reads one cell buffer and writes the other, then the buffers swap (on the CPU, while recording).
3. **Render** of the final buffer, with the brush ring.

Every CA dispatch needs its own `{ offset, seed }`. They live in 256-byte slots (`minUniformBufferOffsetAlignment`) of one uniform buffer sized for the 64 dispatches of a 32-superstep frame; one `writeBuffer` fills the used slots and each dispatch selects its slot with a dynamic offset. The grid size is a shader constant.

At most every 2 seconds, on frames where no mouse button is down, a separate compute pass counts non-empty, non-wall cells with an atomic counter and reads it back asynchronously for the toolbar. It has its own submit.

## Cell format

One `u32` per cell (`src/shaders/cell.wgsl.ts`):

- bits 0–7 `type`: particle type ID (0 empty, 1 sand, 2 wall, 3 water, 4 smoke, 5 oil, 6 fire).
- bits 8–15 `variant`: random 0–255 assigned at paint time. Currently not used by the display.
- bits 16–31 `lifetime`: fire only, starts at 200 and loses 4 per CA step.

Cells travel as whole words: swapping two cells swaps everything.

## Margolus neighborhood

Intuition: the grid is cut into 2×2 blocks, and each block is updated on its own, so two particles can never try to move into the same cell. On the next step the block grid shifts by one cell diagonally, so particles cross block borders over time.

Example with offset 0, the block whose bottom-left cell is (4, 6) holds (4, 6), (5, 6), (4, 7), (5, 7). With offset 1 the cell (4, 6) belongs instead to the block starting at (3, 5), as its top-right cell.

One thread handles one block: it reads the four cells, runs all rules and writes the four results. Block `b` has its bottom-left cell at `2·b − offset`, and there are `ceil((W + offset) / 2) × ceil((H + offset) / 2)` blocks, so at offset 1 (and at odd sizes) edge blocks stick out of the grid.

y = 0 is the bottom row; gravity points toward lower y.

A falling grain that starts in the top row of a block moves one cell per dispatch, two per superstep; smoke rising from a bottom row does the same.

## Randomness

`pcg()` is the PCG-RXS-M-XS 32-bit hash. A block's random word is `pcg(bx ^ pcg(by ^ seed))`, with `bx`, `by` the block indices and `seed` a `u32` from `crypto.getRandomValues`, drawn per dispatch. Later random choices in the same block chain `pcg()` on the previous word. A choice between two options uses the top bit.

## Rules inside a block

Phases run in order on the block's four cells (BL, BR, TL, TR), each phase seeing the previous phase's result:

0. **Smoke rises**: a bottom smoke cell swaps with the cell above if that is empty, water, oil or fire.
1. **Sand falls**: sand in the top row swaps with the cell below if `canDisplace` allows it. Density order: smoke < empty < oil < water < sand < wall, but the CA moves only sand through it: sand sinks through water, oil and smoke, and the displaced cell moves up. Water and oil never move in the CA; the fluid step writes them into the grid (see below), so the order between water and oil comes from the pressure solve, not from a swap.
2. **Sand slides**: sand blocked below moves to the opposite bottom corner if that cell is displaceable. Only sand slides diagonally. The two possible slides exclude each other, so no random choice is involved.
3. **Smoke spreads**: top-row smoke moves into the empty neighbor in a randomly picked direction (one try); bottom-row smoke does too when it cannot rise.
4. **Fire**: fire loses 4 lifetime per step and turns into smoke at 0; oil next to fire in the block becomes fire; fire next to water becomes smoke. Only cells that were fire before the ignition rule ran are put out, so oil that ignites beside water burns for a step and its particles are removed before the fire goes out. Fire has no movement rule; it only moves when smoke rises through it.

Liquids do not move in the CA: it reads water and oil cells as obstacles, sand sinks into them and smoke rises through them, but it never moves them sideways or down. They move in the fluid step that precedes each superstep's two CA dispatches (see Liquids).

## Liquids

Intuition: water and oil are not cells that follow local rules. They are clouds of small particles, four per liquid cell at rest, each with a position and a velocity. Every step the particles tell a velocity grid how fast the liquid moves around them, a pressure solve makes that velocity field respect the walls and the surface (a body of liquid cannot be squeezed, so a pressure spreads through all of it at once), and the corrected velocities go back to the particles, which move. The cell grid only shows the result: the most crowded cells become water or oil cells. Example: in a U-tube with one arm filled higher, the weight of the tall column raises the pressure at the bottom of the whole body, so the liquid in the other arm rises in the same step, not one cell at a time, and the arms settle at the same level.

The method is FLIP (the particles carry the velocity, the grid only corrects it), blended 0.8 FLIP to 0.2 PIC (`FLUID.flipRatio`) so noise dies out. Reasons and rejected alternatives are in `docs/decisions.md`. Code: `src/fluid.ts`, `src/fluid-params.ts`, `src/shaders/fluid-*.wgsl.ts`. `tests/cpu/` holds a TypeScript reference that runs the same passes; the GPU is tested against it.

### Data

- **Particles.** `Particle { px, py, vx, vy: f32, kind: u32 }`, 20 bytes, in two ping-pong buffers. `kind` is water, oil or dead (`PARTICLE_KIND`). Positions are in cell units, and a particle is in cell `floor(pos)`. Velocities are in cells per step, clamped to `FLUID.maxSpeed` (1) so nothing skips a cell. The capacity follows the device's buffer limits; `particleState` holds the live count, the append position of the brush and the per-kind totals.
- **Fluid grid.** One fluid cell per grid cell (`FLUID.k = 1`). The velocity is staggered (MAC layout): `u` lives on the vertical faces between horizontally adjacent cells, `v` on the horizontal faces, and each cell has a pressure `p` and a flag (air, liquid or solid). Every face sits between the two pressures that drive it. Wall and sand cells are solid (no flow through), air has pressure 0, and the surface lies `FLUID.theta` of the way from the last liquid cell to the first air cell.

### Frame start

Once per frame, before the first step, while a mouse button is down: the **kill** pass marks dead every particle inside the brush stroke when the brush erases, or replaces a non-wall cell. The cell **brush** then writes the painted cells, and for water and oil appends four particles per cell on the 2×2 lattice with zero velocity. A full store makes the brush skip liquid cells. **Compaction** (always) copies the live particles into the other buffer, in no particular order (nothing depends on it), and recounts water and oil.

### One fluid step

The passes in order (WGSL entry points in `fluid-particles`, `fluid-grid`, `fluid-multigrid` and `fluid-raster`):

1. **Clear and count.** `clearGrid`; `resolve` (an oil particle in a fire cell dies, and a particle that ended inside a wall or sand cell is lifted to the first free cell above it); `countParticles` (particles and oil particles per cell).
2. **Classify.** A cell with a particle is liquid, and its density is the mean of its particles' (oil weighs `FLUID.oilDensity`, 0.8). Solid cells come from the cell type. `tileFlags` and `tileCompact` build the active tile lists (see Active tiles).
3. **Particles to grid.** `particlesToGrid` adds each particle's velocity to the four nearest faces with bilinear weights, in fixed point (`FLUID.fixedScale`): WebGPU has no float atomics, and integer sums do not depend on the order of the particles. `normalizeFaces` divides by the weight.
4. **Extrapolate and gravity.** The velocity is extended two cells into the air so a surface can start to move. `applyGravity` keeps the unchanged velocity for the FLIP difference, adds `FLUID.gravity` (cells per step squared) and damps.
5. **Prepare.** The right-hand side of the pressure equation is the divergence of the velocity minus a density source (`FLUID.stiffness`, `FLUID.pull`) that pushes crowded cells apart and pulls gaps closed. The face weights are `2 / (density_a + density_b)`, so oil, being lighter, moves more easily.
6. **Pressure solve** (see Pressure solve).
7. **Gradient.** `gradient` subtracts the pressure gradient from the face velocities, which makes the flow incompressible. `pinFilms` (`FLUID.film`) stops a layer one cell deep that rests on a solid from flowing sideways. The velocity is extrapolated again.
8. **Grid to particles.** `gridToParticles`: a particle in a liquid cell takes `flipRatio` of the grid's velocity change on top of its own velocity (FLIP) and the rest of its velocity straight from the grid (PIC); a particle in air falls freely. The velocity is clamped, and the particle moves one axis at a time, blocked by wall and sand cells.
9. **Rasterize** (next section). The two CA dispatches follow.

### Rasterization by ranking

`wanted = floor((water + oil) / 4)` liquid cells are chosen after the particles moved, so the volume shown is exact whatever the spacing of the particles. A candidate is an empty, water or oil cell (never wall, sand, smoke or fire) that holds a particle. Its rank is `10 · own count + 5 · (left count + right count) + 3 if it is liquid now`, counts clamped to `FLUID.countClamp`, a side that is wall, sand or outside the grid counting as the cell's own count; equal ranks go to the lower index. Example: in a flat pool the surface row and the row below it hold the same counts, so the side terms and the bonus for already being liquid keep the pool's shape instead of letting it flicker.

When particles are packed into fewer cells than the volume needs, *padding rings* add empty cells next to the candidates, ring by ring (`FLUID.paddingRings`, nearer rings first). `maxShortfall`, the number of wanted cells that found no candidate at all, is 0 in every accepted scene.

The `wanted` best keys are found by a radix selection on the 32-bit keys, four rounds of a histogram over one byte (`histogramPass`) and a one-thread `pick`, so nothing is sorted. The same selection then decides which of the chosen cells are oil: `oilWanted = floor(oil / 4)` cells, the largest oil share first (`oilKeys`), ties to the higher index so oil ends on top. `writeCells` writes water and oil cells (variant 0, life 0), empties every other water and oil cell and leaves all other cells alone.

### Pressure solve

The pressure solve of a fluid step is conjugate gradients, each iteration preconditioned by one multigrid V-cycle (`FLUID.solver`; reasons in `docs/decisions.md`). The levels live in level-concatenated buffers (`FluidGridBuffers.weights`, `diagDiv`, offsets from `multigridLevels`). The step builds the coarse operators from the fine weights, runs two iterations from last step's pressure, and levels with both sides at most `FLUID.tailSize` are cycled by one workgroup in one dispatch. A cell without liquid has diagonal 0 and is skipped by every kernel.

### Active tiles

Most of the grid is usually empty, so the grid passes of the fluid step run over *active tiles* instead of the whole grid. A tile is 8×8 cells, one workgroup. `classify` (the one whole-grid pass) marks every tile that holds a particle or a water or oil cell; `tileFlags` dilates the marks by one tile in each direction, which gives the active set A of the step, and `tileCompact` lists A and the clear set C (A plus the tiles active in the previous step) in tile order, with indirect dispatch arguments (`FluidTileBuffers`). A particle moves at most one cell per step, extrapolation reaches two faces and a padding ring six cells, so the 3×3 tiles around liquid cover everything a step reads or writes near it. Passes that write "no liquid" state (the face and diagonal initialization, the keys) run over C, and the count and accumulator clear runs over the previous step's A, so a tile that leaves A is wiped once; outside C every buffer read near A already holds its empty value. The conjugate-gradient partial sums are indexed by tile id and zero for tiles outside A, so the sums add up in the same order as with every tile active; `new Simulation(…, { activeTiles: false })` makes every tile active, which the tests compare against bit for bit and the bench uses as its baseline. When the last particle dies, the whole-grid passes run for one more frame so the last clear set is wiped (`finalize` keeps `gridArgs` live while the previous step's clear set is not empty).

## Brush

Painting writes the selected type into empty cells within the brush radius of the segment from the previous frame's pointer position to the current one (or into any non-wall cell when Shift is held); erasing empties every cell in range. Painting water or oil also appends four particles per painted cell, and erasing or Shift-painting removes every particle inside the stroke, including stray ones over empty cells (see Liquids, Frame start). The pass runs once per frame before the CA steps, so no block ever sees a half-painted state. The radius is in cells, whatever the grid scale. The painted variant comes from the cell coordinates and a per-frame seed.

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall, and writes outside the grid are skipped. No rule moves a wall, so out-of-bounds walls never enter the grid. Without fire in the scene every type keeps its count; fire burns oil and ends as smoke.
