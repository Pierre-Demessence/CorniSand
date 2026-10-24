# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/shaders/solid-ca.wgsl.ts`, `src/shaders/pressure.wgsl.ts`.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. A superstep is:

1. CA step with Margolus offset 0 (brush applied here on the first superstep of the frame).
2. CA step with Margolus offset 1.
3. Two pressure diffusion passes.

Every pass is a full-grid compute dispatch (8×8 workgroups, one thread per cell) that reads one cell buffer and writes the other, then swaps them. Each pass is its own command encoder and `submit()`. At "1x" that is 16 grid passes and 16 submits per frame; at "8x", 128.

At most every 2 seconds, on frames where no mouse button is down, a separate compute pass counts non-empty, non-wall cells with an atomic counter and reads it back asynchronously for the toolbar.

## Cell format

32 bytes per cell (`Cell` struct, see `AGENTS.md`):

- `pType`: particle type ID (0 empty, 1 sand, 2 wall, 3 water, 4 smoke, 5 oil, 6 fire).
- `variant`: random 0–255 assigned at paint time. Currently not used by the display.
- `lifetime`: fire only, starts at 200.
- `pressure`, `velocityX`, `velocityY`: fluid fields, see below.

Cells travel as whole structs: when two cells swap, their pressure and velocity go with them.

## Margolus neighborhood

Intuition: the grid is cut into 2×2 blocks, and each block is updated on its own, so two particles can never try to move into the same cell. On the next step the block grid shifts by one cell diagonally, so particles cross block borders over time.

Example with offset 0, the block whose bottom-left cell is (4, 6) holds (4, 6), (5, 6), (4, 7), (5, 7). With offset 1 the cell (4, 6) belongs instead to the block starting at (3, 5), as its top-right cell.

The four threads of a block each read all four cells, run the same rules on the same input (the random numbers are seeded per block), and each writes only its own cell. The block's rules therefore run four times, once per thread.

y = 0 is the bottom row; gravity points toward lower y.

## Rules inside a block

Phases run in order on the block's four cells (BL, BR, TL, TR), each phase seeing the previous phase's result:

0. **Smoke rises**: a bottom smoke cell swaps with the cell above if that is empty, water, oil or fire.
1. **Fall**: sand, water and oil in the top row swap with the cell below if `canDisplace` allows it. Density order: smoke < empty < oil < water < sand < wall, so sand sinks through liquids and water sinks through oil.
2. **Sand slides**: sand blocked below moves to the opposite bottom corner if that cell is displaceable. Only sand slides diagonally.
3. **Liquid spreads**: a bottom-row liquid that started the step as liquid moves into an empty cell beside it; a top-row liquid does the same if it cannot fall.
4. **Smoke spreads**: top-row smoke moves into an empty neighbor; bottom-row smoke does too when it cannot rise.
5. **Fire**: fire loses 4 lifetime per step and turns into smoke at 0; oil next to fire in the block becomes fire; fire next to water becomes smoke. Fire has no movement rule; it only moves when smoke rises through it.

Finally all velocities are multiplied by 0.95.

Painting writes the selected type into empty cells inside the brush (or any non-wall cell when Shift is held); erasing empties them. Painted cells skip the block rules for that step.

## Pressure and velocity

The CA writes pressure and velocity in a few places: sand falling into liquid adds pressure to the sand cell and vertical velocity to the liquid, water sinking through oil adds pressure, and every horizontal liquid move adds ±0.5 to `velocityX`. The pressure pass then averages pressure and velocity across neighboring liquid cells (Jacobi-style relaxation), decays them, and halves them in non-liquid cells.

No rule reads these fields in a way that changes movement. The only consumer is the flow-direction bias in phase 3, and in that phase the two candidate moves are mutually exclusive, so the bias never changes which move happens. A liquid that started the step as liquid and cannot fall always moves into an empty cell beside it in its block. Backlog B2 and B3 track this; `docs/research/realistic-water.md` covers where water should go next.

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall. Threads only exist for in-bounds cells, so nothing is ever written outside.
