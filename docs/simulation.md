# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/shaders/cell.wgsl.ts`, `src/shaders/solid-ca.wgsl.ts`, `src/shaders/brush.wgsl.ts`.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. All of it is recorded into one command encoder and sent with one `submit()` (`main.ts`). A frame is:

1. **Brush pass**, only while a mouse button is down: one thread per cell, in place on the current buffer. Each thread touches only its own cell, so there is no second buffer and no swap.
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

Liquids move in the fluid step that precedes each superstep's two CA dispatches (`src/fluid.ts`): particles carry the water and oil, a pressure solve moves them, and the last pass writes them into the cell grid as water and oil cells. The CA reads those cells as obstacles, sand sinks into them and smoke rises through them, but it never moves them sideways or down.

## Brush

Painting writes the selected type into empty cells within the brush radius of the segment from the previous frame's pointer position to the current one (or into any non-wall cell when Shift is held); erasing empties every cell in range. The pass runs once per frame before the CA steps, so no block ever sees a half-painted state. The radius is in cells, whatever the grid scale. The painted variant comes from the cell coordinates and a per-frame seed.

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall, and writes outside the grid are skipped. No rule moves a wall, so out-of-bounds walls never enter the grid. Without fire in the scene every type keeps its count; fire burns oil and ends as smoke.
