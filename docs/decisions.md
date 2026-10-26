# Decisions

## Native WebGPU compute, no rendering library

The simulation runs in WGSL compute shaders against the raw WebGPU API. The earlier version used Three.js on WebGL2, simulating in fragment shaders with state packed into RGBA8 render targets (four 8-bit channels per cell). Compute shaders give storage-buffer writes, arbitrary per-cell data and atomics (used for particle counting). No WebGL fallback: browsers without WebGPU get an error message.

Rejected: `THREE.WebGPURenderer` (experimental, and it hides the compute API the simulation needs; direct WebGPU is less code than working around it).

## Cell state in storage buffers, one packed u32 per cell

Cells are an array of `u32` words (type, variant and lifetime in 8, 8 and 16 bits) in two ping-pong storage buffers. A storage texture limits a cell to one texel format; a buffer is read by index in every shader and leaves the word layout under our control. One word is 4 B, so a 4K grid is 33 MB per buffer, inside the default 128 MiB binding limit. Per-cell floats that a future model needs (for example a velocity or a temperature) go in a separate buffer rather than widening this word, so the CA keeps its small footprint.

Rejected: `rgba8unorm` storage textures (the first WebGPU version) or wider texture formats such as `rgba32float`; a 32-byte struct with float fields (the pressure and velocity fields it carried never affected movement).

## Margolus 2×2 block CA for every particle type

All particle types move in one Margolus CA shader. Updating disjoint 2×2 blocks in parallel guarantees that no two GPU threads move a particle into the same cell, so movement needs no atomics or conflict resolution, and every interaction (sand into water, fire on oil) is a local rule inside one block. One shader for all types keeps cross-type interactions in one place.

Rejected: per-cell rules where each cell picks a target (conflicts between threads need extra passes or atomics); separate shaders per material (interactions would span dispatches).

## Cells move by velocity; fast cells fly as particles (model C)

Every cell carries a velocity, integrated inside the Margolus block at up to 1 cell per dispatch. A cell faster than `launchSpeed` (1.5 cells/dispatch) leaves the grid and flies as a free particle (a flyer) that walks the cells it crosses and lands back in the grid when it hits something or slows down. Slots, claims and landing order come from prefix sums and claim keys, so reruns are bit-identical. Measured on the RTX 4080 at 2560×1340 (M4.1, `git log --all -- docs/plans/m4-element-engine.md`): blast debris flies 237 cells against 37 when every cell stays in the grid, for 0.13 ms more per frame at rest and 0.06 ms more with 230k flyers; piles stand at the same 44°; no flyer failed to land.

Consequence: a flyer is outside the grid while it flies, so anything that acts on grid cells (a blast, pressure, heat, reactions) misses it unless it also acts on the flyer list. Wind does; the rest is backlog I13.

Rejected:

- A, every cell stays in the grid (velocity clamped to 1 cell per dispatch): debris barely leaves the crater. Four times more CA steps per frame throw it as far as C (247 cells) but cost 5.2 ms at rest against C's 1.3 ms.
- B, cells claim a target cell anywhere along their path (not prototyped): its cost grows with every moving cell, dense piles make most claims conflict, and density swaps and reactions would need a second mechanism.

## Liquids move by CA rules, as in TPT

Water and oil are cells of the Margolus CA. A liquid falls into an empty cell, a gas or a lighter liquid, slides to the opposite bottom corner when blocked, and spreads sideways into an empty cell of its row. Heavier liquids swap down through lighter ones; side by side, different liquids never swap. A liquid cell remembers the direction it last moved in (its `life` field) and keeps going until it faces anything but empty space, or turns around one time in 64: without that memory a dam break takes more than 16,000 supersteps to level (the surface cells only diffuse), with it about 1,200. Local rules cannot carry pressure, so connected vessels do not level (the `uTube` scene shows it); The Powder Toy has the same limit, and its water equalisation option exists to work around it.

The liquids before this were FLIP particles with a global pressure solve (a velocity grid, multigrid-preconditioned conjugate gradients, particles ranked back into cells). They levelled connected vessels and splashed, and cost 49 ms of GPU time per 1x frame at 2560×1340 with a quarter of the tank water, three times the whole 16.7 ms frame. The measurements and the code are in `git log --all -- docs/plans/physics-foundation.md` and `git log --all -- src/fluid.ts`.

Rejected: keeping FLIP as a "realistic liquids" setting, off by default. Every per-cell field of a liquid (temperature, `ctype`, `life`, `tmp`…) would also have to live on its particles and be written back by the rasterization, every reaction that creates, removes or changes a liquid cell would need a reconcile pass, and every liquid behavior would be tested in both modes, for a mode that cannot run at full size. The realistic liquids may continue as a separate project (backlog I11).

## One cell per CSS pixel, grid fixed at load

The grid matches the canvas size in CSS pixels when the page loads and ignores `devicePixelRatio`: the falling-sand look is one visible pixel per cell, and a HiDPI grid would multiply memory and GPU cost by up to 4× or more. Resizing reconfigures the swap chain and stretches the existing grid instead of reallocating it, so the world is never lost on resize.

If the grid would exceed the device's storage-buffer limits (`maxStorageBufferBindingSize`, `maxBufferSize`, both requested at the adapter's maximum), the grid uses the smallest integer cells-per-pixel scale that fits, so a huge window still renders, coarser.

Rejected: resizing the grid on window resize (loses or crops the world), rendering at device pixels.

## Tuned on a desktop GPU first, then scaled down

The reference machine is an RTX 4080: each feature is built, and the frame budget held, there first, with generous sizes. Every size and resolution (playing field, cells per pixel, the air, gravity and light grids, CA steps per frame) is a setting, not a constant, so it can be scaled down later. Scaling follows this order: trim what is bigger than it needs to be to stay fun, which sets the default (a field of tens of millions of cells may play no better than 1–2M, already several times TPT's 235k); then measure on weaker hardware, real or the dev machine's integrated GPU; then trade a little quality for a lot of speed where the ratio is worth it, through presets or an in-app benchmark that picks the settings (roadmap M10).

Rejected: designing for laptop integrated GPUs from the start (it caps what gets tried before anyone knows which features are worth their cost).

## The Powder Toy's behavior, not its save format

Elements behave and feel like TPT's, but TPT save files are not loaded, and nothing in the engine follows TPT's element IDs or particle fields. Loading saves would tie the engine to TPT's sequential update order (each particle sees the moves of those before it), which a parallel GPU step does not reproduce.

Rejected: loading TPT saves as a parity test and a source of free content.

## No code or data tables from The Powder Toy

TPT is GPLv3. Translating its source or copying its element tables would make CorniSand a derivative work, which must then be distributed under GPLv3 with its source. Elements are reimplemented from observed behavior, documentation and physics. Reading TPT's source to learn what a mechanism does is fine; translating it is not. Property values come from physical data (melting points, densities) or our own tuning, never copied as a table.

Rejected: porting elements from TPT's source.
