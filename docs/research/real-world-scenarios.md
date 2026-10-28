# Real-world scenarios

Research, not a plan: a catalogue of real experiments the game should reproduce at its scale, each with a target computed from physical data, to be written as tests before the mechanics that make them pass. Slice M8.9 builds them and runs before M8.1; the user picks its scenarios from this doc. The ones not picked become `test.todo` entries, and M8.9's final commit deletes the doc (Lifecycle).

Figures come from the sources at the end or from the game's rows (`src/elements.ts`, whose comments cite their data). "Estimate" marks a figure from a simplified model or an extrapolation, "inferred" a status reasoned from the code and not measured. Each target's calculation is given here in one line, and its test repeats it.

## Why

Most scene tests guard against change: their bars are measured from the game's own output and re-measured whenever a change moves them. A target taken from reality does not move with the code, so it tells whether a change made the game more or less realistic, and, written before the mechanic, it is not set by whoever implements the mechanic after seeing the result. M8.8's AC3, AC7, AC10, AC11 and AC15 are already of this kind (Already in the tests).

## What a scenario is

- **One experiment**: a scene in `src/scenes.ts` (registered in `SCENES`, so `?scene=<name>` opens it), a run of supersteps, one measurement and a target with a tolerance. The scene's name is the scenario's ID in test titles, plans and backlog lines.
- **Measured as a player sees it**: a height, a position, a temperature the readout would show, a count of cells, a time; never an internal value such as a stored latent offset or an amount field that one design of I22 would add. The test then needs only the elements, no stub of the mechanism, and stays valid whichever design passes it.
- **A fast and a full version** when the full experiment is slow: the fast one isolates one rule (the thermometer loaded at 60 °C), the full one chains several (the thermometer dipped into a 60 °C bath), and when the full one fails, the fast one tells which link broke. Heat moves at its real speed, so a minute of game time is 14,400 supersteps.
- **Sealed when the air is not part of it**: a heat balance runs in a box of WALL, which holds no heat, filled so that no empty cell trades heat with the air, or with `air: false`.
- **What it leaves out**, stated in the test: a real effect the game leaves out on purpose either shifts the target or stays outside the scenario's claim (a real thermometer's glass expands too, the game's does not).

## States

| State | In the suite | Means |
| --- | --- | --- |
| Passes | a normal test | A failure is a regression |
| Waits for an item | `test.fails`, titled `<name> [waits for <ID>]: <outcome>` | Vitest passes it while it fails and fails it once it passes, so the suite stays green and the item that makes it pass also turns it into a normal test |
| Not built | `test.todo`, titled with its target | Not picked yet, or its elements do not exist |
| Out of reach | no test | A decision or a limit rules it out; the scenario is named beside it so nobody keeps trying |

- `test.fails` also passes when the test crashes, so each waiting scenario has a normal companion test: the scene loads and the measurement is a finite number in a stated range. Both attach the measured value and the target to the report (`context.annotate`), so progress shows without opening the code.
- The item a waiting scenario names is a roadmap or backlog ID. A mechanic without one (grain size, viscous spreading by depth, a convection onset, a heat capacity by temperature) gets a backlog line when its scenario is built.
- The GPU suites skip themselves without an adapter, so these tests run on a machine with a GPU only, never in CI (backlog D11).

## Rules

For `AGENTS.md`, once M8.9 lands:

- The target is a calculation from cited physical data, written in the test with its sources, never a value the game produced.
- The tolerance is fixed before the mechanic exists, from the spread of the data (the range between sources, or the row's own cited range) and of the measurement (several seeds). Only the user changes a scenario's target or tolerance, and the plan logs it; agents keep re-measuring the regression bars of other tests as before.
- Each scenario has a control: the same scene on a test table with one property deliberately wrong (ice with half its latent heat) must miss the target. A scenario that cannot fail proves nothing.
- A constant fitted to pass one scenario is checked by another scenario, of a different size or material, that it was not fitted on (Held-out checks).
- A scenario that starts passing before its item, through another change, is promoted in that change's commit, and the item's plan notes it.

## The scale

One cell is 1.3625 mm and one dispatch 2.08 ms (`src/physics.ts`): 734 cells to the metre, a world of 3.5 × 1.8 m at 2560×1340. A powder or liquid moves at most one cell per dispatch inside the grid (0.65 m/s), and faster cells fly, up to 16 cells per dispatch (10.5 m/s). Heat moves at its real speed. Experiments from a millimetre to a metre and from a second to tens of minutes fit; weather, diffusion and sound do not (`docs/research/physical-properties.md`, "The scale decides what shows"). Limits that stay: a cell is one unit of matter in every state (I22), liquids carry no pressure (`docs/decisions.md`, "Liquids move by CA rules, as in TPT"), solids never move, and the air's pressure waves travel about 500 times slower than sound, which slows blasts, wind and plumes (D33), with a pressure that has no physical unit.

## Candidates for M8.9

On today's elements:

| Scenario | What reality does | Today |
| --- | --- | --- |
| `iceCup` | ice melted in water leaves the cup at the temperature a heat balance gives | should pass (inferred) |
| `steamBurn` | steam brings about 8 times the heat of boiling water to a cold surface | should pass (inferred) |
| `contactTemp` | two blocks pressed together hold their contact face at a fixed weighted mean | to measure |
| `heatedLayer` | water heated gently from below stays still until a threshold, then stirs | fails (inferred) |
| `hourglass` | sand runs out at a steady rate however much is left | to measure |
| `viscousSpread` | a thick liquid spreads ever more slowly as it thins | to measure; inferred to fail |
| `redHotBar` | a red-hot steel bar cools to about 740 °C in two minutes | fails: 944 °C, waits for I26 and a capacity by temperature |
| `lavaCrust` | a lava pool's crust thickens as the square root of time | fails (inferred), waits for I26 |
| `freeFall` | a grain of sand falls 1 m in 0.64 s, a pebble in 0.46 s | fails for sand: 0.91 s |

### `iceCup`

- **Experiment**: ice at 0 °C dropped into water at 20 °C, 1 part ice to 9 by mass, in a sealed insulated cup.
- **Target**: all the ice melts and the cup ends at 10.0 °C, from 9 × 4.18 × (20 − T) = 334 + 4.18 T (water's latent heat of melting, 334 kJ/kg, and its capacity, 4.18 kJ/kg·K: the WATER row's data). A cell is one unit of matter, so the cup holds exactly 1 ice cell for 9 water cells: 100 and 900 in a 25×40 cup (a 32×32 cup would hold 1 to 9.24 and end at 10.24 °C). Tolerance ±0.2 °C: water's capacity runs from 4.18 to 4.22 kJ/kg·K between 20 and 0 °C, which moves the result by 0.1 °C.
- **Measure**: the mean temperature of the cup's cells once no ICE cell is left and the cup has evened out.
- **Fast**: chips, one ice cell in ten spread through the cup, each a few cells from the next (about half a minute of game time, estimate). **Full**: one 10×10 cube in the same cup (minutes; the meltwater's convection mixes it).
- **Control**: ICE and WATER with half their shared latent heat end at 14.0 °C.
- **Leaves out**: the cup's own heat (WALL holds none).
- **Today**: should pass (inferred: the sealed boxes of `tests/heat.test.ts` check the same bookkeeping). Needs nothing new.

### `steamBurn`

- **Experiment**: why steam scalds worse than boiling water: the same mass of each at 100 °C, sealed inside a cold steel box, so the condensate stays against the steel.
- **Target**: 10 cells of steam in a 100-cell box at 20 °C end at 86.1 °C, 10 cells of water at 28.5 °C (a heat balance with water's latent heat of boiling, 2,257 kJ/kg, and the METAL row's 3.5 MJ/m³·K). Carbon steel's 0.45 to 0.49 kJ/kg·K puts the steam case at 80.7 to 86.1 °C and the water case at 27.8 to 28.5 °C: the tolerance. Per unit of mass, steam brings 7.75 times the heat of boiling water to a surface at 20 °C ((2,257 + 4.18 × 80) / (4.18 × 80)).
- **Measure**: the box's mean temperature once every cell is within 0.5 °C of it. When the last steam condenses the steel is between 84.5 °C (the latent heat alone) and 86.1 °C, by how much the condensate has already cooled, so the measure waits for the box to even out.
- **Control**: WATER and STEAM with a tenth of their shared latent heat end at 34.3 °C.
- **Leaves out**: steam's volume (a steam cell holds one water cell's mass, I22) and the air.
- **Today**: should pass (inferred), within seconds of game time (the box's time constant is about a second, estimate). Needs nothing new.

### `contactTemp`

- **Experiment**: why metal feels colder than wood: a steel block at 80 °C pressed against a granite block at 20 °C. Their contact face jumps at once to near the temperature of the block that passes heat on faster, and stays there.
- **Target**: two bodies in perfect contact hold their contact face at the mean of their starting temperatures weighted by their effusivities √(k ρ c), at every time until the heat reaches their far ends (the exact solution for two semi-infinite solids). The rows (steel 50 W/m·K and 3.5 MJ/m³·K, effusivity 13,229; granite 2.5 and 2.2, effusivity 2,345) give 71.0 °C; the rows' cited ranges (steel 45 to 60 W/m·K and 3.5 to 3.85 MJ/m³·K, granite 2 to 3.5 W/m·K) give 69.1 to 72.7 °C.
- **Measure**: the contact face's temperature from the two cells beside it, weighted by their conductivities, once the heat has spread over 5 cells and before it reaches either far end; it also stays within 1 °C over that window.
- **Control**: stone with a conductivity of 25 W/m·K holds the face near 58 °C.
- **Leaves out**: the contact resistance of real surfaces.
- **Today**: to measure; inferred to pass once the heat has crossed a few cells, since a pair exchanges at the harmonic mean of its two conductivities, the series conductance of two half cells. Needs nothing new.

### `heatedLayer`

- **Experiment**: a layer of water heated gently from below conducts and stays still until the difference across it passes a threshold, then stirs into rolls (Rayleigh–Bénard convection). The threshold is a Rayleigh number of 1,708 between two rigid plates, and the difference it takes falls with the cube of the depth: for water at 20 °C, 1.76 °C across a layer 3 cells deep (4.1 mm), 0.093 °C across 8 cells (1.09 cm).
- **Target**: below the threshold (3 cells and 1 °C, a Rayleigh number of 970) heat crosses by conduction alone, k ΔT / d, within 20%. Well above it (8 cells and 2 °C, 36,780) it crosses faster, by a measured heat-transfer correlation for horizontal layers taken in the plan. A gentler gradient cannot be measured: at 0.05 °C across 8 cells a conduction exchange moves a cell by 2×10⁻⁶ °C, the spacing of f32 values near 20 °C, so rounding would decide the result; at 1 °C across 3 cells it moves 1.1×10⁻⁴ °C.
- **Measure**: the heat crossing the layer in its first 30 s, from the temperature change of the metal plates under and over it, thick enough to change by under a tenth of their difference meanwhile. The layer starts with conduction's straight-line profile between the plates: a layer starting at one plate's temperature would first take up heat for about 19 s, 32% more over the 30 s, past the bar.
- **Control**: water with flat density (no convection) misses the point above the threshold.
- **Held out**: `CONVECTION_GAIN` (Held-out checks).
- **Today**: fails (inferred). The convection swap has a chance for any density difference (twice its square root, `convectionChance`) and no threshold: at 1 °C across 3 cells each pair swaps with a chance of 0.017 per dispatch, which moves heat about 50 times faster than water conducts it (estimate). Waits for a convection onset (no ID yet).

### `hourglass`

- **Experiment**: sand runs through a narrow neck at a steady rate however much is left above it, which is why an hourglass keeps time; water slows as its level falls.
- **Target**: in two dimensions the rate grows as (D − k d)^(3/2) for an outlet D grains wide (Beverloo's law; the 3/2 power holds in every 2D study, Carlevaro et al. 2024), with k about 1 to 2, and does not depend on the height of sand above once that passes about the silo's width. (a) The rate stays within 10% while the sand above falls from 6 to 1.5 silo widths (tolerance inferred). (b) Widening the outlet from 8 to 16 cells multiplies it by 2.83 to 3.56 (k from 0 to 2, one cell being one grain).
- **Measure**: SAND cells through the outlet per 100 supersteps.
- **Control**: a rate proportional to the outlet's width (a ratio of 2) or to its square root (1.41) misses (b).
- **Held out**: the pile in the lower bulb stands at the angle of repose, 34° ± 4°, built by a stream as wide as the outlet (8 to 16 cells) instead of the pour from a brush 3 cells wide that `REPOSE_FIT` was fitted on.
- **Today**: to measure. Needs nothing new.

### `viscousSpread`

- **Experiment**: honey poured on a plate, or lava on flat ground, spreads fast at first and ever more slowly as it thins.
- **Target**: the front of a two-dimensional viscous current of fixed area A on a flat floor moves as x = 1.411 (g A³ t / (3ν))^(1/5) (Huppert 1982: the similarity solution every release tends to; A is the area from the wall to the front, ν the kinematic viscosity). Lava (30 Pa·s, 2,700 kg/m³: the LAVA row) released from a column 14 cells wide and 40 high against a wall: 65 cells at 3 s, 103 at 30 s. Their ratio is 10^(1/5) = 1.58 whatever the viscosity. Tolerance: 1.45 to 1.75 on the ratio, 20% on the positions (inferred).
- **Valid while**: the flow is viscous (a Reynolds number of 0.006 at 3 s) and deeper on average (8.6 cells at 3 s, 5.4 at 30 s) than lava's capillary length (2.7 cells, from a surface tension of 0.36 N/m), under which surface tension slows a real one.
- **Measure**: the farthest column holding lava in the bottom row.
- **Control**: a test liquid ten times as viscous puts its front 0.63 times as far.
- **Leaves out**: the lava's cooling (`air: false` on a WALL floor, which takes no heat) and surface tension.
- **Held out**: `REF_DEPTH` (Held-out checks).
- **Today**: to measure; inferred to fail. A liquid's spreading chance comes from `REF_DEPTH`, not from its own depth. Its front does slow as the column behind it thins (the comment in `tests/viscosity.test.ts`, whose 30×40 lava column's front ran at 0.0076 cells per dispatch from 2.7 to 10.7 s, 0.6 of the layer speed), but nothing in the rule follows the flow's depth, so the fifth-root law is not expected. It would then wait for viscous spreading by the flow's own depth (no ID yet). A HONEY row would make it the everyday version; no plan has one.

### `redHotBar`

- **Experiment**: a steel bar 2.2 cm square (16×16 cells) taken out of a forge at 1,000 °C and left in still room air.
- **Target**: about 720 to 750 °C after 125 s (estimate), by lumped cooling (the bar's Biot number is 0.03) through radiation at oxidized steel's emissivity, 0.9 to 0.6, and natural convection at 10 W/m²·K, with steel's heat capacity by temperature (EN 1993-1-2: 440 J/kg·K at 20 °C, 760 at 600 °C, a peak near 735 °C, where its crystal structure changes and a cooling bar pauses, and 650 above 900 °C). A bar in the 2D grid loses heat through its four sides only, as a long bar does. The emissivity alone spans 730 to 751 °C; natural convection on a bar this small is nearer 19 W/m²·K than 10 (about 8 °C lower), and EN 1993-1-2's curve is measured on heating, while a cooling bar changes structure at a somewhat lower temperature (inferred). The plan fixes the tolerance from these.
- **Fast**: the same cooling at the METAL row's constant 3.5 MJ/m³·K (iron at 20 °C): 578 to 650 °C, 599 °C at 0.8. It isolates the radiation rule.
- **Measure**: the bar's mean temperature at 125 s.
- **Control**: emissivity 0 (convection alone, at the row's capacity) leaves it at 938 °C, which is the game today.
- **Leaves out**: radiation coming back from the room (taken at 20 °C).
- **Today**: fails: 944 °C (`tests/air-heat.test.ts`, the 16×16 block). The fast version waits for I26; the full one also for a heat capacity that follows temperature (no ID yet), which `docs/research/physical-properties.md` ("Ruled out at this scale") counts as small, but which moves this bar by more than 100 °C.

### `lavaCrust`

- **Experiment**: a pool of basaltic lava open to still air grows a solid crust.
- **Target**: crust thickness C = 0.0779 √t, C in metres and t in hours: Hon et al. 1994 on Kīlauea's pāhoehoe, written t = 164.8 C² by Speiser 2017, whose text says centimetres but whose results fit metres only (its 45 cm crust is dated 35.6 hours, near the 33 that metres give, 164.8 × 0.45², where centimetres would give 33,000). That is 1 cm (7 cells) after 59 s and 3 cm (22 cells) after 9 minutes. The fit covers crusts of centimetres to about a metre over hours to days, so the first minutes extrapolate it: tolerance a factor of 1.5 on the thickness (estimate). The crust at 9 minutes is 3 times the crust at 1 minute whatever the constant.
- **Why it fails today**: at 1,150 °C a surface of emissivity 0.9 radiates 209 kW/m², 18 times the 11 kW/m² still air carries away.
- **Measure**: the STONE layer's thickness over the middle of the pool at 1 and 9 minutes.
- **Leaves out**: real basalt sets over a range of temperatures, the game's lava at one (1,200 °C, the LAVA row); gas bubbles in the crust, wind, rain.
- **Held out**: with `redHotBar`, one radiation rule is checked on two materials, sizes and temperatures.
- **Today**: fails (inferred). Waits for I26.

### `freeFall`

- **Experiment**: a pebble, a grain of sand and a pinch of flour dropped from 1 m.
- **Target**: the pebble lands in 0.46 s (0.452 s in a vacuum; a 5 mm grain settles at about 12 m/s, so drag adds little), the sand grain (0.3 mm, settling at about 2 m/s) in 0.64 s, and flour (50 µm, 0.07 to 0.1 m/s) hangs for 10 to 14 s. Settling speeds from `docs/research/physical-properties.md` (Grain size); times from drag growing with the square of the speed up to the settling speed (estimate).
- **Measure**: dispatches until the grain reaches the floor, 734 cells below.
- **Today**: fails for sand: every powder takes the default drag (1/64 per dispatch, settling at 1.29 m/s), which lands it after 0.91 s (computed from the update rule). Waits for grain size (`docs/research/physical-properties.md`, no ID yet). The pebble needs GRAVEL (M8.1e), the flour FLOUR (M8.2).

## With M8.1's materials

Written as `test.todo` until their rows exist; each M8.1 item turns its scenarios into tests before it adds the rows and mechanics.

### `thermometer`

- **Experiment**: a mercury thermometer: a bulb under a one-cell glass tube, with marks.
- **Target**: the mercury's top sits on the mark of its temperature, within one mark. The marks come from mercury's volumetric expansion, 1.81×10⁻⁴ per °C at 20 °C (`docs/research/volume-changes.md`): the column rises 1.81×10⁻⁴ cells per °C for each cell of bulb, so one cell per °C takes a bulb of 5,525 cells (74×74, 10 cm across), since the tube cannot be narrower than a cell, 1.36 mm, where a real thermometer's bore is a fraction of a millimetre. A real thermometer's glass expands too (linear 3.3×10⁻⁶ per °C for borosilicate, 9×10⁻⁶ for soda-lime), so its mercury rises 5 to 15% less than mercury alone; the game's glass does not, and the marks use mercury alone.
- **Measure**: the highest mercury cell in the tube, against the marks.
- **Fast**: the whole thermometer loaded at 0, 20, 60 and 100 °C. **Full**: at 20 °C, dipped into a water bath at 60 °C.
- **Control**: a test liquid that expands twice as much reads twice as far above the 0 °C mark.
- **For I22's design**: the volume research's 8-bit amount per cell (a full cell about 200 units) changes mercury's capacity by one unit per 27.6 °C, and a bulb at one temperature crosses each unit in all its cells at once, so its column would rise in jumps of 27.6 °C. Reading to the degree takes about 13 bits, or rounding spread across the cells (inferred from that doc's figures).
- **Today**: not built. Needs MERCURY (M8.1g) and GLASS (M8.1e), then waits for I22.

### Others

| Scenario | What reality does | Needs |
| --- | --- | --- |
| `densityColumn` | mercury (13,546 kg/m³), water, oil and sawdust poured in any order settle in that order from the bottom | MERCURY, SAWDUST (M8.1 AC18, AC19) |
| `nitrogenOnWater` | liquid nitrogen (807 kg/m³) floats on water, boils off and freezes a skin of ice; its drops skitter on their own vapor | LIQUID_NITROGEN (M8.1 AC20); the skitter waits for film boiling |
| `quench` | glass at 300 °C cracks where cold water drips on it; the same pane cooling in still air does not | GLASS and thermal shock (M8.1 AC28) |
| `crucible` | a preheated ceramic crucible holds molten steel; a cold one cracks | CERAMIC (M8.1 AC22) and thermal shock (M8.1's choice 8, AC27) |
| `iceOnMetal` | ice cubes at 0 °C on an aluminium and an acrylic block, both at room temperature: the cube on aluminium melts many times sooner. A melting face stays at 0 °C, so their first heat flows differ by the ratio of the blocks' effusivities, 41 to 45 (aluminium 237 W/m·K, 2,700 kg/m³, 0.897 kJ/kg·K; acrylic 0.19 W/m·K, 1,180 to 1,200 kg/m³, 1.26 to 1.47 kJ/kg·K); ice colder than 0 °C narrows it. The melt times come from a calculation for the chosen blocks | ALUMINIUM and ACRYLIC, in no plan (COPPER and INSULATION, M8.1f, could stand in) |

## Later

| Scenario | What reality does | Needs |
| --- | --- | --- |
| `damBreak` | a released water column's front runs at up to 2√(gH) (Ritter's ideal solution): 1.46 m/s for a column 40 cells high, more than twice the grid's top speed, which columns over 8 cells reach | I27 |
| `leidenfrost` | a water drop on a pan at 250 °C outlasts one at 150 °C many times over (Leidenfrost point about 185 °C on polished steel; lifetimes from Gottfried et al. 1966, to source) | film boiling (`docs/research/physical-properties.md`) |
| `capillary` | water climbs 7.5 to 8 cells up a one-cell glass slot (2γ cos θ / (ρ g w), γ 0.0728 N/m, θ 0 to 20°) | surface tension, GLASS |
| `puddleOnWax` | water on wax stops spreading 3.2 cells deep (2 l_c sin(θ/2), θ 107°) | surface tension, WAX |
| `sandCastle` | damp sand stands in a vertical wall 100 to 170 cells high | moisture |
| `drainage` | water drains through gravel tens of times faster than through sand | grain size, moisture, GRAVEL |
| `matchInDiesel` | a lit match dropped into diesel goes out, into petrol it lights it (flash points: diesel at least 52 °C, petrol −43 °C) | M8.2 |
| `flourDust` | flour dispersed in air explodes, a heap of it smoulders | M8.2 |
| `heavyGas` | carbon dioxide, about 1.5 times as dense as air, poured from a glass flows down and pools | M8.3 |
| `pressureCooker` | water boils at about 120 °C at one atmosphere over ambient | M8.3 and a physical pressure scale (D33) |
| `saltOnIce` | salt on ice makes brine that cools to −21.1 °C | M8.4 |
| `thermocouple`, `prism` | a copper–constantan junction gives about 40 µV per °C; a glass prism splits white light | M7 |

## Out of reach

| Scenario | What reality does | Why not |
| --- | --- | --- |
| `uTube`, `waterClock` | water levels in connected vessels; a tank drains faster when fuller (Torricelli) | liquids carry no pressure: `docs/decisions.md`, "Liquids move by CA rules, as in TPT" (the pressure solve that did it cost 49 ms a frame) |
| `soundSpeed` | a bang crosses the 3.5 m world in 10 ms | the air's waves are about 500 times slower than sound (D33) |
| `boilingVolume` | a boiling puddle fills 1,700 times its volume with steam | a 10×10 puddle would make 170,000 cells (`docs/research/volume-changes.md`, Steam) |

## Already in the tests

Their targets already come from data. M8.9 renames them as scenarios and gives each a control.

| Scenario | Test | Target | Measured |
| --- | --- | --- | --- |
| `sealedBars` | `tests/physics.test.ts`, M8.8 AC3 | a sealed bar's halves even out with the time constant L² / (π² α), within 15% (steel, stone, ice) | passes |
| `coolingBlock` | `tests/air-heat.test.ts`, M8.8 AC7 | a steel block 50 cells wide at 500 °C cools at still air's 10 W/m²·K, within a factor of 2 | 9.2 W/m²·K |
| `heatedPot` | `tests/convection.test.ts`, M8.8 AC10 | a hot block of water rises at √(g β ΔT L), within a factor of 3 | 0.19 against 0.18 cells per dispatch |
| `freezingPond` | `tests/convection.test.ts`, M8.8 AC11 | a pond under a freezing ceiling freezes from the top while its bottom stays at 3.5 °C or more | passes |
| `sandPile` | `tests/repose.test.ts`, M8.8 AC15 | sand poured from a point stands at its angle of repose, 34° ± 4° | 33.4° |

`tests/buoyancy.test.ts` (M8.8 AC13) is not one: its directions are real (a heavy gas settles, steam rises), but its bars are the game's own measurements, and real speeds through the air are out of reach (D33).

## Held-out checks

| Constant | Fitted on | Checked by |
| --- | --- | --- |
| `CONVECTION_GAIN` (2) | a 4×4 block of water at 90 °C in a 20 °C tank (M8.8e, `heatedPot`) | `heatedLayer`: other depths, and differences of 1 and 2 °C instead of 70 |
| `REF_DEPTH` (4 cells) | lava creeping visibly with oil slower than water (M8.8g) | `viscousSpread` |
| `REPOSE_FIT` | piles poured from a brush 3 cells wide (M8.8h, `sandPile`) | the lower pile of `hourglass`, poured by a wider stream |
| `AIR.surfaceCoefficient` (40 W/m²·K) | the 50-cell steel block (M8.8d, `coolingBlock`) | `coolingBlock` at a second size: real natural convection grows as a body shrinks (as (ΔT / L)^(1/4) when laminar), the game's coefficient does not (inferred) |

## Effect on M8.1

M8.1's AC18 to AC24 and AC28 are real-world scenarios already (`densityColumn`, `nitrogenOnWater`, `crucible`, `quench` and the bars and walls of AC23 and AC24). M8.9 writes them as `test.todo` with their targets, and M8.1's plan points those criteria to them, each item writing its scenarios' tests before its rows and mechanics. The user approved that change; M8.9's plan makes it.

## Lifecycle

M8.9's plan takes the picked scenarios and points to this doc for the rest: M8.9 writes every other one as a `test.todo` titled with its target, its calculation and sources in a comment beside it, so the tests hold the catalogue. It also names each out-of-reach scenario in the decision or backlog line that rules it out (`docs/decisions.md` already names `uTube`), so that list outlives this doc, and its final commit deletes the doc. A scenario changes state in the commit of the change that changes it.

## Recommendation

M8.9 builds:

1. The five already in the tests, renamed, each with its control.
2. `iceCup`, `steamBurn` and `contactTemp`: on today's elements and expected to pass, they anchor the heat bookkeeping to reality.
3. `heatedLayer`, `hourglass` and `viscousSpread`: the held-out checks of three fitted constants; the first and the last are inferred to fail and then wait for new backlog lines.
4. `redHotBar` and `lavaCrust` (waiting for I26; the full `redHotBar` also for a heat capacity by temperature) and `freeFall` with sand (waiting for grain size): gaps the physical-properties research found, and one it missed, made into tests.
5. Everything else as `test.todo`.

That is fourteen scenarios built, five of them renamed and five expected to wait.

## Decided by the user

- M8.9 builds the Recommendation's fourteen scenarios.
- ALUMINIUM joins M8.1's metals and ACRYLIC goes to M8.2 (it burns), so `iceOnMetal` is built once both exist; no HONEY row (`viscousSpread` uses lava).
- M8.1's plan points its real-world criteria (Effect on M8.1) to the scenarios, and each M8.1 item writes its scenarios' tests before its rows and mechanics.

For the plan, not the user: where the scenes live (`src/scenes.ts` or a module beside it; a scene in `SCENES` falls under the check of `tests/scenes.test.ts` that every cell starts at its element's temperature, which lists its exceptions per scene), the helper that writes a waiting scenario and its companion, the thermometer's bulb (one mark per degree takes 74×74 cells, whose mercury takes minutes to heat through; one mark per 5 °C, 33×33), and whether the full versions (15,000 to 150,000 supersteps each, estimate) stay in `npm test` or get a command of their own once measured.

## Sources

- Lava crusts: Hon, Kauahikaua, Denlinger and Mackay 1994, "Emplacement and inflation of pahoehoe sheet flows", GSA Bulletin 106(3): 351–370, through its use in Speiser 2017, Keck Geology Consortium ([PDF](https://keckgeology.org/wp-content/uploads/2017/Keck%20PDFs%202017/SPEISER.pdf)).
- Viscous spreading: Huppert 1982, "The propagation of two-dimensional and axisymmetric viscous gravity currents over a rigid horizontal surface", J. Fluid Mech. 121: 43–58; the front's formula and η_N = 1.411 from Huppert's lecture notes ([Lecture 6](https://dennou-h.ep.sci.hokudai.ac.jp/arch/fdeps/2004-12-06/huppert/lecture6/pub/Japan6.pdf)).
- Beverloo's law in two dimensions: Carlevaro, Kozlowski and Pugnaloni 2024, Frontiers in Soft Matter ([PDF](https://www.frontiersin.org/journals/soft-matter/articles/10.3389/frsfm.2024.1340744/pdf)).
- Dam break: Ritter 1892, front at 2√(g h₀) on a dry frictionless bed, as reproduced by tilupy's analytic solutions ([docs](https://tilupy.readthedocs.io/en/latest/auto_examples/Analytic_Solutions_Height/plot_as_h_u_ritter.html)).
- Convection onset: the critical Rayleigh number between rigid plates, 1,707.76 (Chandrasekhar 1961, Hydrodynamic and Hydromagnetic Stability); water at 20 °C: expansion 2.07×10⁻⁴ per °C, kinematic viscosity 1.0×10⁻⁶ m²/s, thermal diffusivity 1.43×10⁻⁷ m²/s (handbook values).
- Contact temperature: Wikipedia, [Thermal effusivity](https://en.wikipedia.org/wiki/Thermal_effusivity). Natural convection by size: Incropera et al., Fundamentals of Heat and Mass Transfer.
- Glass expansion: Wikipedia, [Borosilicate glass](https://en.wikipedia.org/wiki/Borosilicate_glass) (3.3×10⁻⁶ per °C, about a third of soda-lime glass's 9×10⁻⁶).
- Acrylic: MakeItFrom, [PMMA](https://www.makeitfrom.com/material-properties/Polymethylmethacrylate-PMMA-Acrylic), and a Xometry datasheet ([PDF](https://xometry.asia/wp-content/uploads/2021/03/1773389463-PMMA-Datasheet.pdf)), which disagree on the specific heat (1.26 and 1.47 kJ/kg·K). Aluminium: Wikipedia, [List of thermal conductivities](https://en.wikipedia.org/wiki/List_of_thermal_conductivities).
- Mercury's expansion, emissivities, settling speeds, surface tensions and contact angles, the Leidenfrost point, flash points, the salt eutectic, thermocouples and refractive indices: the sources of `docs/research/volume-changes.md` and `docs/research/physical-properties.md`.
- Water's latent heats and capacity, steel's, granite's and lava's data: the rows' comments in `src/elements.ts`.
- Steel's heat capacity by temperature: EN 1993-1-2 (Eurocode 3, fire design of steel structures), clause 3.4.1.2, 440 J/kg·K at 20 °C to 5,000 at 735 °C.
- Handbook values (CRC Handbook of Chemistry and Physics, NIST): water's specific heat 4.22 kJ/kg·K at 0 °C, carbon steel's 0.45 to 0.49 kJ/kg·K at room temperature, mercury 13,546 kg/m³ at 20 °C, liquid nitrogen 807 kg/m³ at −196 °C, carbon dioxide 1.84 kg/m³ at 20 °C against air's 1.20.
- Vitest: [`test.fails`](https://vitest.dev/api/#test-fails), [`test.todo`](https://vitest.dev/api/#test-todo) and [`context.annotate`](https://vitest.dev/guide/test-context#annotate), present in the project's Vitest 5.0.5.
