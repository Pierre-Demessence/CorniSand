# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/shaders/cell.wgsl.ts`, `src/shaders/ca.wgsl.ts`, `src/shaders/brush.wgsl.ts`.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. All of it is recorded into one command encoder and sent with one `submit()` (`main.ts`). A frame is:

1. **Brush**: while a mouse button is down, the brush pass, one thread per cell, in place on the current buffer (each thread touches only its own cell, so there is no second buffer and no swap).
2. **Supersteps**: `stepsPerFrame` of them, each two CA dispatches with Margolus offset 0, then 1. Each CA dispatch reads one cell buffer and writes the other, then the buffers swap (on the CPU, while recording).
3. **Render** of the final buffer, with the brush ring.

Every CA dispatch needs its own `{ offset, seed }`. They live in 256-byte slots (`minUniformBufferOffsetAlignment`) of one uniform buffer sized for the 64 dispatches of a 32-superstep frame; one `writeBuffer` fills the used slots and each dispatch selects its slot with a dynamic offset. The grid size is a shader constant.

At most every 2 seconds, on frames where no mouse button is down, a separate compute pass counts non-empty, non-wall cells with an atomic counter and reads it back asynchronously for the toolbar. It has its own submit.

## Cell format

One `u32` per cell (`src/shaders/cell.wgsl.ts`):

- bits 0–7 `type`: particle type ID (0 empty, 1 sand, 2 wall, 3 water, 4 smoke, 5 oil, 6 fire).
- bits 8–15 `variant`: random 0–255 assigned at paint time. Currently not used by the display.
- bits 16–31 `life`: for fire, the lifetime: starts at 200 and loses 4 per CA step. For water and oil, the sideways direction the cell last moved in (0 none, 1 left, 2 right).

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
1. **Falling cells fall**: sand, water and oil in the top row swap with the cell below if `canDisplace` allows it: the cell below is empty, smoke, or a lighter falling cell. Density order of the falling cells (`fallRank`): oil < water < sand, so sand sinks through water and oil, water through oil, and the displaced cell moves up. A cell never displaces one of its own density, and nothing displaces fire or a wall.
2. **Falling cells slide**: a sand, water or oil cell blocked below moves to the opposite bottom corner if `canDisplace` allows it. The two possible slides are checked in order, each on the block as the previous check left it.
3. **Smoke spreads**: top-row smoke moves into the empty neighbor in a randomly picked direction (one try); bottom-row smoke does too when it cannot rise. Only a cell that did not move earlier in the dispatch moves again (it still equals its value at the start of the dispatch).
4. **Liquids spread** (`spreadRow`, top row then bottom row): a water or oil cell that did not move earlier in the dispatch moves into the empty cell beside it in its row, if that is the direction it remembers (a cell without memory picks one at random). The memory is the cell's `life` field: a cell that moved keeps going in that direction on later dispatches, which makes a stream flow instead of diffuse. A cell facing anything but empty space turns around, and one that could move turns around one time in 64 instead. Two liquids side by side never swap, so a layered body stays layered.
5. **Fire**: fire loses 4 lifetime per step and turns into smoke at 0; oil next to fire in the block becomes fire; fire next to water becomes smoke. Only cells that were fire before the ignition rule ran are put out, so oil that ignites beside water burns for a step before the fire goes out. Fire has no movement rule; it only moves when smoke rises through it.

Intuition for the liquids: each cell looks only at its 2×2 block, so a liquid cannot feel the weight of the water above it or push water along a pipe. A pool flattens because surface cells slide off the high spots, and falls into every gap. Example: a 30×40 block of water against the left wall of a 200-wide tank spreads out to a sheet 6 to 7 cells deep in about 1,200 supersteps (`tests/simulation.test.ts`, "dam break"). Connected vessels do not level: in the `uTube` scene the filled arm stays full and the empty arm stays empty, as in The Powder Toy (`docs/decisions.md`).

## Brush

Painting writes the selected type into empty cells within the brush radius of the segment from the previous frame's pointer position to the current one (or into any non-wall cell when Shift is held); erasing empties every cell in range. The pass runs once per frame before the CA steps, so no block ever sees a half-painted state. The radius is in cells, whatever the grid scale. The painted variant comes from the cell coordinates and a per-frame seed.

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall, and writes outside the grid are skipped. No rule moves a wall, so out-of-bounds walls never enter the grid. Without fire in the scene every type keeps its count (every rule swaps cells); fire burns oil and ends as smoke.
