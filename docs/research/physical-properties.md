# More physical properties

Research, not a plan: the roadmap schedules these candidates, but how each works is not decided. It gathers physical properties, and the mechanics that would use them, beyond those the element table has after M8.8 (conductivity, heat capacity, latent heat, density by temperature, viscosity, angle of repose, fracture toughness) and those M8.1 adds (thermal expansion and stiffness, for thermal shock). For each: what a player would see, the physical data, a sketch of the mechanism, its cost in this engine and its slice in `docs/roadmap.md` (its Fits line). Volume changes are backlog I22's subject (`docs/research/volume-changes.md`, roadmap M12.5, to be confirmed) and are left out. A candidate stays here, with its data and open questions, until its slice's plan is written, then leaves this doc; the doc is deleted when none is left.

Figures are physical data from the sources at the end. "Estimate" marks what is extrapolated from them or from the bench, "inferred" what is reasoned and not measured.

## The scale decides what shows

One cell is 1.36 mm and one dispatch 2.08 ms (`src/physics.ts`), so the CA's top speed, one cell per dispatch, is 0.65 m/s, and a 2560×1340 grid is a box 3.5 m wide and 1.8 m high. Taking the world as one cell deep, a cell is 2.5 mm³: a water cell weighs 2.5 mg, a steel cell 20 mg.

At this size, what acts on surfaces rivals weight: surface tension (water's capillary length is 2.7 mm, two cells), capillary rise into sand and narrow gaps, air drag on fine grains and, above a few hundred °C, radiated heat. Materials are strong for their weight (weight shrinks with the cube of the size, strength with its square), so stone and steel do not break under their own weight on screen. What barely shows: weather (air holds little vapor), diffusion (slower than any flow) and real-speed sound (D33).

## Cost in this engine

- **A table column** (a number per element) costs nothing to store. The table is one uniform buffer of 256 rows of `ROW_BYTES` (`src/element-table.ts`), and WebGPU's default uniform binding is 64 KiB, which `src/gpu.ts` does not raise, so a row can grow to 64 words, nearly twice what M8.8's columns make it; its padding words are free columns. The cost is the rule that reads it.
- **Per-cell state** is the costly kind. A new field costs about what the temperature did, 0.2 ms per 1x frame on the busy bench scenes (`docs/powder-toy.md`, "Frame budget"), and fails pipeline creation until D32. Spare bits exist (below).
- **Per-air-cell state** is cheap, 1/16 of the cells at the default 4×4, but the air's `vec4f` (the speeds at two faces, pressure, temperature) is full (`AirGrid`, `src/air-grid.ts`). A fifth value widens the state rather than adding a buffer, since the CA is at 8 storage buffers (D32). The four air passes cost 0.14–0.30 ms; a state twice as wide adds an estimated 0.1–0.2 ms. M8.2's oxygen in the air needs the same widening (inferred).
- **Far-reaching questions** ("is this piece still attached?") spread one cell per dispatch through per-cell state inside the CA's block rule, or take extra passes. A field over the whole world (gravity, magnetism) is a solve on a coarse grid, about 0.5–1 ms (the estimate for M9, `docs/powder-toy.md`).

### Spare bits per cell

| Where | Free | Candidates that want it |
| --- | --- | --- |
| `life` of powders | all 32 bits | moisture; age; distance travelled |
| `life` of solids | all 32 bits | support |
| `life` of gases | all 32 bits | none |
| `life` of liquids | bits 2–31 (bits 0–1 hold the spread direction) | a dissolved amount (M8.4); age; a depth estimate (Surface tension; the spreading by depth and the convection onset that the `viscousSpread` and `heatedLayer` scenarios wait on, backlog I35 and I29, roadmap M12.6, inferred) |
| `life` of an element with a lifetime (fire) | the bits above the lifetime | none |
| `kind` bits 24–31 | 8 bits after M8.1's `ctype` in bits 16–23; I22's research proposes them for an amount of matter, though a thermometer needs about 11 for marks 5 °C apart and 13 to read to the degree (`docs/research/volume-changes.md`, Storage) | peak temperature; the supercooling bit |
| `kind` bits 8–15 (`variant`) | random at paint time, read by no rule; the display draws it as the per-grain shade | the dye view, which would share its bits with the shade |

`withType` (through which `retype` goes) writes the whole `kind` and `life` words, `withLife` the whole `life` word, and `cellLife` returns the whole word to its readers (`spreadRow`, the lifetimes, fire's color), so sharing them needs masked writes and reads. The `velocity` and `remainder` words of a solid are not free: the inert-block skip and the launch count rely on their being 0 (`AGENTS.md`, "Invariants").

## Candidates

Ranked by what a player would see for the cost. The cost labels are judgments, unmeasured unless a bench figure is quoted.

| Property | A player sees | Cost | Fits |
| --- | --- | --- | --- |
| Grain size | flour drifts, gravel ignores wind, water drains fast through gravel | free | M12.1 (I34) |
| Emissivity (radiated heat) | hot things cool at their real speed | negligible now; the rest with the lighting work | M12.2 (I26); warming, M14 |
| Heat capacity by temperature | a red-hot steel bar cools at its real pace | small at run time; the work is the heat bookkeeping | M12.3 (I30) |
| Leidenfrost point (film boiling) | drops skate on a hot pan; liquid nitrogen skitters | negligible | M12.4 |
| Porosity (moisture) | sand castles, wicking, drainage, wet wood | small | M12.7 |
| Surface tension and wetting | drops, beads, drips; puddles stop spreading | small; the rule is uncertain | M12.7 |
| Erosion threshold | channels, deltas, overtopped sand dams fail | small | M12.8 |
| Strength (support) | loose pieces fall; weak shelves break | moderate | M12.9 |
| Restitution | bounces, splashes, craters | small; work in the flyer passes | M12.10 |
| Magnetism | iron filings, magnets, the Curie point | a world field | M16 |
| Supercooling limit | slush; freezing rain | negligible | M12.11 |

### Grain size

- **Sees**: flour hangs and drifts on the slightest air movement; gravel ignores the Wind tool; water drains through gravel tens of times faster than through sand, and through clay not at all (with Moisture); fine dust burns in a flash (M8.2).
- **Physics**: a grain's settling (terminal) velocity in air `v_t` sets the linear drag that gives it, `drag = gravity / (v_t + gravity)` in cells per dispatch (the grid's terminal speed is `gravity (1 − drag) / drag`, `velocityRule`). A natural sand grain of 0.3 mm settles at about 2 m/s (3 cells per dispatch: `drag` about 1/100), flour of 50 µm at 0.07–0.1 m/s (`drag` about 0.17–0.23), natural gravel of 5 mm at about 12 m/s (`drag` about 1/600; its 18 cells per dispatch are above the flyers' cap of 16, `MOVEMENT.maxFlyerSpeed`, which then decides); smooth spheres settle up to 1.5 times faster. `DEFAULT_DRAG` (1/64) is a terminal velocity of 2 cells per dispatch, 1.3 m/s. The size also sets how fast water drains down through a pile under its own weight, the hydraulic conductivity: sand 10⁻⁵ to 10⁻³ m/s (0.01 to 0.7 cells a second), gravel 3×10⁻⁴ to 3×10⁻² m/s (0.2 to 20 cells a second), clay 10⁻¹¹ to 5×10⁻⁹ m/s, effectively never. Kozeny–Carman gives it from the grain size d and the porosity φ (permeability `k = d² φ³ / (180 (1 − φ)²)`, drainage at `k ρ g / μ`): 0.3 mm sand at φ 0.38 drains at about 0.7 mm/s, half a cell a second. It also sets the erosion threshold (Erosion) and how fast a dust burns (M8.2, below).
- **Mechanism**: `grainSize` (m) on powder rows; `elementDrag` derives a powder's drag from it and the density of its grains, as `crushPressure` derives from toughness, and validation rejects a hand-given drag on a powder. The row's `density` will not do as it is: SAND's 1,600 kg/m³ is a bulk density with its pores counted (Moisture), while GUNPOWDER's 1,700 is its grains' (its row comment). The grain density is the bulk density over (1 − porosity), so a powder row needs a porosity (Moisture's column) or a grain density of its own. Liquids keep `drag`; their analog is a droplet size (a 2 mm raindrop settles at about 6.5 m/s).
- **Cost**: free at run time: two columns (the grain size, and a porosity or a grain density) replace the hand-given `drag`. Sand's drag goes from 1/64 to about 1/100, so sand falls faster and launches sooner: the tests built on `DEFAULT_DRAG` (`tests/elements.test.ts` asserts it for every default row, and grains timed to launch after 48 supersteps in `tests/simulation.test.ts`, `tests/heat.test.ts` and `tests/display.test.ts`) are re-measured, and blasts may launch more flyers (unmeasured). The `freeFall` scenario is measured again too, and likely `hourglass` and `sandPile` (inferred); their targets stay.
- **Fits**: M12.1 (backlog I34, which the `freeFall` scenario waits on), after M8.1, whose rows show it (gravel, sawdust, snow, broken glass; on its own it changes only sand and gunpowder), and before M8.2, which brings more (flour, dust) and burns dust by it.

### Radiated heat

- **Sees**: hot things cool at their real speed: a lava pool skins over in seconds, a glowing steel block dulls within a couple of minutes. With the lighting work, heat crosses gaps: ice melts beside lava without touching it.
- **Physics**: a surface radiates `ε σ (T⁴ − T_env⁴)`, ε its emissivity from 0 to 1. As a coefficient (divided by `T − T_env`), for ε = 0.8 into 20 °C: 7 W/m²·K at 100 °C, 11 at 200 °C, 33 at 500 °C, 121 at 1,000 °C, against natural convection's 5–25 for objects from a centimetre to a metre. The cell–air exchange (`AIR.surfaceCoefficient`) is convection only: the steel block 50 cells wide at 500 °C in `tests/air-heat.test.ts` cools at an effective 9.2 W/m²·K, so the hotter a thing, the slower it cools against reality. The same file's 16×16 metal block (a bar 2.2 cm square) goes from 1,000 to 944 °C in 125 s; an oxidized steel bar would be near 600 °C at the METAL row's constant heat capacity and near 740 °C at steel's real one (Heat capacity by temperature; estimate: lumped cooling with both terms). Real lava grows a solid skin within seconds (Hon et al. 1994's crust growth); at 1,150 °C radiation (ε 0.9) carries 12 to 18 times what still air does, so the game's lava, cooled by convection alone, skins over many times more slowly (estimate). Emissivity: polished copper 0.01–0.05, polished steel 0.07–0.2, oxidized steel 0.6–0.9, glass 0.92–0.94, sand 0.9, water 0.95–0.98, snow 0.96–0.98, basaltic lava 0.8–0.95 (rarely measured; lower as the melt heats).
- **Mechanism**: the loss goes in `airExchangeWGSL`, which owns each cell once per frame: a heat-holding cell with an open neighbor relaxes toward room temperature with a radiative coefficient `ε σ (T² + T_room²)(T + T_room)` per open face (in kelvin: `T⁴ − T_room⁴` over `T − T_room`), its share folded over the frame's supersteps as the exchange folds its own (`1 − (1 − g)^n`). An explicit loss per frame would overshoot near the top of the range (a cell of capacity 1 with four open faces at 9,999 °C loses more than its whole excess in one 1x frame, estimate); the folded share never passes room temperature, at any speed. It is first order: it holds the coefficient at the frame's starting temperature, exact to well under a degree for steel at 1,600 °C but over-cooling where a frame takes thousands of degrees off, which needs the exact solution of the T⁴ law there. The heat goes either out of the world, as to a cold sky (the sealed-box heat tests then count it, or run at ε = 0), or into the air cell, which is wrong (air is transparent to it) and, at 1.2 kJ/m³·K, would overheat the air and strengthen the plume (I19); out of the world is the sketch. The full form carries the heat on the lighting work's light field (`docs/powder-toy.md`, "Beyond TPT"), each surface absorbing by its emissivity (Kirchhoff's law: absorptivity equals emissivity at the same wavelengths).
- **Cost**: negligible: one power per exposed heat-holding cell per frame.
- **Fits**: M12.2 (backlog I26), as a term of the cell–air exchange; carrying the heat to what it reaches is M14's light field.

### Heat capacity by temperature

- **Sees**: a red-hot steel bar cools at its real pace and lingers near 735 °C, where its crystal structure changes: with radiated heat, a bar taken out of a forge at 1,000 °C is near 740 °C two minutes later, not near 600 °C.
- **Physics**: steel holds 440 J/kg·K at 20 °C, 760 at 600 °C, about 5,000 at a peak near 735 °C, and 650 above 900 °C (EN 1993-1-2, measured on heating; on cooling the change comes somewhat lower, inferred). The METAL row's constant 3.5 MJ/m³·K is iron at 20 °C, so a bar cooling from 1,000 °C holds far less heat than real steel: the `redHotBar` scenario puts it at 578–650 °C after 125 s with the row's capacity and 720–750 °C with steel's real one, both with radiation (estimates). Water's capacity moves under 1% from 0 to 100 °C (4.22 to 4.18 kJ/kg·K), so most rows keep one number.
- **Mechanism**: capacity knots on a row (`[°C, MJ/m³·K]`, linear between and flat outside, as `densityKnots`), or, for steel's peak, a latent range with no change of element: a few degrees over which the cell takes in heat without warming, as the thresholds already do for phase changes (inferred). With a capacity that follows temperature, a cell's heat is the integral of its capacity over temperature, not C·T, so `exchangeHeat` and `heatShare`, `airExchangeWGSL`, the capacity ratios of `transitionCell` and the tests' `heatContent` work on that integral.
- **Cost**: small at run time (a lookup per exchange, estimate); the work is the heat bookkeeping and its tests.
- **Fits**: M12.3 (backlog I30), after radiated heat; the full `redHotBar` scenario waits on both. Its plan designs the heat bookkeeping that M12.7, M8.4 and, if confirmed, M12.5 extend (Open questions).

### Film boiling

- **Sees**: water dropped on a pan above about 200 °C skates around on its own vapor and outlasts a drop on a 150 °C pan many times over: the hotter pan boils it more slowly. Liquid nitrogen (M8.1) poured on the floor beads up and skitters; water poured onto lava does not flash at once.
- **Physics**: above a liquid's Leidenfrost point, a film of its vapor separates it from the hot surface: heat transfer drops by an order of magnitude and the liquid slides freely. Water on polished steel: about 185 °C (150–265 °C across studies, with roughness and drop size), where a drop's lifetime peaks (measured on drops of tens of µL; a cell is 2.5 µL, so a cell's lifetime is shorter, estimate). Liquid nitrogen: about −160 °C, 30–50 K above its boiling point, so any room-temperature surface.
- **Mechanism**: in `exchangeHeat` (phase 7), a pair of a liquid and a hotter cell whose `cellTemp` is above the liquid's Leidenfrost point exchanges at a fraction of its share (a film factor, fitted so a water cell on a 250 °C plate outlasts one on a 150 °C plate by the measured ratio); in `velocityRule` (phase 1), such a liquid cell resting on the hot cell takes a small random sideways velocity. Both stay inside the block.
- **Cost**: negligible.
- **Fits**: M12.4, after M8.1 brings liquid nitrogen.
- **Open**: the film's collapse when molten metal meets water (a steam explosion) is a mechanic of its own.

### Moisture

- **Sees**: sand soaks up water and darkens; damp sand stands in steep walls (sand castles) where dry sand slumps to its angle of repose; soaked sand flows; water creeps up into dry sand and drains down through it; wet sand passes heat about ten times better than dry; wet wood (M8.2) has to dry before it burns.
- **Physics**: porosity φ (sand 0.35–0.45) is a powder cell's pore volume, already counted in its density (SAND's 1,600 kg/m³ is about quartz's 2,650 × (1 − 0.4)), so a sand cell holds 0.4 of a water cell: one water cell wets about 2.5 sand cells. Saturated sand is about 2,000 kg/m³, holds 1.3 + 0.4 × 4.18 ≈ 3.0 MJ/m³·K and conducts about 2.5–3 W/m·K, against 0.27 dry. Damp sand has an apparent cohesion c from the water bridges between grains, about 0.15–0.6 kPa for grains of 0.1–1 mm (more as the grains get finer), none when dry or saturated; a vertical cut stands up to `4 c tan(45° + φ_r/2) / (ρ g)` (φ_r its friction angle), about 0.14–0.23 m (100–170 cells) for 0.3–0.5 kPa. Capillary rise: coarse sand 2–15 cm (15–110 cells), fine sand 35–70 cm (250–500 cells; some tables give 100 cm), reached slowly (minutes or more, inferred). Drainage: Grain size.
- **Mechanism**: the moisture in the powder's `life` bits. Block-local: a powder cell with room absorbs a water cell of its block (the water cell becomes empty and the temperatures mix by capacity); moisture moves between porous cells by a pairwise exchange like conduction, weighted by permeability, down by gravity and up by suction; a cell over capacity sheds a water cell into an empty neighbor. The angle of repose (M8.8h), conductivity and capacity read it.
- **Cost**: the exchange runs only in blocks holding a wet cell: an estimated 0.1–0.3 ms on a busy screen, against heat's 0.4–0.5 ms on `mix75` and `full100` for the temperature field's loads, conduction and phase changes (`docs/powder-toy.md`). Storage is free; the heat bookkeeping is not (Open).
- **Fits**: M12.7, with surface tension, before M8.4, whose sponge, gel and clay paste can be the same mechanism with other porosities.
- **Open**: units that keep the water conserved (water cells plus the cells' moisture) in 8 or 16 bits; this and the heat bookkeeping below are the problem of I22's amount of matter too (`docs/research/volume-changes.md`, "The mechanism" and "Heat per unit of matter"), and of M8.4's dissolved amount: a cell carries a conserved amount and its capacity follows it, so one design serves all three (inferred); a wet cell's capacity and conductivity are per cell, so they reach every reader of the row's values: `exchangeHeat`, `airExchangeWGSL` (which would then bind `life`, its eighth storage buffer), the capacity ratios in `transitionCell` and the tests' `heatContent`; the pore water's own phase changes (it freezes at 0 °C, which makes damp sand set hard, and boils off at 100 °C), which add latent heat to a powder cell's bookkeeping. Evaporation at room temperature takes hours (Ruled out at this scale) and is left out.

### Surface tension and wetting

- **Sees**: drops instead of films. A puddle on a waxy floor stops spreading about 3 cells deep; water hangs from a ceiling in drops that grow and fall; mercury sits in beads; water climbs about 8 cells up a one-cell glass slot; with Moisture, it pulls water into dry sand.
- **Physics**: the capillary length `l_c = √(γ / (ρ g))` is the size below which surface tension beats weight: water 2.7 mm (2 cells), mercury 1.9 mm, oil 1.8 mm, the game's scale exactly. A wide puddle is `2 l_c sin(θ/2)` thick for a contact angle θ: water on wax (θ ≈ 107°) 4.4 mm, 3 cells; mercury on glass (θ ≈ 140°) 3.6 mm, about 3 cells; water on clean glass (θ ≈ 0–20°) spreads into a film. Rise in a slot of width w: `2 γ cos θ / (ρ g w)`, 11 mm (8 cells) for water in a one-cell glass slot. Surface tension γ: water 0.073 N/m, mercury 0.487, mineral oil about 0.03, liquid iron about 1.87, basaltic melt 0.35–0.37, liquid nitrogen 0.0089. The contact angle belongs to a pair: water–glass 0–20°, water–wax about 107°, mercury–glass about 140°.
- **Mechanism**: open, since a 2×2 block sees only part of a drop. Candidates: a cohesion bias in `spreadRow` and the slide (a liquid cell moves to where it has fewer neighbors of its own liquid with a lower chance, an Ising-like surface energy scaled by γ); a depth estimate carried down each column in the liquid's `life` bits; adhesion by the contact angle beside a solid. A prototype measures the puddle thickness against `2 l_c sin(θ/2)` and checks that the dam-break and U-tube tests, far above `l_c`, are unchanged.
- **Cost**: in-block and small; the risk is the rule, not the time.
- **Fits**: M12.7, with Moisture (wicking needs both).

### Erosion

- **Sees**: water flowing over sand picks up grains and drops them where it slows: it carves channels, builds deltas and sandbars, and wears through a sand dam it overtops, which is how most earth dams fail. Gravel needs fast water; clay resists more than sand.
- **Physics**: a grain moves when the flow's pull on the bed passes a threshold that grows with grain size, except that fine silt and clay stick and need more (Hjulström's curve, for flow about 1 m deep: sand of 0.2–0.5 mm moves from about 0.2 m/s, gravel of 10 mm from about 1 m/s, silt of 0.01 mm only from about 0.6 m/s); it settles where the flow falls below its settling speed. The CA's liquids move at up to 0.65 m/s, so a dam-break front would move sand but barely gravel (inferred: in a flow millimetres deep the shear stress on the bed decides, Shields' criterion, and the curve's speeds do not transfer as they are).
- **Mechanism**: in `spreadRow` and the slide, a liquid cell moving past a powder cell of its block gives it a velocity along the flow, with a chance from the flow's speed over the grain's threshold (from grain size, density and stickiness); the grain moves by `velocityRule` and, denser than water, sinks again where the flow slows. A spreading liquid keeps its motion in `life`, not `velocity`, so its speed is the spread cap when it moves.
- **Cost**: small.
- **Fits**: M12.8, after grain size (M12.1) and moisture (M12.7); M8.1 brings gravel and M8.4 clay.

### Strength and support

- **Sees**: pieces cut loose by a blast fall instead of floating; weak structures (damp sand, snow, a long ice shelf, thin glass under a heap of sand) sag and break.
- **Physics**: a piece with no path to an anchor falls; a structure breaks where its weight or load passes its strength. A ledge t thick breaks under its own weight at a length `√(σ t / (3 ρ g))`, σ its flexural strength. At t = 1 cell: granite (σ ≈ 10 MPa) 0.41 m (300 cells), ice (≈ 1.5 MPa) 0.27 m (200 cells), glass (≈ 40 MPa, the mean breaking stress of annealed float glass) 0.86 m (630 cells), structural steel (yield 250 MPa) 1.2 m (890 cells), damp sand (about 0.5 kPa) 4 mm (3 cells). So stone and steel fall by losing their anchor, not their strength; strength shows in damp sand, snow, ice and loaded glass.
- **Mechanism**: a support value per solid in `life`. Anchors (WALL, and cells against the world's edge, which reads as wall) are 0, and each dispatch a solid takes the least value in its block plus a step (sideways steps cost more), so support spreads one cell per dispatch: a 1,000-cell bridge learns it is cut within about 2 s. A cut piece's values climb by about one step per dispatch until they pass the material's limit (distance-vector routing's count to infinity, bounded by the limit). Connected-component labeling would answer at once, for a few extra passes. Unsupported cells become a loose form that falls like a powder without sliding, roughly keeping its shape, and sets back when supported, or crumble into their crush target.
- **Cost**: moderate: the relaxation is cheap per cell, but blocks of solids that may fall stay awake (WALL stays inert as an anchor).
- **Fits**: M12.9; `docs/powder-toy.md` "Beyond TPT" lists structural stress at moderate cost. TPT's solids never fall (`Falldown` 0, `docs/powder-toy.md`).
- **Open**: fall in shape or crumble; how a load (a heap on a shelf) enters a block-local rule. A loose form that moves would also let ice float, which a solid cannot (the ICE row).

### Restitution

- **Sees**: a steel ball bounces; a grain landing on loose sand barely does and kicks up its neighbors; a stone thrown into water splashes; debris landing on sand leaves small craters.
- **Physics**: the coefficient of restitution e, rebound speed over impact speed: hardened steel on steel up to about 0.9 (0.6–0.95 with hardness and speed), rubber 0.8–0.95, wet clay 0. A loose bed of grains absorbs most of an impact and throws up grains, the splash that keeps wind-blown sand moving.
- **Mechanism**: in the flyer passes (`src/shaders/flyers.wgsl.ts`): a flyer meeting a cell faster than a threshold rebounds by e and keeps flying instead of landing; a landing flyer passes its momentum to the powder or liquid cell it hits, launching it, through the landings' claim keys so reruns stay bit-identical.
- **Cost**: small at run time; the work is in the flyer passes and their tests.
- **Fits**: M12.10, after M8.1's metals and M8.3's force elements.

### Magnetism

- **Sees**: iron powder lines up along the field (the iron-filings pattern) and is pulled to magnets; a magnet lifts iron out of sand; red-hot iron is no longer attracted; with electric currents, a coil becomes an electromagnet.
- **Physics**: a magnetic material (iron, steel, nickel, cobalt, magnetite) is pulled up the field's gradient and loses it above its Curie temperature: iron 770 °C, nickel about 355 °C, cobalt 1,115 °C, magnetite 585 °C, neodymium magnets about 310 °C (up to 400 °C with cobalt or dysprosium). Data: magnetic or not, susceptibility, the strength of a permanent magnet, the Curie temperature.
- **Mechanism**: a field on a coarse grid from magnets and magnetized cells, the same kind of solve as M9's gravity (multigrid or FFT, every few frames); the CA samples its gradient once per block, as it samples the air, but from the air's buffer widened or from a texture, since the CA is at its 8 storage buffers (D32), as M9's gravity will be; grains in a field stick along its direction (chains).
- **Cost**: about 0.5–1 ms for the solve (estimate, as for gravity); the sampling is small.
- **Fits**: M16, after M9 (the solver). Electromagnets also need currents with a strength, the voltage solve `docs/powder-toy.md` lists beyond TPT, not M7's sparks alone. TPT does not simulate magnetism (inferred: it is not among the properties `docs/powder-toy.md` lists).

### Supercooling

- **Sees**: still water sits at −10 °C until ice or a rough surface touches it, then turns to slush at once; rain falling through freezing air glazes what it lands on.
- **Physics**: freezing starts on a seed. Without one, water stays liquid to about −38 °C; still, clean water in a smooth container often stays liquid several degrees below 0 °C (commonly reported, not from a measured source here). At the seed, the fraction that freezes at once is `c ΔT / L`: 12.5% at −10 °C, which warms the rest to 0 °C.
- **Mechanism**: a seeded bit per cell in `kind` bits 24–31, which every pass that reads cells binds (in `life`, the exchange pass would bind its eighth storage buffer). `cellTemp`, and the same clamp inlined in `airExchangeWGSL`, clamp at `below.temp` only for seeded cells, so an unseeded cell shows and conducts its stored temperature below the threshold and changes only past its supercooling limit. The latent bookkeeping is then already right: once seeded, a water cell stored at −10 °C is a cell at 0 °C that has given out 10 × 4.18 of its 334 MJ/m³. A cell of the target (ice) in the block seeds it, and a solid may. `effectiveTemp`, `latentOffsets` and the readout read the bit.
- **Cost**: one bit, and a branch in the clamp of `cellTemp` and `airExchangeWGSL`.
- **Fits**: M12.11, last: slush is subtle unless the display draws freezing progress (Observables, M15.1).

## Additions to planned slices

Each is written into its slice of `docs/roadmap.md`; the data stays here for that slice's plan.

- **M8.2 Fire and explosives**
  - A flash point apart from the self-ignition temperature: a fuel lights from a flame only above its flash point, and by itself above its autoignition temperature. A lit match dropped into diesel goes out; into petrol it does not. Petrol: flash point −43 °C, autoignition about 246–280 °C; diesel: at least 52 °C (EN 590: above 55 °C), about 210 °C; kerosene 38–72 °C, about 210 °C. OIL's `above` at 250 °C stands for both.
  - An ignition delay that shortens with temperature (an Arrhenius rate: the chance per dispatch is the dispatch time over the delay at the cell's temperature) instead of a hard threshold. GUNPOWDER's row cites ignition in 5 s at 427 °C; a charge smoulders, then catches.
  - Burn speed from grain size: the surface per mass grows as 1/d, so flour dispersed in air (grains under about 0.5 mm, above roughly 60 g/m³, 20–150 across tests) explodes while a heap smoulders.
  - Soot when oxygen runs short: smoke's color shows how well a fire burns (I16).
- **M8.3 Air, gases and force**: a boiling point that follows pressure (Clausius–Clapeyron, from the latent heat each row has). A vacuum boils and freezes water at once (water's triple point is 611 Pa), and a pressure cooker at 1 atm over ambient boils at about 120 °C. It needs the air's pressure on a physical scale first: the air's pressure is dimensionless (`AIR`, `src/air.ts`), and its speeds are not real-scale either (D33).
- **M8.4 Chemistry**
  - Salt lowers water's freezing point, so salt on ice melts it and chills the brine down to −21.1 °C (the eutectic, 23.3% salt; the ice-cream trick). The drop follows from the amount dissolved (water's cryoscopic constant, 1.86 K·kg/mol), not from a property of each salt.
  - Dissolving heats or cools: ammonium nitrate chills water (the instant cold pack), calcium chloride heats it.
  - A gas dissolves less as it warms (CO₂ about 3.4 g/L at 0 °C, 1.5 at 25 °C): warm soda goes flat faster.
  - A dissolved amount can live in the liquid's spare `life` bits instead of one element per concentration.
- **M7**: refractive index and dispersion (water 1.33, crown glass 1.52, diamond 2.42: a glass prism splits white light); the Seebeck coefficient (a copper–constantan junction gives about 40 µV/K: a thermocouple turns heat into current); solar absorptance (fresh snow reflects 80–90% of sunlight, dark sand little); radioactive half-lives.
- **A material for M8.3**: shear thickening, cornstarch in water: solid under a sudden blow, liquid under slow stress. A flyer landing on it stops as on a solid, a resting cell sinks in. One column, cheap, beside goo.

## Ruled out at this scale

- **Weather and a water cycle**: saturated air at 20 °C holds 17.3 g/m³ of vapor, a water cell's mass in about 58,000 cells of air, so a whole 2560×1340 grid of air holds about 60 water cells. Still water evaporates about 0.1–0.2 mm an hour at room temperature: a one-cell puddle dries in 7 to 14 hours. Backlog I25 is the same fact from the other side: the air cannot take a steam cell's latent heat.
- **Diffusion as a mechanic**: a dye spreads through water by diffusion about one cell in half an hour (`D` ≈ 0.4–0.7×10⁻⁹ m²/s); liquids mix by flowing, which the CA already does.
- **Real-speed sound and shock waves**: D33.
- **Melting points that follow the pressure**: ice melts 0.0075 °C lower per atmosphere of extra pressure (the Clausius–Clapeyron slope from its latent heat and its 9% change of volume), so one degree takes about 135 atmospheres, and other materials move as little. Boiling points do move with the pressure (M8.3).
- **Conductivity that changes with temperature**: tens of percent (water's 0.56 to 0.68 W/m·K from 0 to 100 °C; carbon steel's about halves by 800 °C), small next to the factors above. Heat capacity is not ruled out: steel's moves by a factor of ten (Heat capacity by temperature).

## Observables

Properties no rule reads, changed by rules that exist or are planned, seen in the readout (`formatProbe`, `src/readout.ts`) or a view. Roadmap M15: M15.1 what reads neither a cell's amount of matter nor its spare bits, M15.2 what does (mass, heat in joules and the heat budget follow what moisture and a dissolved amount add to a cell, M12.7 and M8.4).

Free, already in the data:

- **Phase-change progress**: from the stored temperature, the threshold and the latent width (`effectiveTemp`, `latentWidth`): "Ice · 0 °C · melting 41%". The display can draw it too: slush in freezing water, bubbles in boiling water.
- **Real units** (`src/physics.ts`): speed in m/s (one cell per dispatch is 0.65 m/s); mass, the world one cell deep (a cell of water 2.5 mg, of sand 4.0 mg, of steel 19.8 mg); heat in joules (boiling a water cell from 20 °C takes 6.5 J); the depth under a liquid's surface and its pressure `ρ g h` (the probe scans its column: 10 cm of water is 0.98 kPa); the density at the cell's temperature (`densityAt`: "Water · 4 °C · 1,000.0 kg/m³").

Free, computed by the display:

- **Dye view**: `variant` moves with its cell and no rule reads it, and the display draws it as the per-grain shade. A dye brush that writes only it, and a view that draws it, shows the convection rolls of a heated pot, the folds of an avalanche, where a dam break's water ends up. The shade and the dye can split its bits.
- **Speed view**: each cell colored by its speed (`velocity`). A liquid spreading sideways carries no velocity (its motion is in `life`), so the view shows falls and flights, not a liquid's sideways flow; flyers need their velocity in the overlay, which holds their `kind` and `temp` words.
- **Heat flow arrows**: conductivity times the temperature difference to the neighbors, per tile, like the air view's wind arrows.
- **Crack risk**: a solid's largest temperature difference to a neighbor over its thermal shock limit (M8.1k), or its air cell's pressure over its crush pressure: glass glows before it shatters.

Needs a small pass:

- **Heat budget**: the total heat of cells and air, the conservation the tests check (`heatContent` and `latentOffsets`, `tests/metrics.ts`), by a reduction every half second or so, ported to WGSL and read back for a panel. What leaves through the edges per second needs a counter the air passes do not keep.

Needs spare bits:

- **Peak temperature** (8 bits, log scale): "peak 1,240 °C", a scorch view, and temper colors: steel heated to 220–330 °C keeps a straw, brown, purple or blue tint after it cools, so a heated plate shows bands around the hot spot. Written in phase 7 or 8 only when the peak rises.
- **Age and origin**: a 16-bit birth stamp (the frame, wrapping after 18 minutes at 60 fps) and the element the cell was before (8 bits): "Stone · set from lava 12 s ago", "Water · condensed from steam".
- **Distance travelled**: moves counted in phases 1–3, plus a flyer's flight when it lands, saturating: "moved 600 cells (82 cm)".

## Open questions

- Radiated heat before the lighting work: out of the world (the sealed-box tests count it) or into the air.
- One heat bookkeeping for a capacity that follows temperature (M12.3), an amount of matter (M12.5, if confirmed), moisture (M12.7) and a dissolved amount (M8.4): each changes how much heat a cell holds at a temperature, so M12.3's plan designs it for all four (inferred).
- The `life` bit budget per state when several candidates want it (moisture, support, a dissolved amount, age, a liquid's depth estimate), and `kind` bits 24–31, which peak temperature (8 bits), the supercooling bit and I22's amount of matter (8 bits, about 11 for a thermometer with 5 °C marks) all want. The first of their slices to be planned divides them (roadmap M12).
- Heat capacity by temperature: knots, or a latent range for steel's peak.
- A powder's grain density: a porosity column (which Moisture needs anyway) or a grain-density column. M12.1's plan, the first to need it, decides, and M12.7 reuses it.
- A liquid's drag: from a droplet size, or kept tuned.
- Surface tension's rule (a prototype).
- Loose solids: fall in shape or crumble.

## Sources

- Settling velocities: Farrell and Sherman 2015, natural sand grains in air ([University of Galway](https://research.universityofgalway.ie/en/publications/a-new-relationship-between-grain-size-and-fall-settling-velocity--3/)); Ferguson and Church 2004, Journal of Sedimentary Research (natural grains); Stokes' law for flour, whose median size of 45–85 µm is from flour studies ([Research Papers Faculty of Materials Science and Technology, 2019](https://reference-global.com/download/article/10.2478/rput-2019-0007.pdf)); the 2 mm raindrop from Gunn and Kinzer 1949.
- Porosity and hydraulic conductivity: Freeze and Cherry 1979, Groundwater, as tabled by [AQTESOLV](https://www.aqtesolv.com/aquifer-tests/aquifer_properties.htm).
- Sand's conductivity: Wikipedia, [List of thermal conductivities](https://en.wikipedia.org/wiki/List_of_thermal_conductivities) (dry sand 0.27 W/m·K); saturated sand from a Johansen-type estimate.
- Capillary rise: NPTEL soil mechanics, after Silin-Bekchurin ([NPTEL](https://archive.nptel.ac.in/content/storage2/courses/105103026/module1/lec1/3.html)).
- Damp sand's cohesion: Richefeu, El Youssoufi and Radjai 2006, Physical Review E 73, 051304 ([arXiv](https://arxiv.org/pdf/cond-mat/0604368)).
- Leidenfrost points: water, [Physical Review Research 2024](https://doaj.org/article/ea2c60e8622b43658641291bbd2c7ccf) and [arXiv 2305.13767](https://arxiv.org/pdf/2305.13767); liquid nitrogen, Darr et al. ([NASA NTRS 20200000632](https://ntrs.nasa.gov/citations/20200000632)).
- Emissivity: Engineering ToolBox, [Emissivity coefficients](https://www.engineeringtoolbox.com/emissivity-coefficients-d_447.html); lava, [AGU Fall Meeting 2019 abstract](https://ui.adsabs.harvard.edu/abs/2019AGUFM.V23I0319F). Natural convection: Incropera et al., Fundamentals of Heat and Mass Transfer, Table 1.1.
- Lava's crust growth: Hon et al. 1994, Geological Society of America Bulletin ([USGS](https://pubs.usgs.gov/publication/70017862)).
- Surface tension and contact angles: Wikipedia, [Surface tension](https://en.wikipedia.org/wiki/Surface_tension); liquid iron, [ISIJ International 53(8)](https://www.jstage.jst.go.jp/article/isijinternational/53/8/53_1315/_html/-char/en); basaltic melts, [Walker and Mullins 1981](https://link.springer.com/doi/10.1007/BF00371487); capillary length and puddle thickness, de Gennes, Brochard-Wyart and Quéré, Capillarity and Wetting Phenomena (2004).
- Erosion: Wikipedia, [Hjulström curve](https://en.wikipedia.org/wiki/Hjulstr%C3%B6m_curve).
- Supercooling: the homogeneous nucleation limit ([White Rose eprint](https://eprints.whiterose.ac.uk/105135/7/1.4962355.pdf)).
- Strengths: glass, Pilkington technical bulletin [ATS-129](https://www.pilkington.com/-/media/pilkington/site-content/usa/window-manufacturers/technical-bulletins/ats-129---properties-of-soda-lime-silica-float-glass.pdf); freshwater ice, [Journal of Glaciology](https://cambridge.org/core/services/aop-cambridge-core/content/view/S0022143017000326); granite, ASTM C615 (at least 10.3 MPa); structural steel, ASTM A36 and EN S235.
- Restitution: PTC Creo documentation, [Coefficient of restitution](https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/simulate/mech_des/connections/coeff_restitution.html).
- Flash points and autoignition: Wikipedia, [Flash point](https://en.wikipedia.org/wiki/Flash_point); SKYbrary, [Ignition (fuels)](https://skybrary.aero/articles/ignition-fuels). Flour dust: [Powder Process, dust explosion concentrations](https://powderprocess.net/Safety/Dust_Explosion_Concentration.html).
- Evaporation: the ASHRAE (Carrier) pool evaporation formula ([Omni Calculator](https://www.omnicalculator.com/physics/evaporation-rate)). Dye diffusion: PicoQuant application note, [Diffusion coefficients](https://www.picoquant.com/images/uploads/page/files/7353/appnote_diffusioncoefficients.pdf).
- Handbook values (CRC Handbook of Chemistry and Physics, NIST and IAPWS steam tables, EN 1993-1-2, Machinery's Handbook): Curie temperatures, the salt–water eutectic, enthalpies of solution, CO₂ solubility, refractive indices, type T thermocouple sensitivity, snow albedo, saturated vapor density, water's triple point and boiling under pressure, conductivity against temperature, steel's heat capacity against temperature (EN 1993-1-2, clause 3.4.1.2), water's heat capacity from 0 to 100 °C, temper colors.
