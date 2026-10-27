# M6 Air

Status: M6.1a to M6.1c and M6.2a to M6.2c done; next open item M6.3a.

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

- AC18 WHEN the pressure of its air cell passes an element's `pressureAbove.pressure`, THE SYSTEM SHALL turn the cell into `pressureAbove.becomes` in that dispatch, keeping its temperature; stone within a measured distance of a gunpowder charge is crushed into sand, stone beyond it and stone behind a wall is not.
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

- [ ] M6.3a The CA reads the air: group 3, block-center sampling, drag and push in `velocityRule`, the gas (and fire) drift, the matter damping; the block-locality test binds a random air state; existing tests triaged per Design; AC10–AC12 and AC7–AC8 with pulses set by `air.load`. Verify: lint, typecheck, `npm test`.
- [ ] M6.3b Flyers read the air (I13): AC9. Verify: lint, typecheck, `npm test`.
- [ ] M6.3c Bursts: `Transition.burst`, the CA's atomic adds, GUNPOWDER, WATER's burst, the `explosion` scene; AC13; bursts tuned and recorded in the rows. Verify: lint, typecheck, `npm test`, build.
- [ ] M6.3d Docs: `docs/simulation.md` (drag, push, gas drift, bursts, the phases), the gunpowder row in its element table.

Visible after: a Gunpowder button; lit gunpowder explodes and throws sand; water poured onto lava puffs outward; flames lean and drift with moving air; `?scene=explosion` shows it.
Needs you: nothing (the playtest is M6.6's gate).

### M6.4 Ambient heat (tasks)

- [ ] M6.4a Exchange in the coupling pass, buoyancy, heat advection and diffusion, the edge at room temperature; `heatContent` with the air; M5 heat tests triaged per Design; AC14–AC17; the `plume` scene; constants tuned to the Design's targets. Verify: lint, typecheck, `npm test`, build, bench into "M6.4 results".
- [ ] M6.4b Docs: `docs/simulation.md` (Heat: empty space now holds the air's temperature, heat leaves through the edge).

Visible after: hot things cool down in open air; fire, lava and hot metal send up a plume of hot air that carries smoke; steam clouds turn back into water; `?scene=plume` shows it.
Needs you: nothing.

### M6.5 Pressure transitions (tasks)

- [ ] M6.5a `pressureAbove`, `burst` validation, 96-byte packing, the inert rule, the phase 8 check, STONE → SAND; AC18–AC19. Verify: lint, typecheck, `npm test`.
- [ ] M6.5b Docs: `docs/simulation.md` (phase 8, the table's columns).

Visible after: a gunpowder blast crushes nearby stone into sand.
Needs you: nothing.

### M6.6 Tools and views (tasks)

- [ ] M6.6a Wind tool: `TOOLS`, `SimulationInput.wind`, the air uniform; AC20. Verify: lint, typecheck, `npm test`.
- [ ] M6.6b Air view, its legend, the A key, exclusive with the heat view; air temperature in the heat view; AC21–AC22 render tests. Verify: lint, typecheck, `npm test`, build.
- [ ] M6.6c Readout with pressure and air temperature; AC23. Verify: lint, typecheck, `npm test`.
- [ ] M6.6d Browser check on the user's dev server (or one started for it): the Wind tool, the A key and button, the legend, the readout, `?air=2` and `?air=4`, no WebGPU error. Then the gate.

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

To be filled by M6.4a.

## M6.7 results

To be filled by M6.7a.
