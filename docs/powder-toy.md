# The Powder Toy on the GPU

Goal: everything [The Powder Toy](https://powdertoy.co.uk/) (TPT) simulates, in the browser on WebGPU, on a larger playing field, then what only a GPU can afford. This doc gathers what TPT does, how each part maps to GPU compute, the frame budget, and what goes beyond TPT. `docs/roadmap.md` is the work; this doc is the reasoning behind it.

## What TPT simulates

Sources: TPT's `src/SimulationConfig.h`, `src/simulation/Particle.h` and `src/simulation/Element.h` on GitHub (master). The wiki is behind bot protection and was not read.

- **Grid**: 612×384 pixels (235,008 cells, which is also the particle limit, `NPART`). One particle per pixel, except energy particles (photons, neutrons, electrons…), which share pixels with matter through a second map.
- **Air grid**: 153×96 cells of 4×4 pixels (`CELL = 4`), holding pressure, air velocity and ambient heat.
- **Particle state**: 14 fields, 56 bytes: `type`, `life`, `ctype` (a second element ID, for example what a clone or a spark sits on), `x`, `y`, `vx`, `vy` (floats: particles move by velocity, several pixels per step), `temp`, `tmp`, `tmp2`, `tmp3`, `tmp4`, `flags`, `dcolour`. Ours is one 32-bit word per field per cell, in separate buffers (`kind`, `life`, `velocity`, `remainder` and `temp` so far: 20 bytes per cell).
- **Element table**: roughly 190 elements, each a row of properties plus optional callbacks (`Update`, `Graphics`, `Create`, `ChangeType`…). The properties: `Advection`, `AirDrag`, `AirLoss`, `Loss`, `Collision`, `Gravity`, `NewtonianGravity`, `Diffusion`, `HotAir`, `Falldown` (0 solid, 1 powder, 2 liquid), `Flammable`, `Explosive`, `Meltable`, `Hardness`, `Weight` (density ordering), `HeatConduct`, `HeatCapacity`, `PhotonReflectWavelengths`, `Properties` (type and behavior flags), and four transitions: low and high pressure, low and high temperature, each a threshold and a target element. Most elements are mostly this table; the `Update` callback adds the special behavior (sparks, explosions, life).
- **Settings the player can toggle**: heat simulation (particle temperatures and conduction), ambient heat (air temperature on the air grid), Newtonian gravity (a gravity field computed from the mass layout), water equalisation (liquid in connected vessels levels; its cost grows with the amount of liquid).
- **Update order**: one CPU thread walks the particles in order, and each update sees the effects of the ones before it. A particle can move many pixels, swap places, create or delete particles anywhere, and a chain can cross the screen in one step. Much of TPT's behavior silently relies on this.

## How each part maps to the GPU

The GPU updates millions of cells at once, so a rule may only change cells it owns, and anything that reaches far happens over several passes. Most of TPT is already local and maps directly. The rest needs a different mechanism.

| TPT mechanism | GPU approach | Difficulty |
| --- | --- | --- |
| Element properties | A table in a uniform buffer, generated from the TS source of truth (`src/elements.ts`) | Easy |
| Per-cell state (56 B) | Struct-of-arrays buffers (type, ctype, life, tmp…, temperature, velocity), so a pass reads only the fields it uses; `docs/decisions.md` already puts new per-cell data in separate buffers | Easy, but each field read costs bandwidth |
| Powders and liquids falling, spreading, density swaps | Margolus CA rules driven by `Falldown` and `Weight`, as today (`docs/simulation.md`). Local rules cannot level connected vessels; TPT has the same limit and its water equalisation option works around it | Easy |
| Movement by velocity (several pixels per step) | A velocity per cell moves a cell inside its block, and a cell faster than one cell per step leaves the grid as a free particle and lands on contact (`docs/decisions.md`, "Cells move by velocity; fast cells fly as particles") | Medium |
| Heat conduction | Pairwise exchanges between the cells of a Margolus block, inside the CA dispatch (phase 7), not a pass of its own: no second temperature buffer, no extra pass over the grid, and each exchange conserves heat exactly and is stable for any conductivity (`docs/simulation.md`, "Heat"; `docs/decisions.md`) | Easy |
| Temperature and pressure transitions | Per-cell check against the table. Temperature transitions are phase 8 of the CA dispatch, with latent heat kept in the stored temperature; pressure transitions are checked in the same phase against the pressure of the cell's air cell and its open neighbors' (`pressureAbove`, one way and instant), and an `above` transition can release a burst of pressure | Easy |
| Air: pressure, velocity, ambient heat | An explicit, local update on a coarse grid of 4×4 pixels per air cell, as TPT's, not a global solve: four passes per air step (velocity from the pressure gradient, pressure from the divergence, advect, diffuse), with the speeds on the cell faces. Ours is linear (velocity and pressure are not advected; only the heat is, in flux form), so a gust spreads and fades. Heat crosses between cells and air by a gather (each air cell's thread owns its cells), pressure bursts enter by integer atomic adds in fixed point, so no float atomics (`docs/simulation.md`, "Air"; `docs/decisions.md`) | Done (M6) |
| Particles pushed by air | The CA samples the air once per block and a powder or liquid moves toward the air's velocity by its `drag` and is pushed by the pressure gradient over its density; gases and fire drift with the air; flyers sample it in flight. TPT's `Advection` and `AirDrag` are one drag; ours has the two terms (`docs/decisions.md`) | Done (M6) |
| Electricity (sparks) | Local: a spark spreads to adjacent conductors with `life` counters. Instant conductors (TPT's `INST`) cross a whole wire in one step: on the GPU, a flood fill by repeated passes or a connected-component labeling | Medium for instant conduction |
| Energy particles | A separate free-particle layer with float positions; they rarely collide with each other, and they interact with matter by reading the cell grid | Medium |
| Newtonian gravity | A gravity potential from the mass layout is the same kind of equation as a pressure solve, so a multigrid solver (the removed liquids had one, see "Liquids move by CA rules" in `docs/decisions.md` for where to find it in git), or an FFT, on a coarse grid, updated every few frames | Medium |
| Water equalisation | Not part of the base game; a GPU-friendly equivalent (correct levels in connected vessels, without particles) can be researched on its own | — |
| Game of Life elements | Pure neighbor counting: the ideal GPU case | Easy |
| Long-range elements: beams (`ARAY`, `BRAY`), portals and wifi channels, region copiers (`DRAY`), pistons, conveyors, stickmen | Each needs its own mechanism (a ray march per emitter, a per-channel buffer, a scan along a line). Few elements, each its own small project | Hard, one by one |
| ~190 `Update` callbacks | WGSL functions dispatched by type in one shader. Neighbors running different elements cost lockstep threads extra time; usually small, since neighborhoods are mostly one material | Effort, not speed |

## Frame budget

60 fps leaves 16.7 ms a frame. Keep about 12 ms of GPU time for the simulation; the rest goes to drawing, the browser's compositing and spikes.

The element engine (M4) is held to 4 ms of the 12, which leaves 8 ms for heat, air, electricity, gravity and light. Heat is held to 1 ms of those 8, per 1x frame, on top of the engine, and so is the air (1.5 ms on `thermal`, where every cell holds heat and moves).

**Measured** (RTX 4080, 2560×1340 = 3.4M cells, `npm run bench`: GPU timestamp queries, frames submitted back to back after a 1 s burn-in, median of 60 frames, mean of two runs; the GPU must be otherwise idle, since a game or a live wallpaper made timings 3 to 8 times too high). The scenes: `tank` (a sand block over a quarter-full tank of water), `mix75` (75% of the cells a random mix of sand, water, oil and smoke, so everything keeps moving), `full100` (every cell inside a wall frame holds such a mix, so density swaps never stop), `blast` (five blasts under a sand layer, 46,000 flyers launched in the first 1x frame), `thermal` (every cell inside a wall frame a random mix of metal, stone, water, ice, lava and sand, the top half at 1,300 °C and the bottom half at −20 °C, so heat flows and phases change throughout) and `pot` (a metal plate at 700 °C across the floor under water a quarter of the interior deep, so the water convects and boils at the plate). The bench runs the same code as the game, with the cells moving by velocity and the flyer passes.

| Scene | 1x (4 supersteps) | 2x | 4x | 8x (32 supersteps) |
| --- | --- | --- | --- | --- |
| `tank` | 0.79 ms (max 1.84) | 1.54 | 3.21 | 6.09 |
| `mix75` | 2.53 ms (max 3.60) | 4.75 | 8.29 | 13.04 |
| `full100` | 2.29 ms (max 3.67) | 4.49 | 9.04 | 16.78 |
| `blast` | 0.59 ms (max 1.38) | 1.11 | 2.10 | 4.30 |
| `thermal` | 2.85 ms (max 3.80) | 4.95 | 9.27 | 16.42 |
| `pot` | 0.85 ms (max 1.84) | 1.70 | 3.47 | 7.34 |

- The physical properties (M8.8: heat at its real speed, density by temperature and convection, gas buoyancy, viscosity, angle of repose) cost 0.4 to 0.6 ms per 1x frame on the busy scenes, against the same scenes measured before them: `mix75` +20%, `full100` +21%, `thermal` +24%; `tank` +0.07 ms, `blast` nothing. The cost is mostly in the two CA passes. The worst scene is under the element engine's 4 ms. The table above, taken at M8.8j, is the baseline later plans compare against (backlog D36 schedules a profiling pass of the two CA passes). The bullets below describe the earlier shares of heat and air and are not re-measured. `pot` costs 0.85 ms: few blocks are awake, as in `tank`.
- Heat's share at 1x, from the same-day idle baseline taken before heat (`tank` 0.39, `mix75` 1.05, `full100` 0.98, `blast` 0.33 ms): +0.07, +0.52, +0.40 and +0.06 ms, inside the 1 ms. `thermal`, where every cell conducts and changes phase, costs 1.11 ms, 0.13 ms over the baseline's `full100`. The whole increase is in the two CA dispatches (the fifth field's loads, conduction, phase changes); the flyer passes did not change. These numbers were taken with Chrome using the GPU at about 30% (the idle baseline at 1 to 4%), so they are upper bounds: a second run agreed within 0.07 ms.
- The air's share at 1x with 4×4 air cells (the default), above the baseline taken before the air (`tank` 0.46, `mix75` 1.44, `full100` 1.31, `blast` 0.39, `thermal` 1.05 ms): +0.26, +0.72, +0.66, +0.27 and +1.24 ms. The air passes themselves are 0.14 to 0.30 ms of that. The rest is the CA reading the air for each block that holds a mover (about 0.2 ms on `thermal`) and the flyer passes, which have more grains to fly because the air pushes them (about 0.2 ms on `thermal`). The heat exchange between cells and air runs once per frame, folding the frame's air steps into one (`docs/simulation.md`, "Heat and the air"). At 2×2 air cells the air passes cost about 0.8 ms more again, and at 1×1 about 17 ms, so 1×1 is not usable at screen size. `BENCH_AIR=off,8,4,2,1 npm run bench` measures each size.
- Time grows about linearly with the speed. A 1x frame is 8 CA dispatches plus 4 rounds of flyer passes: the CA dispatches take most of it, the flyer launch scan 0.06 to 0.08 ms.
- A cell is 20 bytes (five fields). Each field adds its loads and stores to every awake block: the fifth, the temperature, added about a quarter to the CA's time (0.2 ms per 1x frame on `mix75` and `full100`). A dispatch over a busy screen with four fields (16 bytes) cost about 0.12 ms, three times the 0.04 ms of a CA with 4-byte cells and no velocity. That 0.04 ms per full-grid pass over 4-byte cells, close to the card's memory bandwidth (inferred), is the anchor of the estimates below for passes that only move data.
- Two changes made the engine fit, both without changing a single cell: a thread skips a block of four inert cells (empty or solid, no lifetime, no rule) after reading only their `kind` words, which cuts `tank` and `blast` by 40 to 50%; and the CA keeps its block in four variables instead of an array indexed by a run-time slot, which put the array in slow per-thread memory and made `mix75` and `full100` three times slower (`docs/simulation.md`, "Margolus neighborhood").
- Things that made no difference: reading the table through a `switch` instead of the uniform array, and workgroups of 32×2 or 16×4 instead of 8×8.
- Compiling the CA's pipelines takes about 0.5 s in Node the first time (backlog D17).
- The liquids before M4.2, a particle simulation with a global pressure solve, cost 49 ms of GPU time per 1x frame with a quarter of the tank water (found with `git log --all -- docs/plans/physics-foundation.md`). They are why liquids moved to CA rules (`docs/decisions.md`).

**Estimated**, from the measurements above, scaled by bytes per cell and passes. Within a factor of 2, to be replaced by bench numbers as each milestone lands:

| System | 3.4M cells on the RTX 4080 | Notes |
| --- | --- | --- |
| TPT-parity base (movement, element updates, transitions, heat) | 3–8 ms | The engine above, heat included, costs about 1.4–1.6 ms on a busy screen at 20 bytes per cell; TPT's cell is 56 bytes, 2.8× the data, with far more logic |
| Newtonian gravity on a 4×4 grid, updated every 4 frames | 0.5–1 ms averaged | A multigrid solve is dispatch-heavy (about 300 dispatches a frame cost the previous liquids about 0.04 ms each, idle) |
| 2D lighting at half resolution | about 1 ms | See "Beyond TPT" |
| More CA steps per frame | multiplies the base cost | Only worth it for fast-moving things, ideally only where they are |
| A world larger than the screen | proportional to the active area | Settled regions must sleep (active tiles) |

The same work on an integrated GPU (the dev machine's Intel UHD 770 shares system memory) is roughly 10× slower. So on a good desktop GPU, TPT parity fits at one cell per pixel with room for two or three extras; on a laptop's built-in GPU the field shrinks to about TPT's size to twice it (0.25–0.5M cells). Closing that gap is the last step of the scaling order in `docs/decisions.md` ("Tuned on a desktop GPU first, then scaled down").

Levers that keep features stacking: the coarsest resolution each field still looks right at (air, gravity, light), updating slow fields every few frames, and skipping settled regions. TPT uses the first two; the third is new here.

## Beyond TPT

Cheap on a GPU at screen size, too costly on a CPU:

- **Air at full or 2×2 resolution**: detailed smoke swirls, sharp shockwaves, flow around small obstacles. `?air=2` runs it at 2×2 (about 0.8 ms more per 1x frame); 1×1 costs about 17 ms and is not usable at screen size. Moving matter does not drag the air (backlog I21).
- **2D global illumination**: fire, lava and hot metal light the scene with soft shadows and bounced light. Radiance cascades (light gathered on a hierarchy of coarse probe grids) make this affordable every frame. The same light field can carry radiant heat, a cheap stand-in for real radiation, which is out of reach even natively (every hot cell would see every other).
- **Gravity and heat at full resolution**: sharper orbits and clumping than TPT's 4×4 gravity.
- **A world many screens wide, all of it simulated**, with sleeping regions.
- **Moderate cost**: electric circuits with a real voltage solve on the wire cells (current divides between branches, resistors heat), structural stress (towers crack and fall under their own weight).
