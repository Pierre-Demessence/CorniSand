# M6 Air

Status: M6.1a to M6.1c, M6.2a to M6.2c, M6.3a to M6.3d, M6.4a to M6.4b and M6.5a to M6.5b and M6.6a to M6.6d done; next open item M6.7a.

## Goal

Empty space becomes air that moves, pushes and holds heat. Explosions send a pressure wave that throws sand and breaks stone, the wind tool blows smoke across the screen, walls stop the air, and hot things warm the air above them, which rises in a plume and cools them down. The player sees the air in an air view and reads its pressure and temperature under the pointer.

## Scope

In: an air grid (pressure, velocity, temperature) stepped once per superstep; walls block it and the world's edge lets it out; powders, liquids, gases and flyers pushed by it (backlog I13); pressure bursts from changes of element (gunpowder igniting, water flashing into steam); ambient heat (cells exchange heat with the air, hot air rises, heat leaves through the open edges); pressure thresholds that change elements; the wind tool; the air view, air temperature in the heat view, pressure and air temperature in the readout; the budget; the field-subset bindings the flyer flight pass needs to read the air (part of D31).

Not in M6:

- Moving matter dragging the air (a falling sand stream pulling air down): backlog line at M6.8.
- Gases still rise and spread by their own rules; the air adds a drift on top. Smoke by what burns (I16) stays open.
- Flyers blocked by gases (I14); explosives beyond gunpowder (M8); pressure-dependent boiling points; low-pressure transitions (added when an element needs one).
- A UI switch for air on/off or its resolution: both are `Simulation` options, and M10 decides presets.

## Choices approved by the user

1. The world's edge is open air: pressure, wind and heat leave the screen, a blast does not echo off the edge, and the world cools back toward room temperature. A wall drawn along the edge seals it. (Rejected: a closed edge, where a blast reverberates and every fire warms the whole screen for good.)
2. Explosions: a GUNPOWDER element that bursts when it ignites, and water that flashes into steam pushes the air out. No pressure tools.
3. Under a strong enough blast, STONE is crushed into SAND (crushed rock; sand is its stand-in).
4. Fire drifts with the air like a gas: flames lean in the wind and rise in their own hot air.
5. The air's resolution starts at TPT's 4×4 cells per air cell; the gate compares it with 2×2 (`?air=2`) and the user picks the default.
6. The UI is a working prototype: no Claude Design canvas. The whole UI is redesigned once every feature exists.

## Terms

- **Dispatch**: one Margolus CA pass. **Superstep**: two dispatches and the flyer passes. 1x is 4 supersteps per frame.
- **Air cell**: `s × s` grid cells (`airCellSize`, 1, 2, 4 or 8). **Air step**: one update of the air grid; the air runs `n` substeps per superstep, the fewest that keep it stable at `s` (1 at 4×4).
- **Pressure**: dimensionless, 0 is ambient. **Air velocity** and every `AIR` constant are in grid cells and dispatches, not air cells, so a change of `s` changes the detail of the air, not its speeds.
- **Openness** of a face between two air cells: the share of the rows (columns) of grid cells between the two air-cell centers that contain no solid cell. 0 is a sealed face.

## Acceptance criteria

New test titles start with `M6 AC<n>:` (earlier milestones' titles already use plain `AC<n>`).

Groundwork (M6.1)

- AC1 THE SYSTEM SHALL bind only the `kind` field in the flyer flight and retry passes, and every pipeline SHALL be created on a device with the default 8 storage buffers per stage (`tests/gpu.test.ts`); the whole suite passes unchanged.

Air grid (M6.2)

- AC2 THE SYSTEM SHALL keep pressure, velocity and temperature per air cell for `airCellSize` 1, 2, 4 and 8 (default 4), reset to rest (pressure 0, velocity 0, `ROOM_TEMP`) by `load` and `clear`; WHEN created with `air: false`, THE SYSTEM SHALL record no air pass and compile the CA and flight without air code.
- AC3 WHEN a pressure pulse is set in the middle of an open grid, THE SYSTEM SHALL spread it as a ring whose radius grows at `AIR.waveSpeed` within 15%, the same in all four directions within one air cell, at `s` 4 and 2.
- AC4 WHEN the pulse reaches an open edge, THE SYSTEM SHALL let it leave: the pressure reflected back is below 30% of the peak that arrived, and the grid's total absolute pressure falls below 5% of its start within a measured number of supersteps.
- AC5 WHEN a wall one cell thick (vertical, horizontal, and diagonal at 45°) separates two regions, THE SYSTEM SHALL keep the far side at rest (|pressure| below 1% of the pulse's peak) while a pulse fills the near side; WHEN the wall has a gap of 3 air cells, air SHALL pass (control).
- AC6 WHEN all the air is at rest at room temperature and nothing heats it, THE SYSTEM SHALL keep every air word unchanged; WHEN a scene with air in motion is run twice from the same seed, every cell field, flyer and air word SHALL be bit-identical.

Air moves matter (M6.3)

- AC7 WHEN a pressure pulse goes off under a layer of sand, THE SYSTEM SHALL push the sand outward: the time of the pressure peak at increasing radii grows linearly with the radius (a front, within 20% of `AIR.waveSpeed`); the sand's mean distance from the center grows by at least the measured value less 30% within a measured number of supersteps, and at least 80% of the grains that moved more than 2 cells moved away from the center; without the pulse no grain moves.
- AC8 WHEN a wall stands between the pulse and a sand pile, THE SYSTEM SHALL move no grain of that pile by more than 1 cell.
- AC9 WHEN grains fly through a steady crosswind, THE SYSTEM SHALL land them downwind of where they land in still air by at least the measured distance less 30%; in still air flyers behave as before (M4's blast test passes unchanged).
- AC10 WHEN a powder or liquid cell falls in still air, THE SYSTEM SHALL apply gravity, then lose `drag` of its speed, per dispatch, as a flyer does (its fall within 0.05 cells of that recurrence over 23 supersteps); with `air: false`, the pre-M6 free-fall test passes unchanged.
- AC11 WHEN smoke sits in air held at a steady sideways speed, THE SYSTEM SHALL carry it downwind: its centroid moves at between 0.5 and 1.2 times the air speed.
- AC12 WHEN wind blows over a pool of water or a sand pile, THE SYSTEM SHALL slow the air inside them to at most 20% of the air above.
- AC13 WHEN gunpowder touches fire or passes its ignition temperature, THE SYSTEM SHALL ignite it and add its `above.burst` to the pressure of its air cell; a pocket of gunpowder under sand (`explosion` scene) throws the sand as AC7 does; WHEN water boils, THE SYSTEM SHALL add water's burst, so water poured onto lava raises the pressure around it above a measured value.

Ambient heat (M6.4)

- AC14 WHEN a cell that holds heat sits in air at another temperature, THE SYSTEM SHALL exchange heat between them by the cells' pairwise rule with the air's conductivity and capacity; a 16×16 metal block at 1,000 °C in an open-topped box cools below a measured temperature within a measured number of supersteps, and the air above it is warmer than the air beside it.
- AC15 WHEN a sealed wall box holds empty space and ice, water, steam, stone, lava, metal and molten metal on both sides of their thresholds, THE SYSTEM SHALL keep the total heat of its cells, flyers and air (latent heat included) within 0.01% over 2,000 supersteps.
- AC16 WHEN a metal plate at 1,000 °C lies on the floor of a tall box open at the top (`plume` scene), THE SYSTEM SHALL drive a rising plume: within a measured number of supersteps the mean upward air speed above the plate exceeds a measured value and that air is at least 50 °C above room temperature; with the plate at 20 °C the air stays at rest (AC6).
- AC17 WHEN steam at 110 °C is released into open air at room temperature, THE SYSTEM SHALL condense it into water within a measured number of supersteps.

Pressure transitions (M6.5)

- AC18 WHEN the pressure of its air cell passes an element's `pressureAbove.pressure`, THE SYSTEM SHALL turn the cell into `pressureAbove.becomes` in that dispatch, keeping its heat (the new cell starts at the temperature that holds the same heat, as at a threshold change, so a crush keeps AC15's total); stone within a measured distance of a gunpowder charge is crushed into sand, stone beyond it and stone behind a wall is not.
- AC19 IF a `pressureAbove` has a non-finite or non-positive pressure or a target missing from the table, or a `burst` is negative, non-finite or on a `below` transition, THEN THE SYSTEM SHALL reject the table with an error naming the row; an element with a pressure transition is never inert.

Tools and views (M6.6)

- AC20 WHILE the Wind tool is dragged, THE SYSTEM SHALL move the air under the brush in the stroke's direction at a speed that grows with the stroke's speed, capped at `AIR.maxSpeed`; a stroke dragged rightward through a smoke cloud moves its centroid right by at least a measured distance; a still pointer blows nothing; the right button still erases.
- AC21 WHILE the air view is on, THE SYSTEM SHALL draw pressure in colors whose luminance strictly increases from −`AIR.viewRange` to +`AIR.viewRange`, the materials faded over it, wind as line marks pointing downwind whose length grows with its speed, and a labelled legend; a toolbar button and the A key toggle it (Ctrl, Meta and Alt ignored); turning it on turns the heat view off and the other way round.
- AC22 WHILE the heat view is on, THE SYSTEM SHALL draw empty space in the dimmed color of its air temperature.
- AC23 WHILE the pointer is over the grid, THE SYSTEM SHALL show the air's temperature and pressure for empty space, and the pressure after a material's temperature.

Budget (M6.7)

- AC24 WHEN `npm run bench` runs on the idle RTX 4080 at the default air resolution, THE SYSTEM SHALL spend at most 1 ms more GPU time per 1x frame at 2560×1340 than the M6.1 baseline on each of `tank`, `mix75`, `full100`, `blast` and `thermal`: air's share of the 7 ms left after the engine and heat (`docs/powder-toy.md`).

Docs (M6.8)

- AC25 WHEN M6 is done, `README.md`, the help hint in `index.html`, `AGENTS.md`, `docs/simulation.md`, `docs/decisions.md`, `docs/backlog.md`, `docs/powder-toy.md` and `docs/roadmap.md` SHALL describe the air, with the roadmap's M6 and this plan deleted.

## Design

### The air grid (M6.2)

`src/air.ts` holds `AIR` (constants in cells and dispatches: `waveSpeed` 1, `maxSpeed`, `pressureLoss`, `velocityLoss`, `edgeDamping`, `buoyancy`, `heatCapacity` per cell, `conductivity`, `diffusion`, `push`, `matterLoss`, `burstScale`, `windToolGain`, `viewRange`) and their WGSL constants, like `src/movement.ts`. `src/air-grid.ts` holds `AirGrid`: the buffers, the passes, the bind groups other passes read, `load`, `clear` and `read` for tests. `src/shaders/air.wgsl.ts` holds the passes and the sampling functions shared by the CA, the flight pass and the display.

**State.** Air cells are `ceil(W / s) × ceil(H / s)`. One `array<vec4f>` holds per air cell the velocity on its right face (x) and its top face (y) (a staggered grid, so pressure and velocity do not decouple into a checkerboard), the pressure and the temperature at its center. A scratch buffer of the same shape, a mask buffer (openness of the right and top faces, the share of powder or liquid cells, the count of cells that hold heat) and a burst buffer (`atomic<i32>`, fixed point) complete it.

**Passes.** Once per frame, after the brush: the **mask** pass (one thread per air cell, reads `kind` only). Per air step, after the superstep's flyer passes, in the frame's one compute pass:

1. **Coupling** (one thread per air cell, which owns its `s × s` cells): adds and clears the burst buffer; exchanges heat with each cell that holds heat (M6.4); applies the frame's air tool in the frame's first air step (M6.6).
2. **Velocity**: each face gains −Δp across it (scaled for `waveSpeed`) and the buoyancy of its air (M6.4), loses `velocityLoss` and the matter share times `matterLoss`, is clamped to `maxSpeed` and multiplied by its openness (0 on a sealed face). In place: it writes only its own velocity words and reads only neighbors' pressure words.
3. **Pressure**: p −= divergence of the face velocities, times (1 − `pressureLoss`). In place for the same reason.
4. **Advect**: semi-Lagrangian for velocity; flux form with upwind values for heat (`C·T` crosses a face as velocity × openness × the upwind temperature), so air heat is conserved exactly; state → scratch.
5. **Diffuse**: air temperature across open faces; scratch → state.

Each air step ends with the state in the same buffer it started in, so no buffer parity is kept in JS across frames (the bug class of D28). The wave speed fixes the substep count: the velocity–pressure pair is stable while `waveSpeed` × 2 / `s` ≤ 0.7 air cells per substep and advection while `maxSpeed` × 2 / `s` ≤ 1; `n` is the smallest count that meets both, computed once.

**Walls and edges.** The mask pass computes each face's openness by scanning the rows (columns) of grid cells between the two air-cell centers: a row containing a solid cell is closed. A wall one cell thick in any orientation closes every row it crosses, which a share-of-solid-cells rule would not (a 1-cell wall fills a quarter of a 4×4 air cell). Beyond the grid is open air at rest at `ROOM_TEMP` (ghost cells: pressure 0, temperature 20 °C); out-of-grid cells count as open in the scan, so a wall along the edge seals it. The outer ring of air cells damps pressure and velocity by `edgeDamping` so waves leave without a strong echo (AC4). Air cells partly outside the grid treat their outside cells as open air.

**Options.** `Simulation` takes `air?: boolean` (default true) and `airCellSize?: 1 | 2 | 4 | 8` (default 4). With `air: false` nothing is allocated past a stub, no air pass is recorded, and the generated CA and flight shaders leave the air code out, as phase 8 is left out without transitions. `main.ts` reads `?air=<size>` for the gate's comparison. `Simulation.air.read()` returns pressure, velocity and temperature per air cell; `air.load(partial)` sets them, for tests.

**Bench.** `BENCH_AIR=1,2,4,8` runs the scenes at each size, with the air passes timed apart; numbers in "M6.2 results".

### Air moves matter (M6.3)

**The CA reads the air.** Group 3 of the CA holds the launch counts, the air state (read-only) and the burst buffer: 5 fields + 3 = 8 storage buffers, the default limit (D32 is updated: the CA is at the limit too). A block samples the air once, at its center, bilinearly: the velocity (from the faces) and the pressure gradient. The air state is written only by the air passes, between CA dispatches, so the CA's out-of-block read of it cannot race; `tests/block-locality.test.ts` binds a random air state.

- **Powders and liquids** (`velocityRule`, before integrating): v += drag·(air − v) − `push`·∇p / density. `drag` keeps its value and now means the share of its speed relative to the air a cell loses per dispatch, in the grid and in flight. One drag cannot both let sand fly far and let wind throw it (TPT's advection-only coupling, with a drag strong enough to throw sand, makes sand fall like snow), so the pressure gradient pushes on its own, lighter matter more.
- **Gases** (and fire, choice 4), a new step after phase 2: a cell that has not moved this dispatch moves one cell along each axis of the air's velocity with probability min(1, 2·|v|) when that cell is inside the block and empty. No state is kept (gases already move at random), so `velocity` and `remainder` stay 0 for anything that does not fall.
- **Matter slows the air**: the mask's powder-or-liquid share damps the velocity of its air cell (AC12).

**Flyers (I13).** The flight pass binds the air state (group 3) and applies the same drag and push per flight step. M6.1's subset bindings keep it at 3 + 1 + 1 storage buffers.

**Bursts.** `Transition.burst` (≥ 0, `above` only): pressure released into the air cell when a cell passes that threshold, by heat (phase 8) or, for an `above` into FIRE, by touching fire (phase 6). The CA adds it to the burst buffer with an integer `atomicAdd` (fixed point, `AIR.burstScale`); integer adds commute, so reruns stay bit-identical. The coupling pass moves it into the pressure.

**Rows.** GUNPOWDER (ID 13, toolbar 12): powder, flammable, density, ignition point, conductivity and capacity from physical data (black powder; sources in the row comment), `above: { temp: <ignition>, becomes: 'FIRE', burst: <tuned> }`. WATER's `above` gets a small burst, tuned so a single boiling cell barely stirs the air and water poured onto lava visibly pushes. Bursts are tuned against AC7 and AC13, values and reasons in the row comments.

**Existing tests.** They keep the default (air on). A test that fails because the air acts as designed runs with `air: false`, the mode it was written for, and an M6 test covers the new behavior; any other failure is a bug. Expected: the free-fall test (AC10), M5's AC7 (a hot block in empty space now cools), M5's AC8 and AC14 (heat now flows into the air; AC15 replaces them with air counted).

**Scene** `explosion` (256×160, `?scene=`): a gunpowder pocket under a sand layer, a stone wall to one side, a fire cell to light it.

### Ambient heat (M6.4)

**Exchange.** In the coupling pass each cell that holds heat exchanges with its air cell by `exchangeHeat`'s rule, with κ = `AIR.conductivity` and C = `AIR.heatCapacity` × s² for the air, in a fixed cell order: conserving, never overshooting, deterministic. Empty space and walls hold no heat as before; empty space's temperature is its air cell's. Air holds little heat per cell (air's volumetric heat capacity is about 1/3,500 of water's; the tuned value is in `AIR`'s comment), so the air takes a hot cell's temperature fast and cooling comes from the air moving away.

**Hot air rises.** The velocity pass adds `buoyancy`·(T − `ROOM_TEMP`) to each top face, from the mean temperature of the two air cells it joins: hot air rises, cold air sinks. Heat leaves through the open edges (ghost cells at 20 °C), so a hot world cools back to room temperature; in a sealed box nothing leaves (AC15).

**Tuning targets**, for the gate to adjust: a 16×16 metal block at 1,000 °C in open air drops below 200 °C in 30 to 120 s at 1x; steam in open air condenses within about 10 s; a fire's plume lifts smoke visibly faster than smoke beside it.

**Tests and scenes.** `heatContent` in `tests/metrics.ts` adds the air's C·T. Scene `plume` (256×192, open top): a metal plate at 1,000 °C on the floor, smoke sources beside it.

### Pressure transitions (M6.5)

`pressureAbove?: { pressure: number; becomes: string }` on a row: one way, instant, no latent cost. Phase 8 checks it after the temperature thresholds, against the pressure of the cell's air cell (nearest), and `retype`s the cell, keeping its temperature. `elementInert` adds "no pressure transition". Packing: `pressureAbove` (f32), `aboveBurst` (f32), the pressure target in bits 16–23 of `transitions`; rows grow to 24 words (96 bytes, a legal uniform stride; 24 KiB for 256 rows). STONE: `pressureAbove: { pressure: <tuned>, becomes: 'SAND' }`, tuned so a gunpowder charge of about 50 cells crushes stone within about 15 cells.

### Tools and views (M6.6)

A prototype UI (choice 6): the defaults below, kept simple and readable.

- **Wind tool**: `TOOLS` gains "Wind" (`air: 'wind'`) after Heat and Cool. `SimulationInput.wind?: boolean`. The air's own uniform (written once per frame, never between dispatches) carries the stroke segment, radius and mode; in the frame's first air step, the faces under the stroke move toward the stroke's velocity (pointer movement per frame over the frame's dispatches, times `windToolGain`, capped at `maxSpeed`). `replacing` stays off with a tool, as for Heat and Cool.
- **Air view**: `PRESSURE_RAMP` in `src/air.ts`, knots with strictly increasing luminance from dark blue (low) through mid grey (0) to pale yellow (high), generating the WGSL and the legend's CSS gradient like `HEAT_RAMP`; materials drawn at 30% over it; wind marks: one line per 16×16 pixels from the air velocity at its center, pointing downwind, length growing with speed, drawn light with a dark outline. Hue never carries the meaning alone: luminance, the labelled legend and the readout do. `DisplayOptions.airView`; the display's group 3 gets the air state (display at 7 storage buffers).
- **Heat view**: empty space in the heat ramp's color of its air temperature at 50% brightness.
- **Readout**: `probe` also copies the air cell's pressure and temperature (`CellProbe.pressure`, `airTemp`): "Empty · 23 °C · pressure +1.2", "Sand · 25 °C · pressure +1.2".

The gate: the browser check, then the user's playtest (M6.6d).

### Budget (M6.7)

Measured against "Baseline (M6.1)" per AC24. Levers in order: (1) the coupling pass skips air cells whose mask counts no heat-holding cell (the count is per frame; a cell entering mid-frame waits a frame, which conserves heat); (2) the CA samples the air only in blocks holding a powder, liquid, gas or fire cell; (3) the coupling pass once per frame with its rate scaled; (4) a gate with the numbers.

### Edge cases and failure modes

- A burst inside a sealed wall pocket stays there and decays by `pressureLoss`.
- A sealed face's velocity is 0 and nothing crosses it, so heat cannot leak through a wall one cell thick.
- Air cells fully inside a solid hold an isolated pocket; their exchange with the solid is negligible (tiny capacity).
- A flyer carries its temperature and exchanges no heat with the air in flight (unchanged); it is pushed by the air.
- The heat-view color of empty space uses the air temperature, never the empty cell's meaningless `temp` word.
- f32 sums of 3.4M exchanges: the conservation tests use small boxes, as in M5.
- Device loss re-creates the air with the world, at rest.

## Checklist

### M6.1 Groundwork (tasks)

- [x] M6.1a Baseline: lint, typecheck, `npm test`, build; `nvidia-smi` idle, then `npm run bench`; all into "Baseline (M6.1)".
- [x] M6.1b Field-subset bindings: `CellFields` gives a layout and bind group for a list of field names, `cellBindingsWGSL` takes the list (binding = field index, as now); flight and retry bind `kind` only; AC1. Verify: lint, typecheck, `npm test`.
- [x] M6.1c Backlog D31 updated (subset bindings exist; flight and retry use them).

Visible after: nothing: groundwork only.
Needs you: nothing (an idle RTX 4080 for the bench is checked before the run starts).

### M6.2 Air grid (tasks)

- [x] M6.2a `src/air.ts, `src/air-grid.ts`, `src/shaders/air.wgsl.ts` per Design: buffers, mask pass, air step (coupling with bursts only, velocity, pressure, advect, diffuse), substeps, open edges; the `air` and `airCellSize` options; `load`, `clear`, `air.read`, `air.load`; `?air=` in `main.ts`. Verify: lint, typecheck, `npm test`.
  Decided during the run: a face's speed is multiplied by `faceGate(openness) = max(0, 2 * openness - 1)`, not by the openness itself (`faceGate` in `src/shaders/air.wgsl.ts`). Why: with the plain openness a 45° wall leaked (the far side reached 20 to 40% of the near side's pulse in a measurement at s 4 and 2), because a wall crossing the corner of an air cell leaves two faces half open; the gate closes every path through a one-cell wall at any angle and angle offset measured (s 1, 2 and 4), and still passes the gap control. Alternative: the plain openness, or any other curve. Change: one function.
  Decided during the run: the arrays hold one more column and row than there are air cells (array position (a, b) is air cell (a - 1, b - 1); column 0 and row 0 are ghost cells whose faces are the left and bottom faces of the first cells), and the faces on the world's edge carry no pressure gradient: the air through them leaves at `waveSpeed` times the pressure inside (an open boundary), plus `edgeDamping` on the outer ring. Why: the pressure-0 ghost air alone reflects a wave back inverted at full strength; this lets it out (the pressure two air cells from the edge shows no echo above 5% of the arrival in a measurement). Alternative: a thick damped ring only. Change: the edge branches of `airVelocityWGSL`. M6.3a and later samples through `at(a, b)` of the same file.
  Decided during the run: `AIR.maxSpeed` is 2 cells per dispatch, and the heat the air carries moves at the air's speed up to a cap of `cellSize * substeps / 8` (0.5 at 1, 2 and 4; 1 at 8), the speed at which a cell would give away all its heat in one step; and the temperature is advected as the excess over room temperature. Why: without the cap the upwind sum can overshoot at maxSpeed, and advecting the plain temperature changes a uniform room-temperature air that is compressed or stretched. Heat is kept to 1e-5 until it reaches the edge (measured at s 1, 2, 4, 8); a compressed hot blob peaks up to 35% above its start (s 1). Alternative: a smaller `maxSpeed` for the whole air. Change: `AIR.maxSpeed`, `fluxCap` in `src/air.ts`.
- [x] M6.2b `tests/air.test.ts`: AC2–AC6; the determinism tests compare the air words too. Bench with `BENCH_AIR` into "M6.2 results". Verify: lint, typecheck, `npm test`, build.
  Decided during the run: AC4's echo is measured against a free wave: the same pulse in a 512-cell grid whose wave has not reached its edge, compared air cell by air cell with the 128-cell grid, over cells at least 24 grid cells from the edge (nearer, the difference is the wave leaving, not an echo); the incident peak is the free wave's largest |pressure| in the small grid's outer ring. Measured: echo 29.0% of the incident peak at s 4 and 16.5% at s 2, so the 30% bar passes with little room at s 4 (the worst point is a slanted arrival near a corner; a wall along the edge, as control, gives 83% and 142%). Draining: under 5% of the start after 94 supersteps at s 4 and 89 at s 2; the test allows 100. Why: the plan names no way to separate echo from the incident wave. Alternative: look at normal incidence on the axis only (lower numbers), or a different band. Change: `EDGE_BAND` and `DRAINED` in `tests/air.test.ts`; a retune of `edgeDamping` or the edge faces would raise the margin.
  Decided during the run: AC2's clause "compile the CA and flight without air code" is not tested here: the CA and the flight pass have no air code until M6.3a and M6.3b, so the clause holds trivially; the test covers `air: false` recording no air pass and holding no buffer. Why: nothing to check yet. Alternative: a test on the generated source now (it would assert an absence). Change: M6.3a adds the check on the CA source when it adds the air code.
  Decided during the run: `BENCH_AIR` also takes `off` (air disabled), and the 1x breakdown has an `air` column (sum of the `air *` passes). Why: the same-session `off` run separates the air's cost from the drift between sessions (the M6.1 baseline and the `off` run differ by up to 0.13 ms on `mix75`). Alternative: only the sizes. Change: `airRuns` in `tests/bench.gpu.ts`.
- [x] M6.2c `docs/simulation.md`: an Air section (grid, step, walls and edges; intuition, example, formula).

Visible after: nothing: the air moves but nothing reads it and no view shows it yet.
Needs you: nothing.

### M6.3 Air moves matter (tasks)

- [x] M6.3a The CA reads the air: group 3, block-center sampling, drag and push in `velocityRule`, the gas (and fire) drift, the matter damping; the block-locality test binds a random air state; existing tests triaged per Design; AC10–AC12 and AC7–AC8 with pulses set by `air.load`. Verify: lint, typecheck, `npm test`.
  Decided during the run: the CA reads the air through `airAround` (`airReadWGSL` in `src/shaders/air.wgsl.ts`), once per block that holds a powder, liquid, gas or fire cell, at the block's center; the bilinear samplers (`uAt`, `vAt`, `pressureAt`, `sampleU`, `sampleV`, `sampleGradient`, now `airSamplersWGSL(array)`) moved out of the advect pass so the CA, and M6.3b's flight pass, share them. The air is built before the flyers, and `Flyers` takes the air state buffer to put it at binding 1 of the CA's group 3 (`launchLayout`), only when there is air. Why: one place for the sampling and the layout, no air code or binding without air. Alternative: a separate air bind group for the CA. The shared helper `at` of the air shaders is now `airIndex`, so the CA's own names do not clash. Change: `Simulation` constructor, `Flyers` constructor.
  Decided during the run: `AIR.push` is 16000 and `AIR.matterLoss` 0.05 (share of speed lost per dispatch in an air cell wholly filled with powder or liquid; the inside of a basin keeps 2% of the wind above it after 30 supersteps). Why: with the first guess (push 800) a pulse of peak 2 moved no grain, because dense sand can only move at its free surface; at 16000 a pulse of peak 2 and sigma 6, 10 cells under the surface of a 40-deep layer, lifts the surface grains out. The sand test measures at 8 supersteps (86% of the grains that moved went away; at 12 only 59%, as the sand around falls back into the pit). Alternative: any other pair; the gunpowder burst of M6.3c is tuned against these. Change: `AIR` in `src/air.ts` and `MEASURED_GROWTH` in `tests/air-matter.test.ts`.
  Decided during the run: a gas or fire cell that moved this dispatch (a gas that rose, which is every dispatch for smoke in open air) still drifts sideways along its row, but not vertically; the plan says "a cell that has not moved". Why: with the plan's wording rising smoke never drifts (measured centroid speed 0.005 of the wind against the required 0.5 to 1.2); with this it is 0.70 to 0.73. Alternative: run the drift before the rise (a downdraft would then be undone by the rise). Change: `driftCell` in `src/shaders/ca.wgsl.ts`.
  Decided during the run: the in-grid drag shortens the hops of debris that lands and flies again, so the blast's 99th-percentile distance falls from 237 to 181 cells (all of it from the grid drag: with that line off the number is 237.07 exactly). M4's blast distance test (AC17 in `tests/simulation.test.ts`) therefore runs with `air: false`, the mode it was written for, under the Design's rule for existing tests; the flight itself is unchanged in still air. M6.3b: AC9's "M4's blast test passes unchanged" cannot hold with air on for the same reason; M6.3b should compare a launched grain's landing with air on and off in still air (identical) instead, and keep the blast test on `air: false`. Alternative: lower the test's 0.9 factor to fit 181. Change: the `createSim` call of that test.
  Decided during the run: other existing tests changed by the grid drag: the free-fall test (AC14, sand and water) runs with `air: false` (AC10's M6 twin is in `tests/air-matter.test.ts`); four tests that let a grain fall 190 cells and expect it in the air after 30 supersteps (simulation AC14 launch, heat AC4 and AC16, display AC17) now wait 60 supersteps, since the grain launches at superstep 48 and lands at 81. AC10's test compares the fall with the recurrence run with the speed stored in binary16 rounded to nearest and truncated, and accepts a fall within 0.05 of the span between them: Dawn on the RTX 4080 truncates (the fall is 0.057 below the unrounded recurrence at superstep 18), and a bound on one rounding mode would depend on the GPU. Alternative: air on with a taller grid. Change: those tests.
- [x] M6.3b Flyers read the air (I13): AC9. Verify: lint, typecheck, `npm test`.
  Decided during the run: the flight pass samples the air (`airAround`) at the flyer's position before each of its two dispatches per superstep, and computes the drag as `vel * (1 - drag) + drag * air` instead of the CA's `v += drag * (air - v)`, so that in air at rest (velocity 0, gradient 0) every flyer word is bit-identical to a run with `air: false` (`tests/air-matter.test.ts`, 12 supersteps compared word for word). AC9's "M4's blast test passes unchanged" holds as the M6.3a decision says: that test runs with `air: false`, and the still-air equality above replaces it for the flight itself. Why: the algebraically equal form rounds differently. Alternative: the CA's form (flights differ in the last bits). Change: the `air` branch in `flightWGSL`.
  Decided during the run: the flight pass binds the CA's group 3 (`launchLayout`, so the air state is binding 1 as in the CA) although it does not use binding 0, the launch counts: 3 + 1 + 2 = 6 storage buffers, within the limit of 8. Why: one layout and one bind group for both readers of the air. Alternative: a layout of the air state alone (needs a second binding number in `airReadWGSL`). Change: `Flyers` constructor.
  AC9 measured (a grain thrown sideways at 6 cells per dispatch from 88 cells above a floor, wind 0.5 cells per dispatch held steady, 640 x 128 grid, air cell size 4): 40 dispatches in, while it still flies, the wind moves it 5.3 cells and a headwind moves it back by about as much (the test requires 70% of it); it lands 30 cells downwind of the still-air landing (x 308.5) and 30 cells upwind in a headwind. The tests require 70% of each.
- [x] M6.3c Bursts: `Transition.burst`, the CA's atomic adds, GUNPOWDER, WATER's burst, the `explosion` scene; AC13; bursts tuned and recorded in the rows. Verify: lint, typecheck, `npm test`, build.
  Decided during the run: the burst is released in phase 8 when a cell passes an `above` threshold (any target) and in phase 6 only when the igniting element's `above` becomes FIRE (`igniteBurst`, `releaseBurst` in `src/shaders/ca.wgsl.ts`); the CA binds the burst buffer at binding 2 of group 3, so `launchLayout` (shared with the flight pass) has three bindings with air: the flight pass counts 7 storage buffers. Why: the plan says "an `above` into FIRE, by touching fire (phase 6)"; one layout and one bind group for both readers of group 3. Alternative: a burst on any ignition. Change: `igniteBurst`.
  Decided during the run: the amount is added as `round(burst * AIR.burstScale)` in 1/1024 units, so a water burst of 0.1 adds 102/1024 (tested). The element row grows to 24 words (96 bytes): `aboveBurst` plus three padding words, because 21 words (84 bytes) is not a legal uniform array stride; M6.5a puts `pressureAbove` in a padding word. Why: a stride must be a multiple of 16 bytes. Alternative: pack the burst into an existing word. Change: `PROP_FIELDS` in `src/element-table.ts`.
  Decided during the run: `burst` validation (negative, non-finite, or on a `below` transition: the table is rejected with an error naming the row, AC19's burst half) is done here with the field; M6.5a keeps `pressureAbove` and the inert rule. Why: a field with no check is a trap, and the check is three lines. Alternative: leave it to M6.5a. Change: `validateTransitions`.
  Decided during the run: GUNPOWDER burst 3, WATER burst 0.1 (`src/elements.ts`). Measured on the `explosion` scene (seed 5, 8 supersteps, grains within 28 cells of the charge): mean distance gained 1.86 at burst 2, 2.54 at 3, 2.74 at 4 (AC7's pulse gives 2.6); 84% of the grains that moved went away at 3; from 3 up the air hits its speed limit, so more burst only pushes the matter harder. Water: 160 cells poured onto lava give a peak pressure 0.175 and wind 0.21 cells per dispatch at 0.1 (0.12 and 0.11 at 0.05); one boiling cell gives a peak below the burst itself and a wind under 0.1 (measured 0.035 and 0.024 at 0.05). Alternative: any burst between; the M6.6 playtest gate judges the feel. Change: `GUNPOWDER_BURST`, `WATER_BURST` and the measured values in `tests/air-burst.test.ts`.
  Decided during the run: GUNPOWDER is 1,700 kg/m³ (grain density, specific gravity 1.70 to 1.82 in safety data sheets), so it sinks through sand and water; ignition 427 °C (sheets give 200 to 464 °C, ignition in 5 s at 427); conductivity 0.03 and capacity 1.4 are estimates, not read from a source (the Army Research Laboratory report ARL-TR-2033 measured them, its numbers were not reachable). Because it is denser than sand, the `explosion` scene's charge rests on a 12x2 wall shelf (a charge in the middle of the sand slumps into it), and the control "unlit moves no grain" tolerates up to 2 grains moving more than 2 cells (measured 1). Alternative: a bulk density near 1,000 (equal to water's, which neither sinks nor floats in the CA). Change: the GUNPOWDER row, `EXPLOSION.shelf`.
  Decided during the run: `explosion` starts its fire cell with the FIRE life (a cell with life 0 is smoke after one dispatch and never ignites anything), so `tests/scenes.test.ts` now expects life 0 everywhere except on FIRE cells, where it expects the element's start. Change: `Canvas.fire` in `src/scenes.ts`.
  Backlog I18: a lit charge burns only part of itself (16 of 48 in the open, about 24 under sand); the rest is thrown away unburnt.
- [x] M6.3d Docs: `docs/simulation.md` (drag, push, gas drift, bursts, the phases), the gunpowder row in its element table.

Visible after: a Gunpowder button; lit gunpowder explodes and throws sand; water poured onto lava puffs outward; flames lean and drift with moving air; `?scene=explosion` shows it.
Needs you: nothing (the playtest is M6.6's gate).

### M6.4 Ambient heat (tasks)

- [x] M6.4a Exchange in the coupling pass, buoyancy, heat advection and diffusion, the edge at room temperature; `heatContent` with the air; M5 heat tests triaged per Design; AC14–AC17; the `plume` scene; constants tuned to the Design's targets. Verify: lint, typecheck, `npm test`, build, bench into "M6.4 results".
  Decided during the run: a solid cell trades heat with the air cell of its first open neighbor (up, left, right, then down; open means empty space, a gas or fire), not with the air cell it is in; a solid with no open neighbor trades none; any other cell that holds heat trades with its own air cell. The coupling thread of an air cell reads the one-cell ring around its cells to find the solids that belong to it (`airOf` in `src/shaders/air.wgsl.ts`), so no cell belongs to two threads. Why: the plan says each cell exchanges with its air cell, but the mask closes every face of an air cell that holds only solid (no row between the centers is free of solid), so the air over an aligned 16x16 block of metal could never take its heat; an exchange with the neighbor air is also what an exposed surface does. Alternative: the own air cell plus a thermal diffusion that ignores the solids that hold heat (slower: diffusion carries about a tenth of the heat), or a scatter pass with atomics (floating-point sums that depend on thread order). Change: `airOf` and the ring loop in `airCouplingWGSL`.
  Decided during the run: the buoyancy of a face is scaled by one less the powder-or-liquid share of the two air cells it joins (`airVelocityWGSL`). Why: hot air inside a pile cannot rise freely, and without it the burning charge's hot air in the `explosion` scene drew the sand inward (M6.3c's AC13 growth fell from 2.5 to 1.7 cells of mean distance, below its bar). Alternative: buoyancy everywhere and a larger burst. Change: that factor.
  Decided during the run: `AIR.conductivity` 0.5, `AIR.heatCapacity` 0.04 per grid cell (33 times the physical 0.0012, which is 1/3,500 of water's) and `AIR.buoyancy` 2e-6 (cells per dispatch squared per degree). Why: with the physical capacity a 16x16 metal block at 1,000 degrees only reaches 820 after 30,000 supersteps (125 s), because each air cell carries almost no heat out; at 0.04 it falls below 200 after about 19,500 supersteps (81 s at 1x, the plan's 30 to 120 s) and 64 steam cells condense in 840 supersteps (3.5 s; the plan's "about 10 s" is not reached: the two targets scale together with the capacity, and the block's bar was judged first). A buoyancy of 4e-6 makes a stronger plume but pushes sand next to a large plate harder (backlog I19); 1.5e-6 needs a capacity of about 0.1 for the block. Alternative: any other pair on that trade; the M6.6 gate judges the feel. Change: `AIR` in `src/air.ts` and the `MEASURED` values in `tests/air-heat.test.ts`.
  Decided during the run: the exchange runs once per air step with the capacity `heatCapacity * s * s`, with no scaling by the number of steps per superstep, as the Design says; so at `?air=2` (2 steps per superstep, a quarter of the capacity per air cell) heat moves between cells and air at another rate than at 4. Why: the Design's formula; a scaling would be a second tuning. Alternative: scale the exchange share by the step length and the cells per air cell. Change: `airCouplingWGSL`.
  Decided during the run: M5's heat tests that measure a cell's own temperature, or a sealed box's total without the air, run with `air: false` (`NO_AIR` in `tests/heat.test.ts`: the flyer test AC4, AC7 empty space and walls, AC8, AC14, the phase-change tests through `oneSuperstep`, AC9 and the freeze test, the Heat tool's flyer test AC16 and the probe test AC18), as the Design expects; M6 AC14 to AC17 in `tests/air-heat.test.ts` replace them with the air counted (`heatContent` takes the air). Change: `NO_AIR`.
  Decided during the run: the tuning target "a fire's plume lifts smoke faster than smoke beside it" is not met and has no test: a gas cell that rose this dispatch (every dispatch in open air) drifts sideways only (the M6.3a decision), and it already rises at the top speed of 1 cell per dispatch, so the air cannot lift it faster; the plume carries smoke sideways (inflow toward the base) and lifts what would otherwise sit under a ceiling. The `plume` scene keeps its two smoke blocks for the gate to watch. Alternative: let a rising gas also drift upward with the air. Change: `driftCell`.
- [x] M6.4b Docs: `docs/simulation.md` (Heat: empty space now holds the air's temperature, heat leaves through the edge).
  Decided during the run: besides the Heat section (a new "Heat and the air" subsection and two corrected sentences), the Air section's coupling and velocity steps and its Cost line are updated, with the s = 4 figure from "M6.4 results" and a note that the other sizes were measured before the heat exchange. Why: those sentences said the heat exchange was still to come and the cost was out of date. Alternative: leave Cost to M6.7. Change: the Cost paragraph of `docs/simulation.md`. `AGENTS.md` (its Heat invariant still says nothing cools in open air before M6) is left to M6.8, which the plan assigns it to.

Visible after: hot things cool down in open air; fire, lava and hot metal send up a plume of hot air that carries smoke; steam clouds turn back into water; `?scene=plume` shows it.
Needs you: nothing.

### M6.5 Pressure transitions (tasks)

- [x] M6.5a `pressureAbove`, `burst` validation, 96-byte packing, the inert rule, the phase 8 check, STONE → SAND; AC18–AC19. Verify: lint, typecheck, `npm test`.
  Decided during the run: `STONE_CRUSH` is 0.2. Measured (`tests/air-crush.test.ts`: the 48-cell charge on a platform in open air, single stone cells every 3 cells to its right, 40 supersteps): the farthest stone crushed is 13 cells from the charge's edge at 0.18, 0.2 and 0.22, 10 at 0.25, 25 at 0.14 and every stone out to 61 cells at 0.08 (the pressure settles to a long low tail below about 0.15); behind a 2-thick wall no stone is crushed even at 0.03. Why: 0.2 sits on the plateau of the 13-cell range, near the plan's "about 15", and above the 0.175 peak of water poured onto lava, so boiling water alone does not crush stone. Alternative: any value in 0.18 to 0.22 gives the same range; a lower one makes the blast reach far across the screen. Change: `STONE_CRUSH` in `src/elements.ts`.
  Decided during the run: an element without a pressure transition packs `NO_PRESSURE` (3e38, a finite float) in `pressureAbove`, and `pressureAbove` took the first padding word (the row stays 24 words); the target is in bits 16 to 23 of `transitions`. The CA reads the pressure of the air cell that holds the grid cell (the same one the burst is added to), only when the table has a pressure transition and the sim has air. Why: infinity compares differently across GPUs; a target of 0 cannot mean "none" since EMPTY is a valid target. Alternative: a flag bit. Change: `PROP_FIELDS`, `transitionCell`.
  Decided during the run: a crush keeps the heat, not the temperature: the sand starts at `stored temperature * C_stone / C_sand` (stone 500 degrees becomes sand at 846), as phase 8 does at a threshold change. The user chose this (2026-10-28) over keeping the temperature and amending AC15, because AC15 is the invariant the rest of M6 builds on; a crushed cell can look hotter than the stone it came from for a moment. Why: stone and sand hold different heat per degree (2.2 against 1.3), so the same temperature changes the box's total (7% in the AC15 box). AC15 now runs on the real table (the test asserts sand appeared, so the crush is in it) and holds within 1e-4. Alternative: keep the temperature and amend AC15 to exclude crushes. Change: `transitionCell` in `src/shaders/ca.wgsl.ts`; M6.5b records the rule in `docs/simulation.md`.
  Backlog I20: a stone mass is crushed from its exposed surface only, because an air cell that is half solid or more is closed to the air (visible at the gate with thick walls).
- [x] M6.5b Docs: `docs/simulation.md` (phase 8, the table's columns).

Visible after: a gunpowder blast crushes nearby stone into sand.
Needs you: nothing.

### M6.6 Tools and views (tasks)

- [x] M6.6a Wind tool: `TOOLS`, `SimulationInput.wind`, the air uniform; AC20. Verify: lint, typecheck, `npm test`.
  Decided during the run: the Wind tool has its own compute pass, `air wind` (`airWindWGSL`), recorded once per frame after the mask pass and before the CA, with its own small uniform (group 1); the Design put it in the coupling pass of the frame's first air step. Why: the coupling pass is recorded once per air step and shares no per-step uniform, so applying a stroke in the first step only would need a dynamic-offset slot per step; a separate pass needs none, costs nothing when no stroke is made (not recorded), and lets the CA's first dispatches already feel the wind. It reads the mask pass's openness, so a closed face stays at 0. Alternative: the coupling pass with a slot per air step. Change: `AirGrid.recordWind` and `airWindWGSL`.
  Decided during the run: `AIR.windToolGain` is 0.5 and `AIR.windToolBlend` 0.5: a stroke of `d` cells over a frame of `n` dispatches sets the target air speed to 0.5 d / n cells per dispatch (capped at `maxSpeed` 2), and each face under the brush closes half the gap to it per frame; the faces reached are those whose center lies within the brush radius, at least one air cell, of the stroke segment. Why: at 1x (8 dispatches a frame) a 10-cell-a-frame drag gives about 0.6 cells per dispatch and the cap is reached at 32 cells a frame, so the speed grows over the whole range of a normal drag; measured, 8 frames of 10 cells through a smoke cloud (radius 40) move its centroid 27 cells in the stroke's direction against 0.06 with no stroke. Alternative: any other pair; the M6.6 playtest gate judges the feel. Change: `AIR` in `src/air.ts` and `MEASURED_SMOKE_SHIFT` in `tests/air-wind.test.ts`.
  Decided during the run: a pointer that did not move records no wind pass (the air is untouched, bit for bit), a slow drag pulls the air under it toward that slow speed, and a wind stroke does not call the brush pass (it paints nothing, with or without `replacing`); with the right button (`erasing`) the brush erases and the wind is not recorded. `TOOLS` gains `{ id: 'wind', label: 'Wind', heating: 0, air: 'wind' }`; `tests/heat.test.ts` AC16 now loops over the tools with a non-zero `heating`. Why: Heat, Cool and Wind are one kind of tool in the toolbar, and the brush has no use for a stroke that paints nothing. Alternative: let the still pointer brake the air. Change: `blowing` in `Simulation.simulate`.
- [x] M6.6b Air view, its legend, the A key, exclusive with the heat view; air temperature in the heat view; AC21–AC22 render tests. Verify: lint, typecheck, `npm test`, build.
  Decided during the run: the display gets the air state at binding 1 of group 0 (next to its uniform), not in group 3, and `Display` takes the `AirGrid` as an optional last argument; without it (or with `air: false`) the shader is generated with `HAS_AIR` false, the air view shows ambient pressure and no wind, and the heat view leaves empty space as the background. Why: group 3 is the flyer overlay's own bind group, and a fifth group exceeds the default limit of 4; the storage buffers stay at 7. Alternative: a combined group 3 layout with the overlay. Change: the `Display` constructor and `airDisplayWGSL`.
  Decided during the run: `AIR.viewRange` is 0.5 (the stone crush threshold 0.2 is 40% of the way out; a gunpowder charge saturates), and `PRESSURE_RAMP` has five knots (dark blue, blue, grey, khaki, pale yellow at -0.5, -0.25, 0, 0.25, 0.5) with rising luminance; it reuses `RampKnot`, whose `temp` field holds the pressure. The wind marks are in `AIR_VIEW`: one arrow per 16x16 screen pixels, centered on its tile, `11 * (speed / maxSpeed)^0.4` pixels long (so a 0.08 plume shows 3 pixels and a 0.5 wind 6), none under 2 pixels, light with a dark outline. The views are one `Views` state (`toggleView` in `src/toolbar.ts`) so turning one on turns the other off; the shader gives the air view priority if both are set. Why: the plan leaves the values open; the exponent keeps weak wind visible beside the Wind tool's strong one. Alternative: a linear length (weak wind invisible), or a wider range. Change: `AIR.viewRange`, `PRESSURE_RAMP`, `AIR_VIEW` in `src/air.ts`.
- [x] M6.6c Readout with pressure and air temperature; AC23. Verify: lint, typecheck, `npm test`.
  Decided during the run: the pressure is written with two decimals and a sign (`pressure +0.20`, a zero as `0.00`), not the Design's one decimal (`+1.2`). Why: pressures run from 0 to about 0.5 (the stone crush is 0.2, `AIR.viewRange` 0.5), so one decimal would show 0.0 or +0.2 only. Alternative: one decimal. Change: `formatPressure` in `src/readout.ts`.
  Decided during the run: a wall shows its label alone, with no temperature or pressure; empty space shows its air's temperature and pressure, a material that holds heat its own temperature and then the pressure. Why: AC23 names empty space and materials; the air cell around a wall cell is a closed pocket whose values mean nothing. Alternative: pressure on walls too. Change: `formatProbe` in `src/readout.ts`.
  Decided during the run: `CellProbe.pressure` and `airTemp` are absent (not zero) when the simulation has no air, and the line then ends after the temperature. The probe's air cell is the one that holds the grid cell (`AirGrid.probeOffset`), the same lookup as the CA's pressure transition.
- [x] M6.6d Browser check on the user's dev server (or one started for it): the Wind tool, the A key and button, the legend, the readout, `?air=2` and `?air=4`, no WebGPU error. Then the gate.
  Browser check done (the user's dev server on port 5173, Chrome on the RTX 4080, scenes `plume`, `explosion` and the empty world at `?air=2` and `?air=4`): no console error or WebGPU banner (only the favicon 404, older than M6); the A key and the Air view button toggle the air view and its legend (title, pressure ramp, labels -0.5, 0, +0.5), turning it on turns the heat view off and the other way round, Ctrl+A and Alt+A do nothing; the air view of `plume` shows the plume's arrows and a pressure tint, the heat view shows the air above the plate warm (empty space 345 °C over the plate, 45 °C beside it); the readout shows "Empty · 189 °C · pressure 0.00", "Metal · 307 °C · pressure 0.00", "Smoke · 33 °C · pressure +0.01"; dragging the Wind tool rightward draws arrows pointing right along the stroke with a pressure ripple around it; 75 FPS (the display's rate) at `?air=2`, `?air=4` and the default once the shaders are compiled (the first second reads 1 to 2 FPS).
  Decided during the run: the readout's reserved width (`.probe-text` in `index.html`) goes from 17ch to 38ch. Why: the line now reaches 36 characters ("Gunpowder · 9999 °C · pressure +0.50") and the old width let it run over the Brush label (measured: the box was 120 px wide, the text 204 px). The cost is that the element buttons get about 170 px less room before they scroll (the toolbar was already scrolling at 1,000 to 1,260 px). Alternative: let the line shrink with an ellipsis, or move it to its own line. Change: that one `min-width`.

Visible after: a Wind tool, an Air view (button or A) with a legend, warm air in the heat view, and pressure and air temperature under the pointer.
Needs you: the playtest gate (stops the run): blow smoke with the Wind tool, light gunpowder under sand and beside stone, pour water onto lava, watch `?scene=plume` in the heat and air views, compare `?air=2` with the default, and say whether explosions, wind and cooling feel right and which air resolution to keep.

### M6.7 Budget (tasks)

- [ ] M6.7a Bench at the chosen resolution; AC24; the levers per Design if needed; "M6.7 results".
- [ ] M6.7b `docs/powder-toy.md`: the frame budget with the air's measured share and its cost per resolution.

Visible after: nothing new: the frame time with air is measured and within its share.
Needs you: a decision only if the budget is still missed after the levers (stops the run).

### M6.8 Docs and finish (tasks)

- [ ] M6.8a Per AC25: README (features, the Wind tool, the air view and A, the scenes); `index.html` help hint; AGENTS.md (layout: the air files and tests; invariants: the air grid, the coupling pass as a second writer of `temp` that owns its air cell's cells, the CA's air reads and atomic bursts, storage buffers per pass, heat leaving through the open edge, the phases; adding an element: `drag` relative to the air, `burst`, `pressureAbove`; the bench's `BENCH_AIR`); `docs/simulation.md`; `docs/decisions.md` (the air on its own coarse explicit grid coupled by sampling and an owning gather pass, rejected: a pressure solve and air inside the CA; pressure pushes by its gradient over density while drag pulls toward the air's velocity, rejected: advection-only coupling); backlog (I13 deleted, D31 and D32 updated, I16 updated, a line for moving matter dragging the air); `docs/powder-toy.md` mapping rows; roadmap M6 deleted; this plan deleted in the final commit.

Visible after: nothing.
Needs you: nothing.

## Baseline (M6.1)

Taken before any M6 code, on `main` at `e4b33ed`.

Checks: lint passes with no warnings, typecheck passes, `npm test` passes (12 files, 181 tests, 0 skipped; the GPU suites ran on the real adapter), build passes with no warnings.

Bench (`npm run bench`, RTX 4080 `lovelace`, 2560×1340, median GPU ms per frame of 60). Wallpaper Engine closed; `nvidia-smi` showed 15 to 35% desktop load (browser, Discord, Steam, VS Code open), no game, no compute process of note. A second run of the 1x column agreed within 0.07 ms (`mix75` 1.51 against 1.44, the rest within 0.01).

| Scene | 1x | 2x | 4x | 8x |
| --- | --- | --- | --- | --- |
| `tank` | 0.46 | 0.98 | 2.03 | 4.00 |
| `mix75` | 1.44 | 2.88 | 5.05 | 6.36 |
| `full100` | 1.31 | 2.56 | 4.92 | 8.19 |
| `blast` | 0.39 | 0.59 | 1.18 | 2.29 |
| `thermal` | 1.05 | 2.03 | 4.00 | 7.93 |

The 1x time by pass (ms, mean of the frames; the passes are split, so the sum is slightly above the 1x median):

| Scene | ca0 | ca1 | launch scan | launch scatter | flight | land 1 | retry | land 2 | compact scan | compact scatter | sum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tank` | 0.122 | 0.142 | 0.093 | 0.032 | 0.033 | 0.019 | 0.016 | 0.010 | 0.010 | 0.009 | 0.485 |
| `mix75` | 0.582 | 0.675 | 0.082 | 0.042 | 0.047 | 0.014 | 0.034 | 0.025 | 0.005 | 0.024 | 1.530 |
| `full100` | 0.571 | 0.581 | 0.115 | 0.031 | 0.027 | 0.012 | 0.013 | 0.016 | 0.005 | 0.012 | 1.384 |
| `blast` | 0.110 | 0.096 | 0.042 | 0.036 | 0.019 | 0.015 | 0.024 | 0.010 | 0.009 | 0.016 | 0.377 |
| `thermal` | 0.524 | 0.534 | 0.011 | 0.032 | 0.023 | 0.009 | 0.008 | 0.013 | 0.004 | 0.013 | 1.171 |

Simulation creation: 599 ms for the first 64×64 grid (shader compilation), 3 ms for the next; 611 ms then 10 ms at 1920×898; first frame 2 ms.

AC24 allows at most 1 ms more at 1x than these numbers on each scene.

## M6.2 results

Taken at `8975da5` plus the M6.2b tests, same machine and method as the baseline (`BENCH_AIR=<size> npm run bench`, one run per size). Wallpaper Engine closed, `nvidia-smi` 22% desktop load (browser, Discord, Steam open), no game.

Median GPU ms per 1x frame at 2560x1340 by air cell size. `off` is `air: false` in the same session; the baseline column is from "Baseline (M6.1)". There is no air work in the CA yet (M6.3), so these numbers are the air passes alone.

| Scene | Baseline | off | 8 | 4 (default) | 2 | 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `tank` | 0.46 | 0.46 | 0.52 | 0.59 | 1.38 | 16.91 |
| `mix75` | 1.44 | 1.57 | 1.70 | 1.90 | 2.56 | 18.15 |
| `full100` | 1.31 | 1.44 | 1.57 | 1.70 | 2.42 | 18.09 |
| `blast` | 0.39 | 0.39 | 0.46 | 0.52 | 1.25 | 16.65 |
| `thermal` | 1.05 | 1.11 | 1.25 | 1.38 | 2.16 | 17.43 |

At the default size the 1x frame is 0.13 (`tank`, `blast`) to 0.46 ms (`mix75`) above the baseline, inside AC24's 1 ms. The sum of the `air *` passes at 1x (the `air` column of the breakdown, mean of the frames): size 8 0.07 to 0.12 ms, size 4 0.11 to 0.20, size 2 0.78 to 0.95, size 1 16.1 to 17.0. At size 4, per pass on `mix75`: mask 0.023, coupling 0.025, velocity 0.063, pressure 0.023, advect 0.033, diffuse 0.028. Size 1 is unusable at screen size (4 to 5 ms for each of its velocity, advect and diffuse passes, and 4 air steps per superstep); size 2 costs about 0.8 ms on every scene.

Median ms at 2x, 4x and 8x with size 4: `tank` 1.25, 2.49, 4.78; `mix75` 3.60, 5.96, 7.93; `full100` 3.28, 6.49, 11.01; `blast` 0.79, 1.57, 3.21; `thermal` 2.69, 5.24, 10.55.

Tests: AC3 ring speed 1.024 times `waveSpeed` at size 4 and 1.049 at size 2, the four directions equal; AC4 numbers are in the decision under M6.2b; AC5: the far side of a one-cell wall stays under 0.0003 of the pulse peak in every orientation and offset, and a gap of 3 air cells lets 0.12 to 0.16 through.

## M6.4 results

Taken at `eccd132` plus M6.4a, same machine and method as the baseline (`BENCH_AIR=off,4 npm run bench`, one run). Wallpaper Engine closed, `nvidia-smi` 7% desktop load (browser, Discord, Steam open), no game.

Measurements for the constants in `AIR` (conductivity 0.5, heatCapacity 0.04, buoyancy 2e-6; tests in `tests/air-heat.test.ts`; 1x is 240 supersteps a second):

- A 16x16 metal block at 1,000 °C in a 96x128 box open at the top: mean 830 to 840 °C after 1,200 supersteps, below 200 °C after about 19,500 supersteps (81 s), 160 to 170 °C after 24,000, for the block aligned with the air cells and shifted by 2. The air just above it is 466 to 482 °C warmer than the air at the box's side after 1,200 supersteps.
- The `plume` scene after 960 supersteps: the mean upward air speed over the plate's middle half, 12 to 60 cells above it, is 0.077 cells per dispatch and the air there is 509 °C above room temperature. With the plate at 20 °C the air stays at rest, every word. Pressure stays within 0.04 of ambient over 4,800 supersteps (a deficit of 0.03 to 0.05 above the plate).
- 64 steam cells at 110 °C released 20 cells above the floor of a box open at the top: all condensed after 840 supersteps (3.5 s); with `air: false` none.
- The sealed wall box of AC15 (4.2 million of heat): total within 1e-4 over 2,000 supersteps with the air counted; 80,000 of that heat went into the air.
- Sand piles 4 cells from the plate of the `plume` scene keep creeping for thousands of supersteps (cells changed against a plate at 20 °C: 640 against 228 after 3,600 supersteps): backlog I19.

Median GPU ms per 1x frame at 2560x1340, air cell size 4, against the baseline and the same session with the air off (AC24 is judged in M6.7):

| Scene | Baseline | off | 4 (default) | Above baseline |
| --- | --- | --- | --- | --- |
| `tank` | 0.46 | 0.46 | 0.72 | 0.26 |
| `mix75` | 1.44 | 1.57 | 2.16 | 0.72 |
| `full100` | 1.31 | 1.38 | 1.90 | 0.59 |
| `blast` | 0.39 | 0.39 | 0.59 | 0.20 |
| `thermal` | 1.05 | 1.11 | 2.29 | 1.24 |

`thermal` is over AC24's 1 ms. The air passes at 1x (mean of the frames): `tank` 0.18, `mix75` 0.31, `full100` 0.30, `blast` 0.18, `thermal` 0.47 ms, of which the coupling pass is 0.07, 0.18, 0.15, 0.07 and 0.32 (M6.2: 0.025 on `mix75`). The CA also grew with its air reads (`thermal`: ca0 and ca1 0.52 and 0.55 to 0.79 and 0.84). The levers of M6.7 apply: the coupling pass can skip air cells whose mask counts no heat-holding cell in them or in the ring around.

## M6.7 results

To be filled by M6.7a.
