# The Powder Toy on the GPU

Goal: everything [The Powder Toy](https://powdertoy.co.uk/) (TPT) simulates, in the browser on WebGPU, on a larger playing field, then what only a GPU can afford. This doc gathers what TPT does, how each part maps to GPU compute, the frame budget, and the open questions. Roadmap M4–M9 is the work; this doc is the reasoning behind it and is deleted once its questions are settled.

## What TPT simulates

Sources: TPT's `src/SimulationConfig.h`, `src/simulation/Particle.h` and `src/simulation/Element.h` on GitHub (master). The wiki is behind bot protection and was not read.

- **Grid**: 612×384 pixels (235,008 cells, which is also the particle limit, `NPART`). One particle per pixel, except energy particles (photons, neutrons, electrons…), which share pixels with matter through a second map.
- **Air grid**: 153×96 cells of 4×4 pixels (`CELL = 4`), holding pressure, air velocity and ambient heat.
- **Particle state**: 14 fields, 56 bytes: `type`, `life`, `ctype` (a second element ID, for example what a clone or a spark sits on), `x`, `y`, `vx`, `vy` (floats: particles move by velocity, several pixels per step), `temp`, `tmp`, `tmp2`, `tmp3`, `tmp4`, `flags`, `dcolour`. Ours is one `u32` per cell (4 bytes).
- **Element table**: roughly 190 elements, each a row of properties plus optional callbacks (`Update`, `Graphics`, `Create`, `ChangeType`…). The properties: `Advection`, `AirDrag`, `AirLoss`, `Loss`, `Collision`, `Gravity`, `NewtonianGravity`, `Diffusion`, `HotAir`, `Falldown` (0 solid, 1 powder, 2 liquid), `Flammable`, `Explosive`, `Meltable`, `Hardness`, `Weight` (density ordering), `HeatConduct`, `HeatCapacity`, `PhotonReflectWavelengths`, `Properties` (type and behavior flags), and four transitions: low and high pressure, low and high temperature, each a threshold and a target element. Most elements are mostly this table; the `Update` callback adds the special behavior (sparks, explosions, life).
- **Settings the player can toggle**: heat simulation (particle temperatures and conduction), ambient heat (air temperature on the air grid), Newtonian gravity (a gravity field computed from the mass layout), water equalisation (liquid in connected vessels levels; its cost grows with the amount of liquid).
- **Update order**: one CPU thread walks the particles in order, and each update sees the effects of the ones before it. A particle can move many pixels, swap places, create or delete particles anywhere, and a chain can cross the screen in one step. Much of TPT's behavior silently relies on this.

## How each part maps to the GPU

The GPU updates millions of cells at once, so a rule may only change cells it owns, and anything that reaches far happens over several passes. Most of TPT is already local and maps directly. The rest needs a different mechanism.

| TPT mechanism | GPU approach | Difficulty |
| --- | --- | --- |
| Element properties | A table in a storage buffer, generated from the TS source of truth like `particles.ts` today | Easy |
| Per-cell state (56 B) | Struct-of-arrays buffers (type, ctype, life, tmp…, temperature, velocity), so a pass reads only the fields it uses; `docs/decisions.md` already puts new per-cell data in separate buffers | Easy, but each field read costs bandwidth |
| Powders and liquids falling, spreading, density swaps | Margolus CA rules driven by `Falldown` and `Weight`, as today | Easy |
| Movement by velocity (several pixels per step) | Option A: velocity stored per cell, the CA moves a cell one step when its accumulated displacement reaches one, with more CA steps per frame for fast things. Option B: free particles that claim their target cell with an atomic, losers stay. A is closer to the current engine; B is closer to TPT. Open question 3 | Medium |
| Heat conduction | One pass per step: each cell exchanges with its neighbors by `HeatConduct` (explicit diffusion, stable below 0.25 of the neighbor difference per step) | Easy |
| Temperature and pressure transitions | Per-cell check against the table after the heat and air passes | Easy |
| Air: pressure, velocity, ambient heat | TPT's air update is explicit and local (velocity from the pressure gradient, pressure from the velocity divergence, advection, loss), not a global solve: a few passes over the air grid. Particles feed pressure and heat into it by a gather (each air cell reads its fixed block of pixels), so no atomics | Easy |
| Particles pushed by air | Per-cell read of the air velocity (`Advection`, `AirDrag`), feeding the movement above | Easy once movement exists |
| Electricity (sparks) | Local: a spark spreads to adjacent conductors with `life` counters. Instant conductors (TPT's `INST`) cross a whole wire in one step: on the GPU, a flood fill by repeated passes or a connected-component labeling | Medium for instant conduction |
| Energy particles | A separate free-particle layer with float positions; they rarely collide with each other, and they interact with matter by reading the cell grid | Medium |
| Newtonian gravity | A gravity potential from the mass layout is the same kind of equation as the liquid pressure, so the existing multigrid solver (`src/fluid.ts`), or an FFT, on a coarse grid, updated every few frames | Medium |
| Water equalisation | Not part of the base game; see "The realistic water" | — |
| Game of Life elements | Pure neighbor counting: the ideal GPU case | Easy |
| Long-range elements: beams (`ARAY`, `BRAY`), portals and wifi channels, region copiers (`DRAY`), pistons, conveyors, stickmen | Each needs its own mechanism (a ray march per emitter, a per-channel buffer, a scan along a line). Few elements, each its own small project | Hard, one by one |
| ~190 `Update` callbacks | WGSL functions dispatched by type in one shader. Neighbors running different elements cost lockstep threads extra time; usually small, since neighborhoods are mostly one material | Effort, not speed |

## Frame budget

60 fps leaves 16.7 ms a frame. Keep about 12 ms of GPU time for the simulation; the rest goes to drawing, the browser's compositing and spikes.

**Measured** (RTX 4080, 2560×1340 = 3.4M cells, `npm run bench`, numbers from the M1 plan, found with `git log --all -- docs/plans/physics-foundation.md`):

- The current CA alone: about 0.40 ms per 1x frame (8 Margolus dispatches over 4-byte cells), so about 0.05 ms per full-grid pass.
- The FLIP liquids: 49 ms of GPU time per 1x frame with a quarter of the tank water (backlog D22).

**Estimated**, from that 0.05 ms per pass, scaled by bytes per cell and passes. Within a factor of 2, to be replaced by bench numbers as each milestone lands:

| System | 3.4M cells on the RTX 4080 | Notes |
| --- | --- | --- |
| TPT-parity base (movement, element updates, transitions, heat) | 4–12 ms | 10–30× the current CA: about 14× the data per cell and far more logic |
| Air at TPT's 4×4 resolution | under 0.1 ms | |
| Air at 2×2 | about 0.2 ms | |
| Air at full resolution | about 0.6 ms | |
| Newtonian gravity on a 4×4 grid, updated every 4 frames | 0.5–1 ms averaged | The multigrid solve is dispatch-heavy (backlog D22) |
| 2D lighting at half resolution | about 1 ms | See "Beyond TPT" |
| More CA steps per frame | multiplies the base cost | Only worth it for fast-moving things, ideally only where they are |
| A world larger than the screen | proportional to the active area | Settled regions must sleep (active tiles, as the liquids already do) |

The same work on an integrated GPU (the dev machine's Intel UHD 770 shares system memory) is roughly 10× slower. So on a good desktop GPU, TPT parity fits at one cell per pixel with room for two or three extras; on a laptop's built-in GPU the field shrinks to about TPT's size to twice it (0.25–0.5M cells). That gap is the reason for open question 1.

Levers that keep features stacking: the coarsest resolution each field still looks right at (air, gravity, light), updating slow fields every few frames, and skipping settled regions. TPT uses the first two; the third is new here.

## Beyond TPT

Cheap on a GPU at screen size, too costly on a CPU:

- **Air at full or 2×2 resolution**: detailed smoke swirls, sharp shockwaves, flow around small obstacles.
- **2D global illumination**: fire, lava and hot metal light the scene with soft shadows and bounced light. Radiance cascades (light gathered on a hierarchy of coarse probe grids) make this affordable every frame. The same light field can carry radiant heat, a cheap stand-in for real radiation, which is out of reach even natively (every hot cell would see every other).
- **Gravity and heat at full resolution**: sharper orbits and clumping than TPT's 4×4 gravity.
- **A world many screens wide, all of it simulated**, with sleeping regions.
- **Moderate cost**: electric circuits with a real voltage solve on the wire cells (current divides between branches, resistors heat), structural stress (towers crack and fall under their own weight).

## The realistic water

The FLIP liquids (`src/fluid.ts`) cost about 49 ms a frame at full screen, three times the whole budget. TPT parity needs liquids that move by CA rules, like TPT's (`Falldown = 2`), which cost almost nothing. Those don't level in a U-tube (`docs/decisions.md` records why local rules can't); TPT has the same limit, and its water equalisation option exists to work around it.

- **A. Remove FLIP.** Liquids move by CA rules, with TPT's look. The code, its measurements and its decisions stay in git history. Every later liquid rule is written once.
- **B. Keep FLIP as a "realistic liquids" setting**, off by default. Possible, but every per-cell field of a liquid (temperature, `ctype`, `life`, `tmp`…) must then also live on its particles and be written back by the rasterization. Every reaction that creates, removes or changes a liquid cell needs a reconcile pass that spawns, kills or retypes the matching particles, and every liquid behavior is tested in both modes. The mode runs on a smaller field (I10) or below 60 fps, and its CPU reference and tests (about 100 s of CI, D13) stay.

Recommendation: A. Dozens of TPT's elements are liquids, and B makes each of them, and each heat, pressure or electricity rule that touches them, carry a second implementation for an optional mode that can't run at full size. A GPU-friendly equivalent of water equalisation (correct levels without full FLIP) can be researched later on its own. Pending the user's decision.

## Open questions

1. **Target hardware**: which GPU must hold 60 fps, at which field size? Proposal: hold 60 fps at one cell per pixel on a good desktop GPU, and pick the cells-per-pixel scale at load from a short GPU benchmark, so laptops get a coarser field instead of a slow one.
2. **Realistic water**: A or B above.
3. **Movement model**: velocity-driven Margolus CA (A) or claimed free particles (B). Decide with a prototype measuring both on a falling-sand pile and an explosion.
4. **Faithfulness**: same elements and feel, or behavior close enough to load TPT's save files? Loading community saves would be a strong parity test and a large amount of free content, but it ties the engine to TPT's update-order quirks.
5. **License**: TPT is GPLv3. Reimplementing behavior from observation and documentation is independent work; translating its source code or copying its element data tables would make this project a derivative work. CorniSand has no license file yet. Decide before porting any element from source.
