# M5 Heat and phase changes

Status: M5.1 and M5.2 done; next is M5.3a.

## Goal

Everything that is not empty space or wall has a temperature. Heat flows from hot to cold through materials that touch, faster through metal than through stone. Materials change when they get hot or cold enough: ice melts and water boils, steam turns back into water on cold surfaces, lava sets into stone, metal melts, and oil catches fire from hot things. The player heats and cools with two tools, sees temperatures in a heat view, and reads the temperature under the pointer.

## Scope

In: the out-of-block read test (backlog D30), first, as the guard for the new CA phases; a `temp` cell field and the flyer passes' storage-buffer count (D27); heat conduction inside the Margolus block; temperature transitions with latent heat; the elements METAL, STONE, ICE, STEAM, LAVA and MOLTEN_METAL; ignition by heat; the Heat and Cool tools, the heat view, the temperature readout, the glow of hot cells, and B9 (M5 adds seven toolbar buttons, so the toolbar must scroll instead of cutting buttons off); a heat bench scene and heat's share of the frame budget.

Not in M5:

- Heat in empty space (air temperature, cooling in the open): M6's ambient heat on the air grid. Until then a hot cell surrounded by empty space keeps its heat.
- Pressure transitions (M6); radiant heat (with the 2D lighting, `docs/powder-toy.md` "Beyond TPT").
- Heat or reactions acting on a flyer in flight: a flyer carries its whole cell, temperature included, and reacts once it lands, a few dozen supersteps later at most. That settles the M5 half of backlog I13.
- One LAVA element that remembers what it melted from (TPT's `ctype`): with two meltable materials, one molten element per material is pure table rows. When M8 adds more (glass from sand…), the remembered element can live in `kind`'s reserved bits 16–23 (backlog I15).
- D31 (binding or loading fewer fields per pass): an M5.6 lever, used only if the budget is missed.
- B8 (the brush ring's color-only states): the new tools keep the white ring and add no color state. I14 (flyers stopped by gases) stays in the backlog; M5.7 drops its M5 tag.

Ignition by heat adds to contact ignition: oil touching fire still catches at once.

## Choices approved by the user

- An element models a real material with physical properties. One that mimics no real material is defined as such in its row and in `docs/simulation.md`; a generic stand-in is marked as a placeholder.
- WALL is the engine's invincible wall, not a real material: it never moves, burns, melts or conducts heat, and the world's edge is made of it. Real building materials are elements of their own (METAL and STONE in M5, more in M8). The roadmap's "steam condensing on a cold wall" is tested with a cold metal ceiling.
- SMOKE is a placeholder: one gas for every fire, until a smoke mechanic is defined (smoke by what burns, its temperature, how it cools and disperses; backlog I16). M5 gives it stand-in heat values and does not tune its behavior. It keeps the heat of the fire it came from.
- Empty space holds no heat until M6: hot steam and smoke stay hot in the open.
- Lava sets into solid stone; metal melts into its own molten metal, which sets back into metal.
- Phase changes take latent heat, so melting and boiling take time.
- Heat spreads about 20 cells a second through metal at 1x and about 5 through stone; the M5.5 playtest decides whether that is fast enough.

## Terms

- **Dispatch**: one Margolus CA pass. **Superstep**: two dispatches (offset 0, then 1). The 1x speed is 4 supersteps per frame.
- **Stored temperature**: the `temp` word, °C. **Temperature** (`cellTemp`): the stored temperature clamped to the element's thresholds. They differ only while a cell takes in or gives out its latent heat (Design, M5.4).
- **Holds heat**: an element with a conductivity above 0 or a transition. EMPTY and WALL hold none; the `temp` word of a cell that holds no heat means nothing and nothing reads it.
- **κ** (conductivity, 0–1), **C** (heat capacity per cell), **λ** (latent heat per cell, in C·°C units).

## Acceptance criteria

Out-of-block guard (M5.1)

- AC1 WHEN one CA dispatch (offset 0, then separately offset 1) runs from the same seed on a random scene holding every element of the table and on a copy with one cell changed per 4×4 tile, THE SYSTEM SHALL produce bit-identical fields outside the Margolus blocks of the changed cells; WHEN the CA reads a cell outside its block (a test rule reading a far cell, and a patched CA reading the cell right of the block), that check SHALL fail.

Temperature field (M5.2)

- AC2 THE SYSTEM SHALL store a temperature per cell (`temp`, f32, °C) as a fifth cell field, and create every pipeline on a device whose `maxStorageBuffersPerShaderStage` is the default 8 (a test asserts the limit).
- AC3 WHEN a cell is painted, THE SYSTEM SHALL start it at its element's `temperature`; WHEN a scene is loaded without a `temp` field, and WHEN a scene from `src/scenes.ts` is loaded, THE SYSTEM SHALL start every cell at its element's temperature.
- AC4 WHEN a cell moves in the grid or flies, THE SYSTEM SHALL carry its temperature with it, bit for bit.

Conduction (M5.3)

- AC5 WHEN a uniform slab of one element with conductivity κ holds a hot line, THE SYSTEM SHALL grow the variance of the slab's excess heat across the line by κ/(2−κ) per dispatch within 5%, for METAL and for STONE.
- AC6 WHEN a metal bar and a stone bar of the same size start hot at one end, THE SYSTEM SHALL bring the far end of the metal bar 10 °C above its start at least 5 times sooner than the far end of the stone bar.
- AC7 WHEN cells that hold heat touch only empty space and walls, THE SYSTEM SHALL keep their temperatures, and the `temp` words of those empty and wall cells, bit-identical; WHEN two touching blocks of different heat capacities settle, THE SYSTEM SHALL bring both to their capacity-weighted mean temperature within 0.5 °C.
- AC8 WHEN a sealed box of moving and fixed materials, each inside its own temperature range (no transition possible), runs 2,000 supersteps without fire or a heat tool, THE SYSTEM SHALL keep its total heat (sum of C × stored temperature over the cells and flyers that hold heat) within 0.01%.

Phase changes (M5.4)

- AC9 WHEN a block of ice at −20 °C sits beside a lava pool at 1,300 °C, THE SYSTEM SHALL melt the ice into water first (at the first sample with steam, at least a quarter of the ice has melted), then boil part of that water into steam, and set the lava that touched water into stone; the test asserts the melted share, the steam count and the stone count against the first measured run with a 30% margin, stated in its comments.
- AC10 WHEN steam at 110 °C rises against a metal ceiling at −50 °C, THE SYSTEM SHALL condense at least half of the steam into water within a measured number of supersteps; WHEN the ceiling is at 150 °C, THE SYSTEM SHALL condense none.
- AC11 WHEN a metal cell's stored temperature passes 1,538 °C plus its latent width (λ/C), THE SYSTEM SHALL melt it into molten metal; WHEN molten metal rests on a thick cold metal floor, THE SYSTEM SHALL set it back into metal; lava at 1,300 °C SHALL never melt metal.
- AC12 WHEN oil rests on metal at 400 °C, THE SYSTEM SHALL ignite it within a measured number of supersteps; on metal at 100 °C it SHALL not ignite in 2,000 supersteps; oil touching fire SHALL still ignite at once.
- AC13 WHEN a sealed box packed with no empty cell holds ice over water (and, separately, steam over water) whose heat cannot pay a whole latent heat across the interface, THE SYSTEM SHALL settle both sides at the shared threshold and change no cell's element over 500 supersteps, checked every superstep.
- AC14 WHEN a sealed box holds ice, water, steam, stone, lava, metal and molten metal on both sides of their thresholds, THE SYSTEM SHALL keep its total heat, latent heat included, within 0.01% over 2,000 supersteps.
- AC15 IF the table has a conductivity outside [0, 1], a heat capacity of 0 or less, a negative latent heat, a below threshold not under the above threshold, a reversible pair whose threshold or latent heat differs between its two rows, a reversible pair with no latent heat, a transition to a missing element, a threshold outside its target's range, a paint temperature outside its own range, or a threshold plus its latent width outside −273.15 to 9,999 °C, THEN THE SYSTEM SHALL reject the table with an error naming the row.

Seeing and changing heat (M5.5)

- AC16 WHILE the Heat or Cool tool is held, THE SYSTEM SHALL raise or lower the stored temperature of every cell that holds heat inside the stroke by the tool's rate per frame, kept within −273.15 to 9,999 °C, and leave empty and wall cells and the flyers unchanged; the right button SHALL still erase.
- AC17 WHILE the heat view is on, THE SYSTEM SHALL draw each cell that holds heat in a color whose luminance strictly increases with its temperature from −50 to 2,000 °C, draw empty space and walls in neutral colors, and show a legend with labelled temperatures; a toolbar button and the H key SHALL toggle it.
- AC18 WHILE the pointer is over the grid, THE SYSTEM SHALL show the element and the temperature (whole °C) of the cell under it, updated at least 5 times a second, and the element alone for a cell that holds no heat.
- AC19 WHEN a cell of an element without its own `graphics` function holds heat and is hotter than 525 °C, THE SYSTEM SHALL draw it brighter the hotter it is, in the normal view.
- AC20 WHEN the element and tool buttons do not fit the window, THE SYSTEM SHALL let them scroll sideways instead of cutting them off.

Budget (M5.6)

- AC21 WHEN `npm run bench` runs on the idle RTX 4080, THE SYSTEM SHALL spend at most 1 ms more GPU time per 1x frame at 2560×1340 than the M5.1 baseline on each of `tank`, `mix75`, `full100` and `blast`, and at most 1 ms more than the baseline's `full100` on the new `thermal` scene. That 1 ms is heat's share of the 8 ms left after the element engine (`docs/powder-toy.md`, "Frame budget").

Docs (M5.7)

- AC22 WHEN M5 is done, THE SYSTEM SHALL have `README.md`, the help hint in `index.html`, `AGENTS.md`, `docs/simulation.md`, `docs/decisions.md`, `docs/backlog.md`, `docs/powder-toy.md` and `docs/roadmap.md` describing heat and phase changes, with the M5 roadmap entry and this plan deleted.

## Design

### M5.1 Out-of-block guard (D30)

`tests/block-locality.test.ts`, GPU-skipping like the other suites. It runs single CA dispatches without touching production code: it builds its own CA pipeline from the exported `caWGSL(width, height, table, rules, maxFlyers)` and a `Simulation`'s public handles (`fields.writeLayout` and `writeBindGroup`, `elements.layout` and `bindGroup`, `flyers.launchLayout`, `launchBindGroup` and `maxFlyers`), plus its own `{ offset, seed }` uniform buffer and layout, and dispatches `ceil(ceil((W + offset) / 2) / 8)` × the same for H workgroups, as `Simulation.simulate` does.

- **Random scene** from every row of the table under test: a random element and variant per cell (about a quarter empty); `life` in [1, lifeStart] for an element with a lifetime and 0–2 for a liquid; for powders and liquids a velocity of length at most 1 and a remainder in (−1, 1) on each axis; zero motion for the other states (the inert skip relies on it); from M5.2, a random stored temperature in [−50, 1,600] °C for an element that holds heat, 0 for the others. The generator is one function per field, keyed by field name, and throws on a field it does not know, so a new field cannot be left out silently.
- **Perturbed copy**: in each 4×4 tile, one random cell replaced by another random cell.
- Both load the same scene into two `Simulation`s and run one dispatch at offset 0 with the same seed; every field is read back and compared. With every rule confined to its block, the only cells that may differ are those in the offset-0 blocks of the perturbed cells (the union of those blocks is the allowed mask); a block that reads a perturbed neighbor outside itself differs where it must not. The same again with one dispatch at offset 1 on fresh copies. Nothing launches inside one dispatch, and the flyer passes do not run.
- 32 rounds on a 128×96 grid and on a 33×31 grid (odd sizes, so edge blocks stick out), fixed seeds.
- **Negative controls**, both must fail the check: (1) a table with an extra solid element (ID 200, rule `peek`) whose rule reads `loadKind(0u)` (cell 0's kind word) and turns its cell into smoke when cell 0 is sand; the reference has sand in cell 0, the copy water. (2) The generated CA source patched to read the cell right of the block after it is loaded (inserted after the `var rnd = hash2(` line: `if (cellType(readCell(ox + 2, oy)) == EL_SAND) { blk1 = retype(blk1, EL_SMOKE, 0u, 0u); }`), the test asserting the marker line exists before patching. That is the realistic bug: a phase reading across the block border.

Limit: a violation is caught only when it changes a result for the drawn cells; continuous phases (conduction) change something for nearly any out-of-block read, and for discrete ones the 32 rounds over random neighbors make a miss unlikely, not impossible. AGENTS.md's in-place invariant names this test and this limit instead of "no test catches it".

Also in M5.1: the baseline. Lint, typecheck and `npm test` results (existing warnings and failures noted), then the bench: `nvidia-smi` must show the RTX 4080 idle (AGENTS.md), then `npm run bench`. Everything goes in "Baseline (M5.1)" below; every later budget comparison uses these same-day numbers, not M4's.

### M5.2 Temperature field

**Cell format.** `CELL_FIELDS` gains `{ name: 'temp', wgslType: 'f32' }` after `remainder`: the stored temperature in °C. `makeCell` leaves it 0, which means nothing for a cell that holds no heat (the only ones `makeCell` builds outside the brush: empty cells and out-of-bounds walls). `cellTypesWGSL` gets `cellStoredTemp(c)` and `withTemp(c, t)`; `cellEq`, `storeChanged`, the flyer struct and `FlyerSnapshot.cell` pick the field up from the list, and `FLYER_WORDS` becomes 14. TS code reads and writes temperatures through a `Float32Array` view of the `temp` words (`tempView(data)` next to `emptyCellData`); tests read a flyer's `temp` bits the same way.

**D27.** The passes that carry whole cells bind every field plus their own buffers: the launch scatter would bind 4 + 5 = 9 storage buffers, over the default 8 per stage. `launchCounts` and `launchPrefix` merge into one buffer, `launch`: words [0, G) the per-workgroup counts, word G the total, words [G + 1, 2G + 1) the prefix, G = the launch workgroup count. The CA writes the counts and the total (group 3, `ca.wgsl.ts:391-392`), the launch scan reads the counts, writes the prefix at `launch[G + 1 + k]` (the `workgroupScan` helper takes an output offset) and resets `launch[G]` as now, and the scatter reads both through one read-only binding. Storage buffers per stage afterwards: launch scatter, flight, retry and both landings 8, the launch scan 3, the CA, counter and display 6, the brush 5. `tests/gpu.ts` requests only the two buffer-size limits, so every GPU test runs at the default 8, and a test asserts `device.limits.maxStorageBuffersPerShaderStage === 8` so a later change there cannot silently stop checking it; `src/gpu.ts` keeps doing the same, so the game and the tests share the limit. A sixth field would exceed 8 in the whole-cell flyer passes on adapters that report 8 (adapters report 8, 10 or 16 depending on the device, [web3dsurvey](https://web3dsurvey.com/webgpu/limits/maxStorageBuffersPerShaderStage/platform/Chromium%20OS); the RTX 4080 reports 16 in Dawn): a backlog line for M7, where `ctype` is the likely next field and could live in `kind`'s reserved bits instead.

**Table.** `temperature?: number` (°C, default `ROOM_TEMP`, 20): what the brush paints and what a scene loads by default. FIRE's is its flame temperature, 1,000 °C. It takes the spare word, so rows stay 48 bytes (and `src/element-table.ts`'s row comment follows each change of the row size). WGSL `elTemperature(t)`.

**`src/heat.ts`**, like `src/movement.ts`: `ROOM_TEMP`, `ABSOLUTE_ZERO` (−273.15), `MAX_TEMP` (9,999); later `effectiveTemp` (M5.4), the heat ramp and glow constants (M5.5). `src/shaders/heat.wgsl.ts` holds the WGSL from M5.3 on.

**Loading.** `Simulation.load(data)` builds `temp` from `data.kind` and the table when `data.temp` is missing (the `loadScene` path of the tests). The scenes of `src/scenes.ts` always carry every field (`emptyCellData`, checked by `tests/scenes.test.ts`), so `Canvas.fill` writes the element's temperature into `temp` with the kind, and a scene that wants other temperatures overwrites them (a `Canvas` temperature fill). `clear()` zeroes every field as now (all cells empty).

**Brush.** Paints `withTemp(makeCell(t, variant, life), elTemperature(t))`; erase writes an empty cell as now; Replace (Shift) discards the old cell's temperature with the rest of it.

Bench after the field lands: a fifth field adds about a quarter to the CA's loads in awake blocks; the numbers go in "M5.2 results".

### M5.3 Conduction

**Table.** `conductivity?: number` (κ in [0, 1], default 0) and `heatCapacity?: number` (C > 0, default 1). `elementHoldsHeat(e)`: κ > 0, or (from M5.4) a transition; packed as a `holdsHeat` word, which the brush, the display and the conduction read. `elementInert(e)` adds `&& !elementHoldsHeat(e)`: a block with a metal or stone cell is always processed, as AGENTS.md requires of anything that changes a solid by itself. Rows grow to 16 words (64 bytes): the 11 existing words, `temperature`, `conductivity`, `heatCapacity`, `holdsHeat` and one spare.

**Elements.** METAL (ID 7: solid, 7,870 kg/m³, κ 1, C 3.5, toolbar 7) and STONE (ID 8: solid, 2,700, κ 0.1, C 2.2, toolbar 8). WALL keeps κ 0: the invincible wall (Choices) is also the world's boundary (out-of-bounds cells read as walls), so heat never leaves the world and the inert skip still covers walls; its row comment says it mimics no real material. EMPTY keeps κ 0: no air temperature before M6. Existing rows: SAND κ 0.05, C 1.3; WATER κ 0.3, C 4.2 (above its physical rank: it stands in for the convection a resting CA liquid does not have); OIL κ 0.1, C 1.7; SMOKE κ 0.05, C 1.0 (placeholder values, marked as such in its row comment; I16); FIRE κ 0.5, C 1.0. These are tuning grounded in physical ranks, not physical units: a cell is one unit of matter whatever its state, so C is per cell (volumetric data for solids and liquids, tuned for gases) and κ is a share per exchange. Each row's comment says where its numbers come from.

**Test tables move off the new IDs.** `tests/elements.test.ts` (MUD: ID 7, toolbar 7; the exact `ELEMENT` equality; `ROW_BYTES` 48; the toolbar lists) and `tests/element-table.test.ts` (MUD 7, GLOW 8, EMBER 8, MUD toolbar 7) use IDs from 200 and toolbar 50, and the expected values follow the new rows. New test titles start with "M5" (existing titles already use AC5, AC7, AC9, AC10 and AC14 for M4's criteria).

**Phase 7 of the CA, after ignition: pairwise exchanges inside the block.** Four exchanges: rows then columns at offset 0 ((0, 1), (2, 3), (0, 2), (1, 3)), columns then rows at offset 1, so neither axis always goes first. For a pair (a, b):

- g = 2·κa·κb / (κa + κb) when both κ are above 0, else 0 (`select(0.0, …, ka > 0.0 && kb > 0.0)`: the plain formula is 0/0 for two cells that hold no heat, which would write NaN into empty cells);
- d = cellTemp(a) − cellTemp(b);
- stored Ta −= g·d·Cb / (Ca + Cb), stored Tb += g·d·Ca / (Ca + Cb); nothing changes when g or d is 0, so a cell that holds no heat keeps its `temp` word.

Properties: Ca·ΔTa + Cb·ΔTb = 0, so energy is conserved up to f32 rounding; each exchange moves both cells toward their capacity-weighted mean and never past it (d becomes d·(1 − g)) for any g in [0, 1] and any heat capacities, so no conductivity can make it unstable; it reads and writes only the block's cells, guarded by AC1. The exchanges are generated per slot pair in `ca.wgsl.ts` on `blk0`–`blk3`, like the ignition code (never a runtime-indexed array, AGENTS.md); the order switch on `u.offset` is a uniform branch. Over a superstep every cell exchanges with its four neighbors.

Speed: for one element, a unit of heat steps to its pair partner with probability f = κ/2 per dispatch, and its next partner is on the far side unless it stepped, a persistent random walk whose variance grows by f/(1 − f) = κ/(2 − κ) per dispatch and axis. For metal (κ 1) that is 1 cell² per dispatch: heat spreads about 22 cells in a second at 1x and 62 at 8x; for stone (κ 0.1) about 5 and 14. AC5 checks the formula, which is also the check that κ reaches the rule (AGENTS.md "Never"). κ = 1 is the most a per-dispatch exchange allows, so faster heat would need extra conduction-only dispatches (M5.5 gate).

**Scene** `heatBars` in `src/scenes.ts` (tests and `?scene=`): a metal bar and a stone bar, each 48×4 in its own wall channel, the left 6 columns at 500 °C and the rest at 20 °C.

**Tests** (`tests/heat.test.ts`, GPU):

- AC5: a 256×8 slab of one element, a 4-column line at 500 °C on 20 °C; the variance of (T − 20) along x between supersteps 100 and 400 grows by 600·κ/(2 − κ) within 5%, for METAL and STONE (at superstep 400 the metal spread is about 28 cells against the slab's half-width of 128).
- AC6: `heatBars`, the superstep at which the mean of each bar's last 4 columns passes 30 °C, capped at 6,000 supersteps (stone needs about 3,000; the rate ratio is about 19).
- AC7: a hot metal block on a wall floor in empty space keeps every cell's `temp` word, its own and those of the empty and wall cells around it, bit-identical for 500 supersteps; an 8×8 metal block at 500 °C beside an 8×8 stone block at 20 °C in a wall box both end within 0.5 °C of (3.5·500 + 2.2·20) / 5.7 after 2,500 supersteps.
- AC8: a sealed random box of metal, stone, sand, water (1–99 °C), oil (below 250 °C) and empty cells; the total over the cells and flyers that hold heat stays within 0.01% after 2,000 supersteps. The ranges keep it valid once M5.4 adds thresholds.
- `tests/elements.test.ts`: the new properties' validation and packing; the M5.1 generator draws temperatures.

### M5.4 Phase changes

**Table.** `below?: { temp: number; becomes: string; latent?: number }` and `above?: { … }`, λ ≥ 0, default 0.

**Latent heat lives in the stored temperature** (the enthalpy method for melting problems). A cell's stored temperature may pass its threshold while it takes in its latent heat; its temperature is the stored one clamped to [below.temp, above.temp]. Example: water stored at 140 is boiling water at 100 °C that has taken in 40·C of the λ it needs. A cell changes element when its stored temperature passes above.temp + λ/C (or drops below below.temp − λ/C): it becomes the target (`retype`, life = the target's `lifeStart`) at the threshold plus the overshoot times C_old / C_new, so no energy is lost or made. Conduction drives on `cellTemp` and changes the stored value, so melting ice sits at 0 °C and keeps drawing heat at full rate until it has its latent heat. Consequences: phase changes take time; a cell must give back a whole λ to change back, so a boiling surface does not flicker (AC13); energy is conserved through every change (AC14).

A new cell starts inside its target's range, at or past the threshold on the side it came from, so it never reverses direction. A large overshoot can carry it through a second change in the same direction on the next dispatch (ice beside molten metal can become water at a stored temperature already past water's boiling width, then steam), which still conserves energy.

**Phase 8, after conduction**: each cell that holds heat checks its two thresholds. Packed per row: `belowTemp`, `belowWidth` (λ/C), `aboveTemp`, `aboveWidth`, `transitions` (below target in bits 0–7, above target in bits 8–15), which fills the spare and makes 20 words (80 bytes; 20 KiB for 256 rows, under the 64 KiB default uniform binding). An absent threshold is ±3e38, so `cellTemp` is a plain clamp, the checks need no branch, and target 0 is unambiguous (EMPTY, reachable only through a real threshold). TS `effectiveTemp(e, stored)` in `src/heat.ts` mirrors `cellTemp` for tests and the readout.

**Validation** (AC15): κ in [0, 1]; C > 0; λ ≥ 0; below.temp < above.temp; targets exist; a reversible pair (A above → B and B below → A) shares its threshold and λ and has λ > 0 (with λ = 0 a cell at the threshold could flip every dispatch); a threshold lies in its target's range (target's below.temp ≤ T ≤ target's above.temp); an element's `temperature` lies in its own range; every threshold ± its width stays within `ABSOLUTE_ZERO` and `MAX_TEMP`, so the tools' clamp never cuts into a latent range. Unit cases include a stored temperature exactly at a threshold ± width (strict comparisons: no change).

**Rows** (thresholds from physical data, latent heats tuned):

| Element | ID | State | Density | Paint °C | κ | C | Transitions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ICE (toolbar 9) | 9 | solid | 917 | −20 | 0.2 | 1.9 | above 0 → WATER |
| WATER | 3 | | | | | | below 0 → ICE, above 100 → STEAM |
| STEAM (toolbar 11) | 10 | gas | 0.59 | 110 | 0.2 | 2.0 | below 100 → WATER |
| STONE | 8 | | | | | | above 1,200 → LAVA |
| LAVA (toolbar 10) | 11 | liquid | 2,700 | 1,300 | 0.15 | 2.6 | below 1,200 → STONE |
| METAL | 7 | | | | | | above 1,538 → MOLTEN_METAL |
| MOLTEN_METAL (not paintable) | 12 | liquid | 7,000 | 1,600 | 0.6 | 4.0 | below 1,538 → METAL |
| OIL | 5 | | | | | | above 250 → FIRE (one way, no λ) |

Latent heats: physical values per cell would give a cell of steam a water cell's 2,257 J/g, so one condensing cell would heat a metal cell by hundreds of degrees and a cold plate would condense a handful of cells (AC10). Start from water–steam 400, ice–water 300, stone–lava 400, metal–molten 600 (C·°C units) and tune within a factor of 2 to pass AC9–AC11; the row comments record the final values and why.

**Fire and smoke.** `rule_fire` also keeps a burning cell at least at FIRE's temperature (`withTemp(c, max(stored, elTemperature(EL_FIRE)))`): burning releases heat, so fire heats what it touches however it was lit. Oil lit by heat starts at 250 °C and the rule raises it the next dispatch. Smoke keeps the fire's last temperature (`ageCell` retypes and keeps the other fields): hot smoke rising off a fire is what heats a pot hung over it, and it lights oil it touches (above 250 °C). Until M6 nothing cools it in open air, so a smoke cloud stays hot under the grid's top edge. SMOKE stays a placeholder (I16): no test asserts its thermal behavior beyond conservation and the oil it lights.

**Phase order**: 0–3 movement, 4 lifetimes (ignition decided), 5 rules, 6 ignition applied, 7 conduction, 8 transitions. A rule still never sees a cell that ignites or changes phase in the same dispatch.

**Scenes**: `iceLava` (a 10×10 ice block on the floor beside a 30×8 lava pool, in an open-topped 80×60 tank); `steamCeiling` (a closed 40×24 wall box with a 4-row metal ceiling inside it at −50 °C, 4 rows of steam under it and empty space below: half the steam's 160 cells need about 80 × 420 of heat, the ceiling takes about 160 × 3.5 × 150 before it reaches 100 °C); `moltenMetal` (a molten metal pool on an 8-row metal floor at 20 °C).

**Tests** (`tests/heat.test.ts`): cell-level checks first (a cell loaded past a threshold changes on the first dispatch with the overshoot scaled by C_old / C_new; the same-direction chain), then AC9–AC14. A threshold the ACs leave to measurement is set from the first run with a 30% margin, and the test comment states both numbers. AC13 uses boxes packed with no empty cell, ice over water and steam over water between walls (nothing can move there, so any element change at a position is a transition), with temperatures whose heat cannot pay a whole λ across the interface, and reads the `kind` words every superstep. AC14 adds latent heat to the total: `heatContent` in `tests/metrics.ts` sums C·stored + H(element) over the cells and flyers that hold heat, where H comes from the transition graph (for A above → B at T with latent λ, H_B = H_A + (C_A − C_B)·T + λ; one H per connected group, 0 for its first element; validation makes it consistent from either side of a reversible pair).

### M5.5 Seeing and changing heat

Worth a Claude Design canvas before this item: the toolbar grows to about 16 controls in groups, and the heat view brings a new palette and legend. Without one, the layout below is the default.

**Tools.** "Heat" and "Cool" buttons after the element buttons, behind a separator (`toolbar.ts`: a `TOOLS` list rendered after `toolbarEntries`, with a `data-tool` attribute instead of `data-type`; number keys still pick the n-th element). `SimulationInput.heating?: number`: °C per frame, signed, absent or 0 when painting (optional, so `idleInput` and the existing tests compile unchanged); the brush uniform's word 9 (`_pad0`) carries it as an f32, and the brush tests `heating != 0` before painting. While held, every cell that holds heat inside the stroke gets stored += heating, clamped to [`ABSOLUTE_ZERO`, `MAX_TEMP`]; empty and wall cells are untouched; the right button erases. With a tool selected `main.ts` sets `replacing` to false, since the flyer brush removes flyers whenever `replacing` is set (`flyers.wgsl.ts` `flyerBrushWGSL`). Rate: about 1,000 °C per second (17 °C per frame), tuned at the gate. A cell pushed past a threshold changes on the next dispatch: it holds heat, so its block is never skipped.

**Heat view.** A toolbar toggle "Heat view" (`aria-pressed`) and the H key (ignored with Ctrl, Meta or Alt held, unlike the number keys of B11); `DisplayOptions.heatView?: boolean` (optional, for the existing display test), in the display uniform's padding. In the heat view a cell that holds heat is drawn as `heatColor(cellTemp)`, empty space as the background, a cell that holds no heat (wall) at 30% of its color. `HEAT_RAMP` in `src/heat.ts`: knots (°C, linear RGB) with strictly increasing luminance, from dark blue at −50 through purple at 20, red at 300, orange at 800 and yellow at 1,500 to near white at 2,000 and above; it generates both the WGSL `heatColor` (piecewise linear) and the legend's CSS gradient. The legend, a small bar labelled −50, 0, 100, 500, 1,000 and 2,000 °C, sits above the toolbar's right end and shows only in the heat view. Hue never carries the meaning alone (the user is red-green colorblind): the brightness order, the legend's labels and the readout do. A flyer is drawn over an empty cell from its `kind` word only, with the empty cell's meaningless `temp`, so flyer-substituted cells get no glow and take their element color in the heat view (backlog line).

**Readout.** `Simulation.probe(encoder, x, y)` appends two 4-byte copies (the cell's `kind` and `temp` words) into a 16-byte staging buffer at the end of the frame's encoder, so there is no extra submit; `readProbe()` maps it, one probe in flight, like the particle counter. `main.ts` probes every 100 ms while the pointer is over the grid and writes "Lava · 1180 °C" into a new info span (label from the table, `effectiveTemp` from `src/heat.ts`), or the label alone for a cell that holds no heat.

**Glow.** In the normal view a cell that holds heat above 525 °C (where hot things start to glow) gets a glow color added to its own, scaled by a weight that rises with temperature: dull red at 525, orange at 1,000, yellow-white from 1,600, clamped to 1. Adding never darkens a light base color (smoke), where blending toward dull red would. Elements with their own `graphics` function (fire) draw themselves and get no glow. Constants in `src/heat.ts`.

**Toolbar (B9).** `#tool-buttons` becomes a flex container (`flex: 1 1 auto`, `min-width: 0`, `overflow-x: auto`, thin scrollbar) holding the element and tool buttons; the info spans and the speed and Clear controls keep their places. No `data-tip` tooltip inside it: the scroller would clip it.

**Heat speed.** If the gate finds heat too slow, the lever is extra conduction-only dispatches per superstep (reading `kind` and `temp` only); each adds the spread of one CA dispatch, and its cost is measured in M5.6 before it is offered (the bench's `maxPasses` count grows with them).

**Tests**: `tests/display.test.ts`: table colors at 20 °C (its scene sets fire's `temp` to 20, now that loading defaults to 1,000), fire still by its `graphics`; metal brighter at 1,500 than at 800 than at 20 °C (AC19); in the heat view, luminance strictly increasing over −50, 0, 20, 100, 300, 600, 1,000, 1,500 and 2,000 °C, and wall and empty independent of temperature (AC17). Brush tests: the rate, both clamps, empty and wall untouched, flyers kept, erase unchanged (AC16). A probe test reads back a known cell (AC18). `tests/elements.test.ts`: tools after the elements. The browser check covers what render tests cannot: the H key and the button, the legend, the readout's refresh, the scroll at 1,280 px wide, and no WebGPU error, on the user's dev server (or one started for the check).

### M5.6 Budget

Bench scene `thermal`: every cell inside a wall frame a random mix of metal, stone, water, ice, lava and sand, the top half at 1,300 °C and the bottom half at −20 °C, so heat flows and phases change through the 20 warm-up and 60 measured frames after each load.

Compared per AC21 against "Baseline (M5.1)". Levers in order if a scene is over:

1. A thermal-quiet skip: a block whose cells are all empty or solid, with no lifetime or rule, is skipped when the temperatures of its heat-holding cells are equal and every one's stored temperature lies inside [below.temp − width, above.temp + width] (otherwise a uniformly heated block, painted by the Heat tool or loaded hot, would never change phase); a test shows a uniform block above its threshold still melting with the lever on.
2. D31's loads: a cell loads `velocity` and `remainder` only when its state falls, and `temp` only when it holds heat. It needs the skipped words to be zero in memory: true for motion today; for `temp`, every path that writes a cell that holds no heat (swaps, `retype` to such an element, erase, launch, `Simulation.load` and `Canvas`, which since M5.2 start empty cells at EMPTY's 20 °C) must write 0.
3. Otherwise a gate: the numbers and what each further lever would cost.

Results in "M5.6 results"; `docs/powder-toy.md` gets the measured table with heat and heat's share.

### M5.7 Docs and finish

- `README.md`: features (heat, phase changes, tools, heat view), controls (number keys, tools, H), the new `?scene=` names. `index.html`: the help hint (tools, H).
- `AGENTS.md`: layout (`src/heat.ts`, `src/shaders/heat.wgsl.ts`, `tests/heat.test.ts`, `tests/block-locality.test.ts`); invariants (the cell format with `temp`; `elementInert` with heat; the phase order; WALL and EMPTY hold no heat; the out-of-block test and its limit); "Adding an element" (temperature, conductivity, heat capacity, transitions and latent heat, the validation rules, and the first rule of Choices: a real material with physical properties, or a row that says it mimics none or is a placeholder); the `npm run bench` line (the `thermal` scene).
- `docs/simulation.md`: cell format, element table and its new columns (WALL defined as the invincible wall, SMOKE marked as a placeholder), phases 7 and 8, a Heat section (intuition, example, formula), the tools and the heat view.
- `docs/powder-toy.md`: 20 bytes per cell instead of 16, the "Heat conduction" row of the mapping table (exchanges inside the CA block, not a pass of its own), the frame budget from M5.6.
- `docs/decisions.md`, only what passes its test: "Heat moves by pairwise exchanges inside the Margolus block" (rejected: a separate stencil pass, which needs a second temperature buffer or a red-black order that breaks per-step energy conservation, and an extra pass over the grid); "Latent heat is stored past the threshold" (rejected: instant transitions with a hysteresis gap, which flicker or create energy). The per-cell-fields entry's "later temperature…" and the movement entry's consequence paragraph (a flyer carries its temperature and reacts when it lands) follow.
- `docs/backlog.md`: delete D27 (in M5.2c), D30 (in M5.1c) and B9; I13 keeps only its M6 part; I14 loses its M5 tag; D31 updated with M5's numbers, or deleted if M5.6 used it; add flyers drawn without glow or heat colors, and conduction-only dispatches if the gate deferred them (the sixth-field storage limit is added by M5.2c, I15 already exists).
- `docs/roadmap.md`: delete M5. This plan: deleted in the final commit.

### Edge cases and failure modes

- A zero `temp` from `clear()` or `makeCell` only reaches empty cells and out-of-bounds walls, which hold no heat; the conduction guard keeps their words untouched, so no NaN can appear.
- A scene loaded with a temperature past a threshold changes on its first dispatch (its block is never skipped).
- A cell that becomes empty (a lifetime ending in EMPTY) keeps a meaningless `temp`; nothing reads it, and the display gives a flyer drawn over it no glow.
- Steam and hot smoke keep their heat in open air until M6; a steam cloud under the grid's top edge stays steam, since the edge is an insulating wall.
- Erasing a hot area removes its heat with the cells; Replace paints at the new element's temperature.
- f32: an exchange smaller than half an ulp of the stored value (about 0.0005 °C at 10,000 °C) rounds away; that only leaves the last fraction of a degree unequalized and stays inside AC8's 0.01%.
- Determinism: no new randomness; the exchange order depends only on the offset.
- A flyer carries its temperature but does not exchange heat or change phase until it lands.

## Checklist

### M5.1 Out-of-block guard (tasks)

- [x] M5.1a Baseline: lint, typecheck and `npm test` results; `nvidia-smi` idle, `npm run bench`; all into "Baseline (M5.1)".
- [x] M5.1b `tests/block-locality.test.ts` per Design: its own single-dispatch CA pipeline, the field-keyed random scene, the perturbed copy, the mask check at both offsets on both grids, both negative controls. It passes on the current code. Verify: `npm test`, `npm run lint`, `npm run typecheck`.
- [x] M5.1c Docs: the AGENTS.md in-place invariant names the test and its limit; D30 deleted from the backlog.

Visible after: nothing: a new test only.
Needs you: nothing, unless the RTX 4080 is busy when the bench runs (then closing the game or wallpaper using it).

### M5.2 Temperature field (tasks)

- [x] M5.2a D27: `launchCounts` and `launchPrefix` merged into `launch`; every flyer test and both determinism tests pass unchanged. Verify: lint, typecheck, `npm test`.
- [x] M5.2b The `temp` field, the `temperature` row property and its packing, `src/heat.ts`, `withTemp` and `cellStoredTemp`, `tempView`, the loading default, `Canvas` temperatures, the brush's paint temperature; the M5.1 generator draws temperatures. Tests: AC2 (the limit assertion), AC3 (painted fire at 1,000 °C; a `loadScene` without `temp` and `?scene=damBreak`'s fields both load water at 20 °C), AC4 (a falling grain and a flyer keep a marked `temp`). Verify: lint, typecheck, `npm test`, build, bench into "M5.2 results".
- [x] M5.2c Docs: `docs/simulation.md` cell format, the AGENTS.md cell invariant; backlog: D27 deleted, the sixth-field limit added.

Visible after: nothing: cells carry a temperature that nothing reads yet.
Needs you: nothing.

### M5.3 Conduction (tasks)

- [ ] M5.3a `conductivity`, `heatCapacity`, `elementHoldsHeat` and the `holdsHeat` word, the inert rule, validation and 64-byte packing; METAL (7) and STONE (8) rows; the test tables of `tests/elements.test.ts` and `tests/element-table.test.ts` moved to IDs from 200, their expectations updated; the M5.1 generator's stand-in `holdsHeat` (every element but EMPTY and WALL) replaced by `elementHoldsHeat`. Verify: lint, typecheck, `npm test`.
- [ ] M5.3b Phase 7 in `ca.wgsl.ts` with `src/shaders/heat.wgsl.ts`; the `heatBars` scene, with the `Canvas` temperature fill it is the first user of; AC5–AC8 tests (`tests/heat.test.ts` exists from M5.2); AC1 still passes. Verify: lint, typecheck, `npm test`, build, bench into "M5.3 results".
- [ ] M5.3c Docs: `docs/simulation.md` (columns, phase 7, Heat section), AGENTS.md (the inert rule).

Visible after: Metal and Stone buttons in the toolbar. Heat itself stays invisible until the heat view (M5.5).
Needs you: nothing.

### M5.4 Phase changes (tasks)

- [ ] M5.4a `below` and `above` with latent heat, `cellTemp` and `effectiveTemp`, 80-byte packing, validation; AC15 unit tests. Verify: lint, typecheck, `npm test`.
- [ ] M5.4b Phase 8; the ICE (9), STEAM (10), LAVA (11) and MOLTEN_METAL (12) rows and the changed rows; oil ignited by heat; fire's flame temperature; the cell-level transition tests and AC12. Verify: lint, typecheck, `npm test`.
- [ ] M5.4c The `iceLava`, `steamCeiling` and `moltenMetal` scenes; AC9–AC11, AC13 and AC14 tests; latent heats tuned and recorded in the rows. Verify: lint, typecheck, `npm test`, build, bench into "M5.4 results".
- [ ] M5.4d Docs: `docs/simulation.md` (rows, phase 8, latent heat, fire and smoke), AGENTS.md (the phase order).

Visible after: Ice, Lava and Steam buttons. Ice melts, water boils and freezes, steam turns to water on cold metal, lava sets into stone, metal melts, and oil catches fire from hot metal, lava or hot smoke; `?scene=iceLava`, `?scene=steamCeiling` and `?scene=moltenMetal` show it. Temperatures themselves stay invisible until M5.5.
Needs you: nothing (the playtest is M5.5's gate).

### M5.5 Seeing and changing heat (tasks)

- [ ] M5.5a Heat and Cool tools: `TOOLS`, `SimulationInput.heating`, the brush, `replacing` off for tools; AC16 tests. Verify: lint, typecheck, `npm test`.
- [ ] M5.5b Display: heat view, legend, glow, `HEAT_RAMP`; AC17 and AC19 render tests. Verify: lint, typecheck, `npm test`, build.
- [ ] M5.5c Readout: `probe`, `readProbe`, the info span; AC18 probe test. Verify: lint, typecheck, `npm test`.
- [ ] M5.5d Toolbar scroll (AC20).
- [ ] M5.5e Browser check per Design, then the gate.

Visible after: Heat and Cool tools, a heat view (button or H) with a legend, the element and temperature under the pointer in the toolbar, and hot things glowing; on a narrow window the toolbar's buttons scroll.
Needs you: the playtest gate (steps in the item's report): melt metal with the Heat tool, pour lava into water, watch heat cross the metal and the stone bar of `?scene=heatBars` in the heat view, and say whether heat moves fast enough and whether the heat view reads well.

### M5.6 Budget (tasks)

- [ ] M5.6a The `thermal` bench scene; run; AC21; the levers per Design if needed; "M5.6 results".
- [ ] M5.6b `docs/powder-toy.md` frame budget with the measured heat numbers.

Visible after: nothing new: the frame time with heat everywhere is measured and within its share.
Needs you: an idle RTX 4080 for the bench; a decision only if the budget is still missed after the levers.

### M5.7 Docs and finish (tasks)

- [ ] M5.7a Docs per AC22 and Design; the roadmap's M5 deleted; this plan deleted in the final commit.

Visible after: nothing.
Needs you: nothing.

## Baseline (M5.1)

Taken before any M5 change, on the RTX 4080 (`nvidia-smi`: 1–3% utilization, only desktop apps, no game or wallpaper).

- Lint: clean. Typecheck: clean. `npm test`: 10 files, 89 tests pass, 0 skipped. (One earlier `npm test` run, started right after `lint` and `typecheck` in the same command, failed all 10 files with `Cannot read properties of undefined (reading 'config')` at the first `describe`; it did not recur in the later runs.) With M5.1b: 11 files, 93 tests.
- Build: clean.
- `npm run bench`, GPU ms per frame, median of 60 frames (one compute pass, as the game records it):

| Scene | 1x | 2x | 4x | 8x |
| --- | --- | --- | --- | --- |
| tank | 0.39 | 0.92 | 1.90 | 3.47 |
| mix75 | 1.05 | 2.03 | 3.60 | 5.18 |
| full100 | 0.98 | 1.90 | 3.60 | 6.29 |
| blast | 0.33 | 0.52 | 1.05 | 2.16 |

- 1x by pass, ms (mean per frame, each pass in its own compute pass):

| Scene | ca0 | ca1 | launch scan | launch scatter | flight | land 1 | retry | land 2 | compact scan | compact scatter | sum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tank | 0.096 | 0.123 | 0.075 | 0.032 | 0.023 | 0.009 | 0.020 | 0.012 | 0.003 | 0.021 | 0.414 |
| mix75 | 0.411 | 0.415 | 0.081 | 0.036 | 0.027 | 0.019 | 0.039 | 0.013 | 0.007 | 0.012 | 1.059 |
| full100 | 0.381 | 0.399 | 0.086 | 0.029 | 0.016 | 0.015 | 0.012 | 0.015 | 0.007 | 0.011 | 0.972 |
| blast | 0.097 | 0.092 | 0.036 | 0.029 | 0.022 | 0.020 | 0.012 | 0.007 | 0.004 | 0.014 | 0.333 |

- Simulation creation: 512–519 ms for the first one of a size (pipeline compile), 3–7 ms after.
- AC21's budget, from the 1x medians: tank ≤ 1.39, mix75 ≤ 2.05, full100 ≤ 1.98, blast ≤ 1.33 ms; `thermal` ≤ 1.98 ms.

## M5.2 results

Same machine and conditions as the baseline (`nvidia-smi`: 4% utilization, desktop apps only).

- Lint, typecheck and build: clean. `npm test`: 12 files, 104 tests pass (the 93 of the baseline unchanged, 11 new: AC2 in `tests/gpu.test.ts`; the temperature's default, packing and validation in `tests/elements.test.ts`; every scene's temperatures in `tests/scenes.test.ts`; AC3 and AC4 in the new `tests/heat.test.ts`).
- Choices made in M5.2b: `cellEq` and `storeChanged` compare an `f32` field by its bits (`bitcast<u32>`), because as floats −0 equals 0 and `storeChanged` skipped a moved −0, which broke AC4's bit-for-bit carry (the AC4 test has a −0 grain over empty cells at +0 and fails without it). Empty cells loaded without `temp`, and the empty cells of `src/scenes.ts`, start at EMPTY's temperature (20 °C), as AC3 reads "every cell"; the brush's eraser, `makeCell` and Clear leave 0. The table validates `temperature` against `ABSOLUTE_ZERO`..`MAX_TEMP` already (AC15 adds the range checks of M5.4).
- `npm run bench`, GPU ms per frame, median of 60 frames (two runs; the second run's 1x medians were the same within 0.07 ms):

| Scene | 1x | 2x | 4x | 8x | 1x vs baseline |
| --- | --- | --- | --- | --- | --- |
| tank | 0.46 | 0.98 | 1.97 | 3.67 | +0.07 |
| mix75 | 1.31 | 2.49 | 4.06 | 5.51 | +0.26 |
| full100 | 1.18 | 2.29 | 4.13 | 7.08 | +0.20 (+0.27 in run 2) |
| blast | 0.33 | 0.59 | 1.18 | 2.29 | 0.00 |

- 1x by pass: the two CA dispatches went from 0.83 to 1.03 ms on `mix75` and from 0.78 to 0.95–1.00 ms on `full100`, the quarter the fifth field was expected to add; the flyer passes stayed within noise (each under 0.13 ms).
- Simulation creation: 516–524 ms for the first one of a size, 3–9 ms after, as in the baseline (the first run after the change took 870–945 ms while the driver compiled the new shaders).
- Every scene stays inside AC21's budget (tank ≤ 1.39, mix75 ≤ 2.05, full100 ≤ 1.98, blast ≤ 1.33 ms), with 0.7–1.0 ms left for conduction and phase changes.

## M5.3 results

To be filled by M5.3b.

## M5.4 results

To be filled by M5.4c.

## M5.6 results

To be filled by M5.6a.
