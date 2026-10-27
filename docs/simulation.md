# Simulation

How a frame turns into particle movement. Code: `src/simulation.ts`, `src/elements.ts`, `src/element-table.ts`, `src/cell-fields.ts`, `src/cell-field-buffers.ts`, `src/shaders/cell.wgsl.ts`, `src/shaders/elements.wgsl.ts`, `src/shaders/ca.wgsl.ts`, `src/shaders/brush.wgsl.ts`, `src/movement.ts`, `src/flyers.ts`, `src/shaders/flyers.wgsl.ts`, `src/passes.ts`, `src/heat.ts`.

## Frame pipeline

Each animation frame runs `stepsPerFrame` supersteps (1, 2, 4, 8, 16, 24 or 32; the speed labelled "1x" is 4), then one render pass. All of it is recorded into one command encoder and sent with one `submit()` (`main.ts`). A frame is:

1. **Brush**: while a mouse button is down, the brush pass, one thread per cell (each thread touches only its own cell).
2. **Supersteps**: `stepsPerFrame` of them, each two CA dispatches with Margolus offset 0, then 1, then the flyer passes (see Flyers). The dispatches update the cell buffers in place. The brush, every CA dispatch and the flyer passes share one compute pass, handed out by `PassRecorder` (`src/passes.ts`); the bench gives each group of dispatches a timed pass of its own instead.
3. **Overlay and render**: the flyers are scattered into the overlay buffer, then the cell buffers and the overlay are drawn with the brush ring.

Every CA dispatch needs its own `{ offset, seed }`. They live in 256-byte slots (`minUniformBufferOffsetAlignment`) of one uniform buffer sized for the 64 dispatches of a 32-superstep frame; one `writeBuffer` fills the used slots and each dispatch selects its slot with a dynamic offset. The grid size is a shader constant.

At most every 2 seconds, on frames where no mouse button is down, a separate compute pass counts non-empty, non-wall cells with an atomic counter, adds the flyers in the air, and reads the total back asynchronously for the toolbar. It has its own submit.

## Cell format

A cell is one 32-bit word in each of the field buffers listed in `CELL_FIELDS` (`src/cell-fields.ts`), one storage buffer per field (`src/cell-field-buffers.ts`):

- `kind`: bits 0–7 `type`, the element ID (a row of the element table below); bits 8–15 `variant`, random 0–255 assigned at paint time (not used by the display yet); bits 16–31 reserved.
- `life`: for an element with a lifetime (fire), the time left. For a liquid (water, oil), the sideways direction the cell last moved in (0 none, 1 left, 2 right).

- `velocity`: the cell's velocity in cells per dispatch, x in the low 16 bits and y in the high 16 bits, each a binary16 float (`pack2x16float`). y = 0 is the bottom row, so a falling cell has a negative y.
- `remainder`: the part of the cell's movement it has not spent yet, packed the same way. A cell moves one cell inside its block when the remainder on an axis reaches 1, so a speed of 1/4 cell per dispatch is a move every four dispatches. Both words are 0 for anything that does not fall, and for a cell at rest.
- `temp`: the stored temperature in °C, an `f32` (the TypeScript side reads the words through `tempView`). It means nothing for a cell that holds no heat, empty space and walls: `makeCell`, the eraser and Clear leave it 0. A painted cell starts at its element's `temperature`, and so does every cell of a scene built by `src/scenes.ts` or loaded without a `temp` field (`Simulation.load`; a scene may set other temperatures, as `heatBars` does). Heat conduction (phase 7) changes it for the cells that hold heat; a cell carries it unchanged wherever it moves or flies.

The shaders see them as a `Cell` struct (`loadCell`, `storeCell`, `storeChanged`, `cellType`, `cellVariant`, `cellLife`, `cellVelocity`, `cellRemainder`, `cellStoredTemp`, `makeCell`, `withType`, `withLife`, `withMotion`, `withTemp`), generated from the field list with the bindings in `@group(1)`, binding = field index. A new field is one entry in `CELL_FIELDS`; `makeCell` starts it at 0, and the `with…` builders copy a cell and change only the named part. `storeChanged` compares an `f32` field by its bits, so a moved cell keeps its exact word (as floats, −0 equals 0).

Cells travel as whole structs: swapping two cells swaps every field.

Intuition for the layout: each field is its own array, like the columns of a table, so a pass can later skip the columns it does not need (today every pass binds all of them), and the device's buffer size limit applies to one column at a time. The CA updates the arrays in place instead of writing a second copy: a thread loads its block's four cells, runs the rules, and writes back only the fields that differ from what it loaded. This is safe because blocks do not overlap, so a rule must read and write only the four cells of its own block.

## Element table

Every material is a row of `ELEMENTS` (`src/elements.ts`):

| Element | ID | State | Density (kg/m³) | Other |
| --- | --- | --- | --- | --- |
| empty | 0 | empty | 1.2 (air) | |
| sand | 1 | powder | 1600 | gravity 1/32; conductivity 0.05, capacity 1.3 |
| wall | 2 | solid | 2500 | |
| water | 3 | liquid | 1000 | gravity 1/32; conductivity 0.3, capacity 4.2 |
| smoke | 4 | gas | 0.6 | conductivity 0.05, capacity 1 (placeholder, backlog I16) |
| oil | 5 | liquid | 900 | flammable, gravity 1/32; conductivity 0.1, capacity 1.7 |
| fire | 6 | plasma | 0.3 | life 200, loses 4 per dispatch, becomes smoke; rule `fire`; graphics `fire`; 1,000 °C; conductivity 0.5, capacity 1 |
| metal | 7 | solid | 7870 | holds heat: conductivity 1, capacity 3.5 |
| stone | 8 | solid | 2700 | holds heat: conductivity 0.1, capacity 2.2 |

The states: *empty* is air; a *solid* never moves and nothing passes through it; *powders* and *liquids* fall, and liquids also spread sideways; *gases* rise; *plasma* (fire) stays where it is, but a gas rises through it. A row also holds a label, a color, a `temperature` (°C, default 20: what a painted or loaded cell starts at), a `conductivity` (0 to 1, default 0) and a `heatCapacity` (above 0, default 1; see Heat), an optional `rule`, an optional `graphics` function and an optional toolbar order. A powder or liquid row has a `gravity` (cells per dispatch squared, default 1/32) and a `drag` (the share of its speed a flyer loses per dispatch, default 1/64); other states have no gravity.

An element *holds heat* when its conductivity is above 0 or it has a transition (`elementHoldsHeat`, the table's `holdsHeat` word): its cells' `temp` words mean something. Empty space and the wall hold none. WALL is the engine's invincible wall and the world's edge, not a real material: it never conducts, so heat never leaves the world; the real building materials are metal and stone. SMOKE's heat values are placeholders (backlog I16).

The CA, the brush and the display read the table as a uniform array of 256 rows of 80 bytes (a uniform array's stride is a multiple of 16) (`@group(2)`; `ElementTable` fills it, `PROP_FIELDS` lists a row's words and generates both the WGSL struct and the packer). A uniform array indexed by the cell's type is one cached read, where a `const` array may be copied into every thread's memory. The element IDs and states are also generated as WGSL constants (`EL_SAND`, `ST_POWDER`), so no shader names a number. A test or a variant of the game gives `Simulation` another table (and extra rule sources) through its options.

Intuition: a new material only has to say what it is, powder or liquid or gas, and how heavy it is; the CA then knows it falls, piles up, sinks through lighter things and floats on heavier ones. Example: a powder row with density 1300 (mud) falls like sand, sinks through water (1000) and stays on top of sand (1600) with no other change (`tests/element-table.test.ts`).

## Margolus neighborhood

Intuition: the grid is cut into 2×2 blocks, and each block is updated on its own, so two particles can never try to move into the same cell. On the next step the block grid shifts by one cell diagonally, so particles cross block borders over time.

Example with offset 0, the block whose bottom-left cell is (4, 6) holds (4, 6), (5, 6), (4, 7), (5, 7). With offset 1 the cell (4, 6) belongs instead to the block starting at (3, 5), as its top-right cell.

One thread handles one block: it reads the four cells, runs all rules and writes back the changed fields. Block `b` has its bottom-left cell at `2·b − offset`, and there are `ceil((W + offset) / 2) × ceil((H + offset) / 2)` blocks, so at offset 1 (and at odd sizes) edge blocks stick out of the grid.

A block whose four cells are all inert (empty or solid, with no lifetime, no rule and no heat: `elementInert`, the table's `inert` word) cannot change in any phase, so the thread reads only their `kind` words and stops. Most of a screen is empty space or walls, so most threads stop there. A thread keeps its block in four separate variables, not in an array: on the RTX 4080 an array indexed by a slot computed at run time sits in slow per-thread memory instead of registers, which made the CA about three times slower.

y = 0 is the bottom row; gravity points toward lower y.

Smoke rising from a bottom row moves one cell per dispatch, two per superstep. Falling cells start slower and speed up (see phase 1).

## Randomness

`pcg()` is the PCG-RXS-M-XS 32-bit hash. A block's random word is `pcg(bx ^ pcg(by ^ seed))`, with `bx`, `by` the block indices and `seed` a `u32` from `crypto.getRandomValues`, drawn per dispatch. Later random choices in the same block chain `pcg()` on the previous word. A choice between two options uses the top bit.

## Rules inside a block

Phases run in order on the block's four cells (BL, BR, TL, TR), each phase seeing the previous phase's result. Movement depends on the table's `state` and `density`, and for powders and liquids on the cell's velocity:

0. **Gases rise**: a bottom gas cell swaps with the cell above if that is empty, plasma (fire), or a liquid heavier than the gas (smoke through water and oil).
1. **Falling cells move by velocity** (`velocityRule`, the bottom row first, the column order random): a powder or liquid cell adds its element's `gravity` to its vertical speed when it is in the top row or already moving (a cell at rest starts falling only once a dispatch has seen the cell below it free, or every level of a resting stack would bank one more step than the one under it and the top of a deep layer would launch), adds its velocity, at most 1 cell per axis, to its remainder, and when the remainder reaches 1 on an axis swaps with the cell in the way if `canDisplace` allows it: the cell is empty, or a gas, powder or liquid lighter than the mover. So sand (1600) sinks through water (1000) and oil (900), water through oil, and the displaced cell moves up. A cell never displaces one of its own density, and nothing displaces a solid or fire. A blocked axis loses its speed, except that a cell blocked by a slower cell moving the same way takes that cell's speed, so a falling column falls together. A cell faster than 1.5 cells per dispatch does not move in the grid; the flyer passes take it. Resting and sliding are part of the same phase (`velocityRule`): a powder or liquid cell resting on something that does not give way loses a quarter of its sideways speed (below 1/256 it stops), and moves to the opposite bottom corner if `canDisplace` allows it. A settled pile ends with velocity and remainder exactly 0.
2. **Gases spread**: a top-row gas cell moves into the empty neighbor in a randomly picked direction (one try); a bottom-row one does too when it cannot rise. Only a cell that did not move earlier in the dispatch moves again.
3. **Liquids spread** (`spreadRow`, top row then bottom row): a liquid cell that did not move earlier in the dispatch and is not falling moves into the empty cell beside it in its row, if that is the direction it remembers (a cell without memory picks one at random). The memory is the cell's `life` field: a cell that moved keeps going in that direction on later dispatches, which makes a stream flow instead of diffuse. A cell facing anything but empty space turns around, and one that could move turns around one time in 64 instead. Two liquids side by side never swap, so a layered body stays layered.
4. **Lifetimes**: an element with a `life` row loses its `decay` per dispatch and becomes the element named by `becomes` when it runs out (fire becomes smoke at 0).
5. **Element rules**: for each cell, a generated `switch` on its element calls that element's rule, if the row has one; the rule sees the block and may change any of its cells. Fire's rule: fire next to water becomes smoke.
6. **Ignition**: a flammable cell (oil) with a fire cell in its block becomes fire, starting at fire's `life.start`. Which cells ignite is decided right after the lifetimes (phase 4), before the rules, and applied here, so a rule never sees a cell that ignites in the same dispatch: oil that ignites beside water burns for a step before its fire goes out, while the fire that lit it is put out at once.
7. **Heat conduction**: the four cells of the block exchange heat pairwise, see Heat.

Fire has no movement rule; it only moves when a gas rises through it.

Intuition for the liquids: each cell looks only at its 2×2 block, so a liquid cannot feel the weight of the water above it or push water along a pipe. A pool flattens because surface cells slide off the high spots, and falls into every gap. Example: a 30×40 block of water against the left wall of a 200-wide tank spreads out to a sheet 6 to 7 cells deep in about 1,200 supersteps (`tests/simulation.test.ts`, "dam break"). Connected vessels do not level: in the `uTube` scene the filled arm stays full and the empty arm stays empty, as in The Powder Toy (`docs/decisions.md`).

## Heat

Intuition: a hot cell warms the cell next to it and cools down itself, until the two have the same temperature, and a metal passes heat on much more readily than stone. Every cell that holds heat has a temperature (`temp`); empty space and the wall have none and stay out of it, so a hot cell surrounded by empty space and walls keeps its heat (empty space gets an air temperature in M6).

Each dispatch, after all the other phases, the four cells of a block exchange heat in four pairs: the two rows, then the two columns at offset 0, the two columns, then the two rows at offset 1, so neither axis always goes first. Over a superstep every cell exchanges with each of its four neighbors. For a pair (a, b) with conductivities κa, κb and heat capacities Ca, Cb:

- the pair's conductivity is the harmonic mean g = 2·κa·κb / (κa + κb), and 0 when either κ is 0 (the plain formula is 0/0 for two cells that hold no heat, which would write NaN into empty cells);
- with d = Ta − Tb, stored Ta −= g·d·Cb / (Ca + Cb) and Tb += g·d·Ca / (Ca + Cb); nothing is written when g or d is 0, so a cell that holds no heat keeps its `temp` word bit for bit.

Because Ca·ΔTa + Cb·ΔTb = 0, the heat C·T is conserved up to rounding; each exchange moves both cells toward their capacity-weighted mean and never past it (d becomes d·(1 − g)), so any κ in [0, 1] and any capacities are stable. The exchange reads and writes only the block's cells, which `tests/block-locality.test.ts` checks. The capacity is per cell: a cell is one unit of matter whatever its state, so metal (3.5) takes 3.5 times the heat of a fresh cell of capacity 1 for the same change of temperature, and water (4.2) soaks up the most. Conductivity and capacity are tuned from physical ranks, not physical units; the comment on each row says where its numbers come from.

Speed: for one element, a unit of heat steps to its pair partner with probability κ/2 per dispatch, and its next partner is on the far side unless it stepped, so the variance of its position grows by κ/(2 − κ) cells² per dispatch along each axis. For metal (κ 1) that is 1 cell² per dispatch, a spread of about 22 cells in a second at 1x (62 at 8x); for stone (κ 0.1) about 5 (14). κ = 1 is the most a per-dispatch exchange allows.

Example (`tests/heat.test.ts`): a 4-column line at 500 °C in a 256-wide slab at 20 °C. Between superstep 100 and 400 the variance of the excess heat along the slab grows by 600·κ/(2 − κ) within 5% (measured within 0.01%), for metal and for stone. In the `heatBars` scene (a metal bar and a stone bar, 48×4 each, hot in the 6 left columns) the far end of the metal bar is 10 °C above its start after about 180 supersteps, the stone bar's after about 3,300.

## Movement by velocity

Intuition: a grain you drop does not fall at one fixed speed, it speeds up. Each falling cell carries a speed; every dispatch gravity adds a little, and the cell moves one cell whenever its unspent movement adds up to a whole cell. A grain starting from rest moves about 1 cell in the first 5 supersteps and 7 in the first 11, then 1 cell per dispatch, then flies.

Example (`tests/simulation.test.ts`, "a sand grain falls from rest with its element gravity"): with gravity 1/32 a grain has fallen `sum over k of min(k/32, 1)` cells after its k-th dispatch (the first dispatch gives no gravity); the test compares that sum with the grain's cell plus its remainder within 0.05 cells for the 23 supersteps it stays in the grid.

Why a limit of 1 cell per dispatch inside the grid: a block has room for one move per axis. Faster cells would need to cross blocks, which a thread working on one block cannot do safely, so they leave the grid instead.

## Flyers

A cell whose speed passes `launchSpeed` (1.5 cells per dispatch) leaves the grid as a flyer: a particle with a float position and velocity that carries the whole cell (every field) and flies under its element's `gravity` and `drag` (speed at most 16). Intuition: debris thrown by a blast is too fast for the grid, so it travels as a free particle and lands back as a cell. Example: the `blast` scene throws sand to a 99th-percentile distance of 237 cells from the blast center, against 37 when every cell stays in the grid (`tests/simulation.test.ts`, "the blast throws debris as far as the prototype did").

The passes run once per superstep, after the offset-1 dispatch (`Flyers.recordSuperstep`):

1. **Launch**: the CA counts, per workgroup, the cells above the launch speed. One workgroup turns the counts into slots after the live flyers (a prefix sum), and each launching cell moves into its slot in the order cell index gives. Past `maxFlyers` the cell stays in the grid, its speed clamped to 1 cell per dispatch, and `capped` counts it.
2. **Flight**: two dispatches of gravity and drag. A flyer walks the grid cells between its old and new position (4-connected, so it cannot slip between two diagonal cells) and stops in the last free cell before the first occupied one, so a wall one cell thick cannot be crossed. A flyer that stops, or slows below the launch speed, claims the free cell it is in with an atomic minimum on a key made of (cells walked, slot).
3. **Landing, two rounds**: the lowest key of each cell enters the grid with its speed clamped to 1 cell per dispatch and an empty remainder. A flyer that lost looks for a free cell within 3 cells, picked at random so that flyers which wanted the same cell spread out (one buried in the grid searches around the first free cell above it), and tries again in the second round; one that fails stays in the air and counts a retry (`jammed` counts 8 failures).
4. **Compaction**: a prefix sum over the survivors moves them to the other flyer buffer in order.

Every slot comes from a prefix sum in a fixed order and every conflict from the slot index, so two runs with one seed are bit-identical. The brush's erase and replace mark the flyers in the stroke as landed, and the next compaction drops them; Clear empties the list. The display reads an overlay buffer, cleared and filled once a frame with the kind word of each flyer's cell, and draws a flyer where the cell under it is empty.

## Brush

Painting writes the selected element into empty cells within the brush radius of the segment from the previous frame's pointer position to the current one (or into any non-wall cell when Shift is held); erasing empties every cell in range. The pass runs once per frame before the CA steps, so no block ever sees a half-painted state. The radius is in cells, whatever the grid scale. The painted variant comes from the cell coordinates and a per-frame seed, the painted life from the element's `life.start` (0 without one), and the painted temperature from the element's `temperature`; a replaced cell's temperature goes with the rest of it.

## Boundaries

`readCell` returns a wall for out-of-bounds coordinates, so the grid edge behaves like a wall, and writes outside the grid are skipped. No rule moves a wall, so out-of-bounds walls never enter the grid. Without fire in the scene every type keeps its count, flyers in the air included (every rule swaps cells); fire burns oil and ends as smoke.
