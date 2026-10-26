# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/elements.ts`, `src/element-table.ts`, `src/cell-fields.ts`, `src/cell-field-buffers.ts`, `src/shaders/cell.wgsl.ts`, `src/shaders/elements.wgsl.ts`, `src/shaders/ca.wgsl.ts`, `src/shaders/brush.wgsl.ts`.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. All of it is recorded into one command encoder and sent with one `submit()` (`main.ts`). A frame is:

1. **Brush**: while a mouse button is down, the brush pass, one thread per cell (each thread touches only its own cell).
2. **Supersteps**: `stepsPerFrame` of them, each two CA dispatches with Margolus offset 0, then 1. The dispatches update the cell buffers in place.
3. **Render** of the cell buffers, with the brush ring.

Every CA dispatch needs its own `{ offset, seed }`. They live in 256-byte slots (`minUniformBufferOffsetAlignment`) of one uniform buffer sized for the 64 dispatches of a 32-superstep frame; one `writeBuffer` fills the used slots and each dispatch selects its slot with a dynamic offset. The grid size is a shader constant.

At most every 2 seconds, on frames where no mouse button is down, a separate compute pass counts non-empty, non-wall cells with an atomic counter and reads it back asynchronously for the toolbar. It has its own submit.

## Cell format

A cell is one 32-bit word in each of the field buffers listed in `CELL_FIELDS` (`src/cell-fields.ts`), one storage buffer per field (`src/cell-field-buffers.ts`):

- `kind`: bits 0–7 `type`, the element ID (a row of the element table below); bits 8–15 `variant`, random 0–255 assigned at paint time (not used by the display yet); bits 16–31 reserved.
- `life`: for an element with a lifetime (fire), the time left. For a liquid (water, oil), the sideways direction the cell last moved in (0 none, 1 left, 2 right).

The shaders see them as a `Cell` struct (`loadCell`, `storeCell`, `storeChanged`, `cellType`, `cellVariant`, `cellLife`, `makeCell`), generated from the field list with the bindings in `@group(1)`, binding = field index. A new field is one entry in `CELL_FIELDS`; `makeCell` starts it at 0.

Cells travel as whole structs: swapping two cells swaps every field.

Intuition for the layout: each field is its own array, like the columns of a table, so a pass can later skip the columns it does not need (today every pass binds all of them), and the device's buffer size limit applies to one column at a time. The CA updates the arrays in place instead of writing a second copy: a thread loads its block's four cells, runs the rules, and writes back only the fields that differ from what it loaded. This is safe because blocks do not overlap, so a rule must read and write only the four cells of its own block.

## Element table

Every material is a row of `ELEMENTS` (`src/elements.ts`):

| Element | ID | State | Density (kg/m³) | Other |
| --- | --- | --- | --- | --- |
| empty | 0 | empty | 1.2 (air) | |
| sand | 1 | powder | 1600 | |
| wall | 2 | solid | 2500 | |
| water | 3 | liquid | 1000 | |
| smoke | 4 | gas | 0.6 | |
| oil | 5 | liquid | 900 | flammable |
| fire | 6 | plasma | 0.3 | life 200, loses 4 per dispatch, becomes smoke; rule `fire`; graphics `fire` |

The states: *empty* is air; a *solid* never moves and nothing passes through it; *powders* and *liquids* fall, and liquids also spread sideways; *gases* rise; *plasma* (fire) stays where it is, but a gas rises through it. A row also holds a label, a color, an optional `rule`, an optional `graphics` function and an optional toolbar order.

The CA, the brush and the display read the table as a uniform array of 256 rows of 32 bytes (`@group(2)`; `ElementTable` fills it, `PROP_FIELDS` lists a row's words and generates both the WGSL struct and the packer). A uniform array indexed by the cell's type is one cached read, where a `const` array may be copied into every thread's memory. The element IDs and states are also generated as WGSL constants (`EL_SAND`, `ST_POWDER`), so no shader names a number. A test or a variant of the game gives `Simulation` another table (and extra rule sources) through its options.

Intuition: a new material only has to say what it is, powder or liquid or gas, and how heavy it is; the CA then knows it falls, piles up, sinks through lighter things and floats on heavier ones. Example: a powder row with density 1300 (mud) falls like sand, sinks through water (1000) and stays on top of sand (1600) with no other change (`tests/element-table.test.ts`).

## Margolus neighborhood

Intuition: the grid is cut into 2×2 blocks, and each block is updated on its own, so two particles can never try to move into the same cell. On the next step the block grid shifts by one cell diagonally, so particles cross block borders over time.

Example with offset 0, the block whose bottom-left cell is (4, 6) holds (4, 6), (5, 6), (4, 7), (5, 7). With offset 1 the cell (4, 6) belongs instead to the block starting at (3, 5), as its top-right cell.

One thread handles one block: it reads the four cells, runs all rules and writes back the changed fields. Block `b` has its bottom-left cell at `2·b − offset`, and there are `ceil((W + offset) / 2) × ceil((H + offset) / 2)` blocks, so at offset 1 (and at odd sizes) edge blocks stick out of the grid.

y = 0 is the bottom row; gravity points toward lower y.

A falling grain that starts in the top row of a block moves one cell per dispatch, two per superstep; smoke rising from a bottom row does the same.

## Randomness

`pcg()` is the PCG-RXS-M-XS 32-bit hash. A block's random word is `pcg(bx ^ pcg(by ^ seed))`, with `bx`, `by` the block indices and `seed` a `u32` from `crypto.getRandomValues`, drawn per dispatch. Later random choices in the same block chain `pcg()` on the previous word. A choice between two options uses the top bit.

## Rules inside a block

Phases run in order on the block's four cells (BL, BR, TL, TR), each phase seeing the previous phase's result. Movement depends only on the table's `state` and `density`:

0. **Gases rise**: a bottom gas cell swaps with the cell above if that is empty, plasma (fire), or a liquid heavier than the gas (smoke through water and oil).
1. **Falling cells fall**: powder and liquid cells in the top row swap with the cell below if `canDisplace` allows it: the cell below is empty, or a gas, powder or liquid lighter than the mover. So sand (1600) sinks through water (1000) and oil (900), water through oil, and the displaced cell moves up. A cell never displaces one of its own density, and nothing displaces a solid or fire.
2. **Falling cells slide**: a powder or liquid cell blocked below moves to the opposite bottom corner if `canDisplace` allows it. The two possible slides are checked in order, each on the block as the previous check left it.
3. **Gases spread**: a top-row gas cell moves into the empty neighbor in a randomly picked direction (one try); a bottom-row one does too when it cannot rise. Only a cell that did not move earlier in the dispatch moves again (it still equals its value at the start of the dispatch).
4. **Liquids spread** (`spreadRow`, top row then bottom row): a liquid cell that did not move earlier in the dispatch moves into the empty cell beside it in its row, if that is the direction it remembers (a cell without memory picks one at random). The memory is the cell's `life` field: a cell that moved keeps going in that direction on later dispatches, which makes a stream flow instead of diffuse. A cell facing anything but empty space turns around, and one that could move turns around one time in 64 instead. Two liquids side by side never swap, so a layered body stays layered.
5. **Lifetimes**: an element with a `life` row loses its `decay` per dispatch and becomes the element named by `becomes` when it runs out (fire becomes smoke at 0).
6. **Element rules**: for each cell, a generated `switch` on its element calls that element's rule, if the row has one; the rule sees the block and may change any of its cells. Fire's rule: fire next to water becomes smoke.
7. **Ignition**: a flammable cell (oil) with a fire cell in its block becomes fire, starting at fire's `life.start`. Which cells ignite is decided right after the lifetimes (phase 5), before the rules, and applied here, so a rule never sees a cell that ignites in the same dispatch: oil that ignites beside water burns for a step before its fire goes out, while the fire that lit it is put out at once.

Fire has no movement rule; it only moves when a gas rises through it.

Intuition for the liquids: each cell looks only at its 2×2 block, so a liquid cannot feel the weight of the water above it or push water along a pipe. A pool flattens because surface cells slide off the high spots, and falls into every gap. Example: a 30×40 block of water against the left wall of a 200-wide tank spreads out to a sheet 6 to 7 cells deep in about 1,200 supersteps (`tests/simulation.test.ts`, "dam break"). Connected vessels do not level: in the `uTube` scene the filled arm stays full and the empty arm stays empty, as in The Powder Toy (`docs/decisions.md`).

## Brush

Painting writes the selected element into empty cells within the brush radius of the segment from the previous frame's pointer position to the current one (or into any non-wall cell when Shift is held); erasing empties every cell in range. The pass runs once per frame before the CA steps, so no block ever sees a half-painted state. The radius is in cells, whatever the grid scale. The painted variant comes from the cell coordinates and a per-frame seed, and the painted life from the element's `life.start` (0 without one).

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall, and writes outside the grid are skipped. No rule moves a wall, so out-of-bounds walls never enter the grid. Without fire in the scene every type keeps its count (every rule swaps cells); fire burns oil and ends as smoke.
