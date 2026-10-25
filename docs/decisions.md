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
- Fill fraction per cell moved by naive fluxes on the velocity grid: levels fast but smears the surface into a foam band about 10 cells deep, and limiting the fluxes stalls the flow. The surface needs its own representation (next entry).

## Liquids are FLIP particles, drawn into the cell grid by ranking

Liquid is a set of particles (4 per cell at rest) with position and velocity. Each step their velocity is spread onto the staggered grid, the pressure solve corrects it, and the change is added back to the particles (FLIP, blended 0.8 with 0.2 PIC). The cell grid only shows the result: each step the N most crowded cells become liquid, N being the particle count / 4, so every liquid's cell count is exact by construction. The CA no longer moves liquids; sand still sinks through them and reactions still apply. The fluid grid has one fluid cell per grid cell (`k = 1`). Measurements: `git log --all -- docs/plans/physics-foundation.md`, section "M1.3 results".

Rejected:

- Velocity CA (liquids stay cells, each moving one cell once the velocity field has pushed it that far): three attempts failed AC1–AC3, AC5–AC7, AC9 and AC11 on the CPU reference. Volume can only cross the body through chains of holes, so the field cannot move water fast enough and the surface never closes.
- A cell is liquid whenever a particle sits in it: the volume shown then varies with particle spacing; the ranking keeps it exact.
- `k = 2` (one fluid cell per 2×2 grid cells, a 4× cheaper solve): fails AC2, AC5, AC6 and AC11 on the CPU reference. It stays a cost lever (backlog D15).

## The pressure solve is multigrid-preconditioned conjugate gradients

Red-black SOR passes pressure about one cell per half-sweep, so at screen height (408×480, 512×1200) 40 pairs per step leave the solve unconverged, deep water compresses and its surface sits a fifth too low. The pressure is solved by conjugate gradients, each iteration preconditioned by one geometric multigrid V(2,2) cycle (2×2 aggregates, Galerkin coarse operators, coarse correction scaled by 2), warm-started from the previous step. On the first projection of the screen-size scenes it cuts the largest residual 3–4× per iteration; three or four iterations from zero reach what 1,000 SOR pairs reach. The parameters are in `FLUID`, the CPU reference is `MultigridSolver` (`tests/cpu/solver.ts`), and `SCREEN=1 npx vitest run solver-screen` reruns the measurements.

Rejected:

- Bare V-cycles of the same multigrid: piecewise-constant transfer under-corrects, and the over-correction that compensates makes them stall at 0.5–0.8 per cycle on the U-tubes and diverge on the 512×1200 pool. Conjugate gradients choose the step size themselves, so they cannot diverge this way.
- A W-cycle: 0.2 to 0.8 per cycle depending on the correction scale and the coarsest size, with no setting that works on every scene.
- Bilinear prolongation: needs 9-point coarse operators, which red-black smoothing cannot update in two colors; not needed once conjugate gradients met the bar.

## The density correction is weak (`stiffness` and `pull` 0.1)

Particles sit slightly closer or further apart than 4 per cell, and the pressure solve only sees volume through the liquid cells, so the solve adds a source that asks crowded cells to push outward (`stiffness`) and gaps inside the liquid to pull closed (`pull`). The source asks for an outflow proportional to the excess times the depth of the column below it. At 0.5, a 5% excess over 500 cells of depth asks the surface for an upward flow of 12 cells per step against a speed clamp of 1, so deep water boils instead of relaxing. At 0.1 the half-size `deepPool` reaches its expected level with no shortfall; at 0 it ends a few cells low. The price is that a single interior cell with half the particles of its neighbors is not chosen by the rasterization, so a one-cell hole appears now and then in calm deep water (backlog D19). Measurements: `git log --all -- docs/plans/physics-foundation.md`, section "M1.5c measurements".

Rejected: a stronger `pull` with a weak `stiffness`, to close those holes faster (a rarefaction wave is a deficit over many rows, and `pull` then overdrives the same way, leaving particles at the speed clamp).

## One cell per CSS pixel, grid fixed at load

The grid matches the canvas size in CSS pixels when the page loads and ignores `devicePixelRatio`: the falling-sand look is one visible pixel per cell, and a HiDPI grid would multiply memory and GPU cost by up to 4× or more. Resizing reconfigures the swap chain and stretches the existing grid instead of reallocating it, so the world is never lost on resize.

If the grid would exceed the device's storage-buffer limits (`maxStorageBufferBindingSize`, `maxBufferSize`, both requested at the adapter's maximum), the grid uses the smallest integer cells-per-pixel scale that fits, so a huge window still renders, coarser.

Rejected: resizing the grid on window resize (loses or crops the world), rendering at device pixels.
