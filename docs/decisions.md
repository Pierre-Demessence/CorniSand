# Decisions

## Native WebGPU compute, no rendering library

The simulation runs in WGSL compute shaders against the raw WebGPU API. The earlier version used Three.js on WebGL2, simulating in fragment shaders with state packed into RGBA8 render targets (four 8-bit channels per cell). Compute shaders give storage-buffer writes, arbitrary per-cell data and atomics (used for particle counting). No WebGL fallback: browsers without WebGPU get an error message.

Rejected: `THREE.WebGPURenderer` (experimental, and it hides the compute API the simulation needs; direct WebGPU is less code than working around it).

## Cell state in storage buffers, one packed u32 per cell

Cells are an array of `u32` words (type, variant and lifetime in 8, 8 and 16 bits) in two ping-pong storage buffers. A storage texture limits a cell to one texel format; a buffer is read by index in every shader and leaves the word layout under our control. One word is 4 B, so a 4K grid is 33 MB per buffer, inside the default 128 MiB binding limit. Per-cell floats that a future model needs (for example the fluid velocity and pressure grids) go in a separate buffer rather than widening this word, so the CA keeps its small footprint.

Rejected: `rgba8unorm` storage textures (the first WebGPU version) or wider texture formats such as `rgba32float`; a 32-byte struct with float fields (the pressure and velocity fields it carried never affected movement).

## Margolus 2×2 block CA for every particle type

All particle types move in one Margolus CA shader. Updating disjoint 2×2 blocks in parallel guarantees that no two GPU threads move a particle into the same cell, so movement needs no atomics or conflict resolution, and every interaction (sand into water, fire on oil) is a local rule inside one block. One shader for all types keeps cross-type interactions in one place.

Rejected: per-cell rules where each cell picks a target (conflicts between threads need extra passes or atomics); separate shaders per material (interactions would span dispatches).

## Liquids move by a velocity field and a global pressure solve

Liquid pressure is not local: when one arm of a U-tube is higher, the whole connected body must react at once. Rules between neighboring cells pass that information one cell per step, so it spreads like heat and a screen-sized body takes minutes to level. Liquids therefore get a staggered velocity grid and a pressure projection every step, beside the cell grid (roadmap M1); the same field is meant to carry gases (M2) and push grains (M3). Sand, fire and reactions stay Margolus CA rules.

Rejected, with prototype measurements on a 68×80 U-tube:

- Compressible-mass CA (W-Shadow style): pressure stored as extra mass makes deep water look shallower (300 poured cells show as 130 at compression 0.02, 265 at 0.001) and levels slowly (37,600 steps at 0.02). Faster leveling needs more compression, so volume and speed trade against each other.
- Hidden vacancy and surplus cells routed through the body: correct levels with exact volume (~1,500 steps), but the visible level is wrong while they travel, a GPU-friendly local routing jammed, and water has no momentum.
- Fill fraction per cell moved by naive fluxes on the velocity grid: levels fast but smears the surface into a foam band about 10 cells deep, and limiting the fluxes stalls the flow. The surface needs a dedicated representation, chosen in M1.

## One cell per CSS pixel, grid fixed at load

The grid matches the canvas size in CSS pixels when the page loads and ignores `devicePixelRatio`: the falling-sand look is one visible pixel per cell, and a HiDPI grid would multiply memory and GPU cost by up to 4× or more. Resizing reconfigures the swap chain and stretches the existing grid instead of reallocating it, so the world is never lost on resize.

If the grid would exceed the device's storage-buffer limits (`maxStorageBufferBindingSize`, `maxBufferSize`, both requested at the adapter's maximum), the grid uses the smallest integer cells-per-pixel scale that fits, so a huge window still renders, coarser.

Rejected: resizing the grid on window resize (loses or crops the world), rendering at device pixels.
