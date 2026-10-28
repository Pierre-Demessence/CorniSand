# Decisions

## Native WebGPU compute, no rendering library

The simulation runs in WGSL compute shaders against the raw WebGPU API. The earlier version used Three.js on WebGL2, simulating in fragment shaders with state packed into RGBA8 render targets (four 8-bit channels per cell). Compute shaders give storage-buffer writes, arbitrary per-cell data and atomics (used for particle counting). No WebGL fallback: browsers without WebGPU get an error message.

Rejected: `THREE.WebGPURenderer` (experimental, and it hides the compute API the simulation needs; direct WebGPU is less code than working around it).

## Per-cell fields in separate buffers, updated in place

Each per-cell field (`kind` with the element and variant, `life`, `velocity`, `remainder` and `temp`, and later `ctype`…) is one 32-bit word per cell in its own storage buffer, declared once in `src/cell-fields.ts`; the buffers, bind groups and WGSL accessors are generated from that list. A buffer's size limit applies to one field, not to the sum, so the grid size does not shrink as fields are added, and a pass can later bind only the fields it uses (today every pass binds every field). A storage texture limits a cell to one texel format; buffers are read by index in every shader.

The CA updates the buffers in place: a Margolus thread reads and writes only the cells of its own 2×2 block, so threads never race, no second copy of the world is needed (half the memory) and a block that did not change writes nothing.

Rejected: ping-pong pairs of buffers (twice the memory, every cell rewritten every dispatch); one struct per cell (every pass reads and writes every field, and the grid size is limited by the whole struct); `rgba8unorm` storage textures or wider texture formats such as `rgba32float` (the first WebGPU version).

## Margolus 2×2 block CA for every particle type

All particle types move in one Margolus CA shader. Updating disjoint 2×2 blocks in parallel guarantees that no two GPU threads move a particle into the same cell, so movement needs no atomics or conflict resolution, and every interaction (sand into water, fire on oil) is a local rule inside one block. One shader for all types keeps cross-type interactions in one place.

Rejected: per-cell rules where each cell picks a target (conflicts between threads need extra passes or atomics); separate shaders per material (interactions would span dispatches).

## Cells move by velocity; fast cells fly as particles (model C)

Every cell carries a velocity, integrated inside the Margolus block at up to 1 cell per dispatch. A cell faster than `launchSpeed` (1.5 cells/dispatch) leaves the grid and flies as a free particle (a flyer) that walks the cells it crosses and lands back in the grid when it hits something or slows down. Slots, claims and landing order come from prefix sums and claim keys, so reruns are bit-identical. Measured on the RTX 4080 at 2560×1340 (M4.1, `git log --all -- docs/plans/m4-element-engine.md`): blast debris flies 237 cells against 37 when every cell stays in the grid, for 0.13 ms more per frame at rest and 0.06 ms more with 230k flyers; piles stand at the same 44°; no flyer failed to land.

Consequence: a flyer is outside the grid while it flies, so anything that acts on grid cells (a blast, pressure, heat, reactions) misses it unless it also acts on the flyer list. The air pushes a flyer in flight like a grid cell (the flight pass samples it), and only the brush's erase and replace otherwise reach one. Heat and phase changes do not need to reach it: a flyer carries its temperature with the rest of its cell, does not exchange heat or change phase in flight, and reacts once it lands, a few dozen supersteps later at most.

Rejected:

- A, every cell stays in the grid (velocity clamped to 1 cell per dispatch): debris barely leaves the crater. Four times more CA steps per frame throw it as far as C (247 cells) but cost 5.2 ms at rest against C's 1.3 ms.
- B, cells claim a target cell anywhere along their path (not prototyped): its cost grows with every moving cell, dense piles make most claims conflict, and density swaps and reactions would need a second mechanism.

## Liquids move by CA rules, as in TPT

Water and oil are cells of the Margolus CA. A liquid falls into an empty cell, a gas or a lighter liquid, slides to the opposite bottom corner when blocked, and spreads sideways into an empty cell of its row. Heavier liquids swap down through lighter ones; side by side, different liquids never swap. A liquid cell remembers the direction it last moved in (its `life` field) and keeps going until it faces anything but empty space, or turns around one time in 64: without that memory a dam break takes more than 16,000 supersteps to level (the surface cells only diffuse), with it about 1,200. Local rules cannot carry pressure, so connected vessels do not level (the `uTube` scene shows it) and a tank does not drain faster when fuller (Torricelli's law); both are out of reach as real-world scenarios (`uTube`, `waterClock`), so no scenario test tries them; The Powder Toy has the same limit, and its water equalisation option exists to work around it.

The liquids before this were FLIP particles with a global pressure solve (a velocity grid, multigrid-preconditioned conjugate gradients, particles ranked back into cells). They levelled connected vessels and splashed, and cost 49 ms of GPU time per 1x frame at 2560×1340 with a quarter of the tank water, three times the whole 16.7 ms frame. The measurements and the code are in `git log --all -- docs/plans/physics-foundation.md` and `git log --all -- src/fluid.ts`.

Rejected: keeping FLIP as a "realistic liquids" setting, off by default. Every per-cell field of a liquid (temperature, `ctype`, `life`, `tmp`…) would also have to live on its particles and be written back by the rasterization, every reaction that creates, removes or changes a liquid cell would need a reconcile pass, and every liquid behavior would be tested in both modes, for a mode that cannot run at full size. The realistic liquids may continue as a separate project (backlog I11).

## Heat moves by pairwise exchanges inside the Margolus block

Heat conduction is phase 7 of the CA dispatch: the four cells of a block exchange heat in four pairs, rows then columns at one offset and columns then rows at the other. Each exchange moves both cells toward their capacity-weighted mean, so it conserves heat exactly (up to float rounding) and is stable for any conductivity (the share of the way to the mean is capped at 1), and it reads and writes only the block's cells, so it keeps the CA's race-free in-place update (`tests/block-locality.test.ts` guards that). Over a superstep every cell exchanges with each of its four neighbors. Measured cost on the RTX 4080 at 2560×1340: 0.06 to 0.52 ms more per 1x frame than before heat on the engine's four scenes, 1.11 ms for a screen where everything conducts and changes phase (`docs/powder-toy.md`, "Frame budget").

Rejected: a separate stencil pass over the grid. Reading the four neighbors of every cell needs a second temperature buffer (or a red-black order of two half passes, which breaks per-step energy conservation), plus an extra pass over every cell, awake or not.

## Latent heat is stored past the threshold

A cell's stored temperature may run past its element's threshold while the cell takes in or gives out the latent heat of the change; the temperature it conducts and shows is the stored one clamped to the thresholds, and the cell changes element only when the stored value has passed the threshold by the whole latent width (latent heat over heat capacity). The new element starts at the threshold plus the overshoot scaled by the two capacities, so a change creates and destroys no energy. Melting and boiling therefore take time, a surface between two phases does not flicker, and the total heat stays constant across every change (`docs/simulation.md`, "Phase changes").

Rejected: instant transitions with a gap between the two thresholds (a hysteresis band): they flicker, or they create or destroy the energy of the change.

## The air is its own coarse grid, linear, coupled by sampling and an owning gather

Pressure, air velocity and air temperature live on a grid of their own, `airCellSize`² cells per air cell (default 4, TPT's), stepped by explicit passes after the flyers of each superstep. The CA reads it by sampling once per block (the air state is written only between dispatches, so the out-of-block read cannot race) and puts pressure into it with integer atomic adds in fixed point (sums commute, so reruns are bit-identical). Heat crosses between cells and air in a pass of its own where one thread owns an air cell and the cells that trade with it (a solid trades with its first open neighbor's air cell), so no two threads write one cell. The air is a linear wave (the velocity and pressure passes update in place); only the heat is carried with the flow. Measured: 0.14 to 0.30 ms per 1x frame at 4×4 at 2560×1340, about 0.8 ms at 2×2 and 17 ms at 1×1 (`docs/powder-toy.md`).

Rejected:

- A pressure solve (as the removed FLIP liquids had), or the air inside the CA: a solve is dispatch-heavy and the CA's in-block rule cannot carry a wave across blocks.
- Advecting the velocity (semi-Lagrangian) while the pressure stays put: the split has no energy bound and ran away near the top speed (checkerboards, wind that never died, explosions that never settled). Advecting the pressure too needs the density term of compressible flow and a retune of every blast. The cost of the linear air is that a gust spreads as pressure and fades instead of coasting downwind.

## Pressure pushes by its gradient over density; drag pulls toward the air's velocity

A powder or liquid cell gains `drag · (air − v)` (a share of its speed relative to the air, as a flyer always lost) and, separately, `push · gradient / density`. One coupling could not do both jobs: a drag small enough to let sand fly far makes wind unable to throw it, and a drag strong enough to throw sand makes sand fall like snow, which is what advection-only coupling (TPT's) gives. The push is stronger on lighter matter, so a blast throws smoke and sand harder than stone.

Rejected: advection-only coupling (above).

## One cell per CSS pixel, grid fixed at load

The grid matches the canvas size in CSS pixels when the page loads and ignores `devicePixelRatio`: the falling-sand look is one visible pixel per cell, and a HiDPI grid would multiply memory and GPU cost by up to 4× or more. Resizing reconfigures the swap chain and stretches the existing grid instead of reallocating it, so the world is never lost on resize.

If the grid would exceed the device's storage-buffer limits (`maxStorageBufferBindingSize`, `maxBufferSize`, both requested at the adapter's maximum), the grid uses the smallest integer cells-per-pixel scale that fits, so a huge window still renders, coarser.

Rejected: resizing the grid on window resize (loses or crops the world), rendering at device pixels.

## Tuned on a desktop GPU first, then scaled down

The reference machine is an RTX 4080: each feature is built, and the frame budget held, there first, with generous sizes. Every size and resolution (playing field, cells per pixel, the air, gravity and light grids, CA steps per frame) is a setting, not a constant, so it can be scaled down later. Scaling follows this order: trim what is bigger than it needs to be to stay fun, which sets the default (a field of tens of millions of cells may play no better than 1–2M, already several times TPT's 235k); then measure on weaker hardware, real or the dev machine's integrated GPU; then trade a little quality for a lot of speed where the ratio is worth it, through presets or an in-app benchmark that picks the settings (roadmap M10).

Rejected: designing for laptop integrated GPUs from the start (it caps what gets tried before anyone knows which features are worth their cost).

## Real physics first, The Powder Toy as the inspiration, not its save format

Elements take real physical properties (conductivity, heat capacity, latent heat, density, viscosity, angle of repose), and The Powder Toy decides which elements and mechanics exist. Where TPT simplifies, real physics wins, as long as the frame budget holds. TPT save files are not loaded, and nothing in the engine follows TPT's element IDs or particle fields. Loading saves would tie the engine to TPT's sequential update order (each particle sees the moves of those before it), which a parallel GPU step does not reproduce.

Rejected: copying TPT's feel where it contradicts physics, loading TPT saves as a parity test and a source of free content.

## The grid has a physical scale from its gravity

One cell is 1.36 mm and one dispatch 2.08 ms, the only pair for which the default gravity (1/32 cell per dispatch²) is 9.81 m/s² at 1x (4 supersteps per frame at 60 fps, 480 dispatches per second). Every physical property is converted to cells and dispatches from this pair in one module (`src/physics.ts`), so heat spreads at its real speed and a change of scale is one place.

Rejected: hand-tuned ranks for heat (no way to say what a value means or to check it against data), a speed-up factor on heat (it breaks the match with gravity and every later property built on the scale).

## A cell is one unit of matter in every state

A cell holds one unit of matter whatever its state, so a gas row's heat capacity is its specific heat times its liquid's density, and a latent heat is per kilogram times the density of the denser phase (water: 334 and 2,257 MJ/m³). STEAM's conductivity of 42 W/m·K is the consequence: steam's real 0.025 W/m·K is for a cell of steam's own mass, and a cell of the water's mass (capacity 2.0 MJ/m³·K) keeps steam's real diffusivity (0.025 / (0.59 kg/m³ × 2.0 kJ/kg·K) × 2.0 MJ/m³·K), so the row is about 1,700 times the literal value. With the literal value a steam cell would outlast a cold plate for minutes where real steam gives its heat up within a second. The cost is that steam released into open air hardly condenses, since the air cannot take a whole cell's latent heat (backlog I25).

Rejected: the literal 0.025 W/m·K for STEAM; a conserved amount of matter per cell with volume changes (research in `docs/research/volume-changes.md`, backlog I22).

## No code or data tables from The Powder Toy

TPT is GPLv3. Translating its source or copying its element tables would make CorniSand a derivative work, which must then be distributed under GPLv3 with its source. Elements are reimplemented from observed behavior, documentation and physics. Reading TPT's source to learn what a mechanism does is fine; translating it is not. Property values come from physical data (melting points, densities) or our own tuning, never copied as a table.

Rejected: porting elements from TPT's source.

## Two looks: a finished one for play, a cells one that shows the cells

The finished look is the default: grain, a wall with shadows, a halo around hot things, smoke as a cloud, water darkening with depth, air that wavers over heat. The cells look (the C key) draws each cell as itself with its grain and the wall, and nothing that blurs, spills or shifts. The heat and air views are the same in both. A physics behavior is judged on cell data or in the cells look, never through the finished look, which can hide holes and jagged surfaces (The Powder Toy has the same split: "Fancy" against "Nothing"). The cells look costs what the drawing did before the effects (`docs/rendering.md`, "Budget").

Rejected: one look with every effect on and no way to see the cells; effects switched off one by one as the only way to see the cells (the settings exist for tests and for M10, but one key is how to see what the simulation holds).

## Visual properties live in a display-only table; glow comes from emission

Grain, opacity, absorption and the emission scale are columns of a table that only the display and its coverage pass bind (`src/display-table.ts`), generated from an optional `look` on each `ELEMENTS` row, not words of the CA's shared row, which already grew from 96 to 144 bytes and is a suspect in the CA's cost (backlog D36). The halo is the blurred light that hot cells radiate (a coverage pass writes it from temperature, a chain blurs it), not a bright-pass over the finished image.

Rejected: more words in the shared row (every CA thread would pay for columns only the drawing reads); a bright-pass bloom over the finished frame (it needs a full-resolution HDR copy of the frame, and white things such as snow, steam and a bright wall would glow).
