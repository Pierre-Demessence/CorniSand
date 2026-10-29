# Rendering

How the playing field is drawn. Code: `src/display.ts`, `src/look.ts`, `src/display-table.ts`, `src/glow.ts`, `src/shadow.ts`, `src/shaders/display.wgsl.ts`, `src/shaders/light.wgsl.ts`, `src/shaders/glow.wgsl.ts`, `src/shaders/shadow.wgsl.ts`. The simulation is in `docs/simulation.md`; what is left for later (the smooth look, the light field) is in `docs/research/rendering.md`.

## The idea

The drawing reads the simulation's state and never changes it. A cell has a color; around that, the picture adds what the state implies: grains in a pile of sand, a wall behind the field that matter casts a shadow on, a halo around what is hot, smoke as a soft cloud, water that darkens with depth, air that wavers over heat and blasts. Each effect comes from a number the simulation holds (a temperature, a variant, a pressure), so it shows something real, and none is decoration.

Two looks:

- **Finished** (the default): all of it.
- **Cells** (the C key): each cell as itself, with its grain and the wall, and nothing that spills over a cell: no halo, no shadow, no cloud, no liquid depth, no shimmer. It shows exactly the cells the simulation holds, which is the look a physics behavior is judged in (a hole or a jagged surface can hide in the finished look).

The heat view (H) and the air view (A) are the same in both looks and take no grain, halo, shadow or shimmer, so their legends stay exact.

## Passes

All are recorded by `Display.render` into the frame's one encoder, after `simulate` and the flyer overlay. The cells look and the views record the composite alone. The textures' sizes follow the grid (fixed at load), not the canvas.

| Pass | Kind | Reads | Writes | Runs when |
| --- | --- | --- | --- | --- |
| `coverage` | compute, one thread per 4×4 cells | `kind`, `temp`, `life`, the flyer overlay, the display table | `emission` (`rgba16float`, one texel per 2×2 cells: the mean light they radiate); `cover` (`rgba8unorm`, one texel per 4×4 cells: opacity, liquid share); `gas` (`rgba16float`, same size: the gas cells' linear color, their share in alpha) | the finished look, when any of glow, shadow, gas or depth is on |
| `glow` | render, `glowLevels` downsamples (13 taps, a Karis average on the first) and as many tent upsamples | `emission` | the blurred light (the halo) | the finished look with `glowStrength` above 0 |
| `shadow` | render, at the cover's size | `cover` | `shadow` (`r8unorm`) | the finished look with `shadowDarkness` above 0 |
| `composite` | render, full size, into the canvas | the cells, the textures above, the air | the frame | always |

The bench times each pass under its own label: `render:coverage`, `render:glow`, `render:shadow`, `render:composite`, and prints their sum in the `render` column, in the finished and the cells look (`npm run bench`).

## The color path

- **Cells look and views**: today's math, in display (sRGB) space: the table color with its grain, the in-cell glow of a hot cell, the wall behind empty space.
- **Finished look**: the cell's color (grain and in-cell glow clamped to 1 per channel, as the cells look draws it) goes to linear light; the shadow has already darkened the empty space and gas; the cloud is blended over empty space and gas cells; the halo is added around the cells that radiate; the tone map leaves light up to 1 per channel alone and turns light above 1 toward white; the result is encoded to sRGB by hand (the canvas format is not an sRGB one). A cell with nothing around it that casts light is therefore drawn in its cells-look color within one step.
- **The wall** is a display value, a blue-grey brighter at the top center and darker toward the corners; `wall` (0 to 1, `?wall=`) runs from near black, where only hot things shine, to a mid grey. A dither (interleaved gradient noise, plus or minus half a step) is added to the wall alone so its gradient does not band; the cells keep their exact colors.
- **Tone map**: after Khronos PBR Neutral's desaturation, without its compression knee at 0.76, which would change the table colors that reach 1 (fire's red).

## What each effect reads

- **Grain**: the cell's `variant` (a signed byte over 128, mean zero, variant 0 is the table color), as a brightness change with a slight warm shift when brighter, at a strength by state (powder 0.10, solid 0.03, liquids, gases and fire 0) or the row's `look.grain`. Solids also vary slowly with their place (a value noise of the cell's position scaling the strength), since they never move; a falling grain keeps its shade because the variant is in the cell.
- **Halo**: a cell that holds heat radiates its glow color times the fourth power of its absolute temperature counted from 525 °C, scaled to 1 at 1,000 °C (`emissionShare`, `src/heat.ts`); fire radiates twice its graphics color while young. The coverage pass averages that into `emission`, the chain blurs it, the composite adds it times `glowStrength`. A flying cell radiates by its own temperature. Cold things radiate nothing, however bright their color: the glow is driven by emission, not by a bright-pass over the finished image, so snow, steam and a white wall never glow.
- **Shadow**: the cover's opacity (solids and powders 1, liquids 0.35, gases and fire 0, or the row's `look.opacity`). From each cover texel the shadow pass marches `shadowLength` texels toward the light (the upper left) keeping the strongest `opacity × (1 − step / length)`; the composite darkens empty space and gas by `shadowDarkness` times the shade, sampled bilinearly so the edges are soft. A filled cell takes none.
- **Cloud**: gas cells are drawn as a layer, not as cells. Its strength at a pixel is the share of gas among the cells within 2 cells of it, weighted by a tent (`gasDensity`: 1 inside a cloud, 1/4 at a lone cell's center, 1/2 over a checkerboard, smooth between cell centers), raised to `1 − (1 − share)²` so thin smoke still shows, times `gasOpacity`. Its color is the `gas` texture's mean linear color of the gas around. So the dots of thin smoke merge into wisps that keep their shape (an earlier version blended the quarter-resolution texture alone, which blurred smoke into smears 8 cells wide). Hot smoke is brighter than cool smoke because the cell's color includes its in-cell glow. The `gas` texture also tells where no gas is near, so most pixels skip the neighborhood.
- **Liquid depth**: a liquid whose row has an `absorption` (water, oil) is tinted by `exp(−absorption × depth × depthScale)` in linear light. The depth is the liquid cells above the pixel inside its own cover texel, counted exactly, plus the liquid share of the cover texels summed up the column above it (32 texels at most, up to the first without liquid; the share is of the cells a liquid could fill, so a texel cut by a wall counts as full). Water's absorption is Pope and Fry's per cell plus a neutral turbidity (estimated, see the WATER row), so deep water turns dark navy rather than bright blue; `depthScale` exaggerates it, since 128 cells are 17 cm. The top row of a pool and a lone cell keep the table color; there is no surface line (a bright line was tried and looked artificial). Lava and molten metal have no absorption and are drawn flat.
- **Shimmer** (with air only): the composite reads the picture at a point shifted by the air at the pixel: a noise that rises with time, scaled by how much hotter than the room the air is, plus the pressure gradient, at most `shimmerMax` cells. Air at rest shifts nothing, exactly. No shimmer code is generated without air.

## The display table

Visual properties live in a uniform of their own, 256 rows of 8 words (`DISPLAY_FIELDS`, `packDisplay`), bound in the display's and the coverage pass's group 0, so the CA's shared row (`src/element-table.ts`) does not grow for columns only the drawing reads (backlog D36). A row's values come from the optional `look: { grain?, opacity?, absorption? }` of its `ELEMENTS` entry, defaulted by state in the packer; `validateElements` rejects values out of range. A new element gets its look by adding this field to its row.

## Bindings

The display's group 0 holds: 0 the display uniform, 1 the air state (storage, when there is air), 2 the display table, 3 the halo texture, 4 the sampler, 5 the shadow, 6 the gas texture, 7 the cover texture. Group 1 is the cell fields, group 2 the element table, group 3 the flyer overlay (two words per cell, `kind` and `temp`). The display still binds 7 of the 8 storage buffers with air; the four textures and the sampler count against the 16 sampled textures and 16 samplers of a stage. The coverage pass binds three of the 4 storage textures a stage allows. `tests/gpu.test.ts` checks the limits.

## Settings

Every effect is a field of `LookSettings` (`src/look.ts`, defaults in `LOOK`) that a test passes to `Display` through its last argument, and 0 switches an effect and its pass off:

| Setting | Default | Meaning |
| --- | --- | --- |
| `wall` | 0.35 | The wall's brightness, 0 to 1 (`?wall=`) |
| `grainPowder`, `grainSolid`, `solidNoise` | 0.10, 0.03, 0.2 | Grain strength by state, and the solids' blotches |
| `glowStrength`, `glowLevels` | 0.08, 4 | The halo's strength, and the downsamples of the chain (each doubles its reach) |
| `shadowDarkness`, `shadowLength`, `lightDirection` | 0.7, 24, toward the upper left | The shadow's darkness, its reach in cover texels, the light |
| `gasOpacity` | 0.8 | How much of the wall a full cloud hides; 0 draws gas as cells |
| `depthScale` | 100 | The exaggeration of the depth tint |
| `shimmer`, `shimmerPressure`, `shimmerMax` | 1.5, 10, 3 | Cells shifted by hot air, by the pressure gradient, and the cap |

The constants that are not settings (`DEPTH_TEXELS`, `SHIMMER_SPAN`, `SHIMMER_DEAD`, `SHIMMER_SIZE`, `SHIMMER_RISE`, `WALL_LEVEL`, `WALL_RANGE`) are in the same file. The field resolutions (2 and 4 cells per texel) are `EMISSION_CELLS` and `COVER_CELLS` in `src/shaders/glow.wgsl.ts`. The values are untuned by sight where the plan says so (`docs/plans/m11-rendering.md`).

## Budget

The renderer costs at most 1 ms per 1x frame on the RTX 4080 at 2560×1340 in the finished look, for every bench scene, and the cells look costs what the plain cell drawing did, within 0.05 ms (the bench's `render:composite` in the cells look). A new effect is measured against this budget with its cost per setting. Every field's resolution and level count being a setting is what lets M10 trim the renderer for weaker GPUs.

## Tests

`tests/look.test.ts` (finished look: each effect is compared with the same scene rendered without its cause, or with its setting at 0, so the dither cancels), `tests/display.test.ts` (cells look, heat and air views), `tests/glow.test.ts` (unit: the emission law, the settings, the generated shaders), `tests/elements.test.ts` (the `look` validation and the display table), `tests/scenes.test.ts` (`showcase`). Open `?scene=showcase` to see most effects at once.

## Sources

- Glow: [Jimenez 2014, Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/) (the 13-tap downsample, the Karis average, interleaved gradient noise), [LearnOpenGL, Physically Based Bloom](https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom), [Signs of Danger, bloom in a falling-sand game](https://slowrush-com.pages.dev/news/bloom-falling-sand).
- Tone mapping: [Khronos PBR Neutral](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral). Dithering: [Wronski 2016](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/).
- Grain: a per-cell shade as in [Sandspiel](https://maxbittker.com/making-sandspiel); world-space noise on solids as in [Signs of Danger, texturing terrain](https://slowrush-com.pages.dev/news/texturing-terrain).
- Liquids: [leothelegion 2023, a falling-sand liquid shader](https://leothelegion.net/2023/11/10/introducing-oil-and-a-new-liquid-shader-in-my-falling-sand-simulator/) (the depth from the cells above); Pope and Fry 1997, "Absorption spectrum (380-700 nm) of pure water. II. Integrating cavity measurements", Applied Optics 36(33): 8710-8723 (WATER's absorption).
- Shimmer: [Froyok 2024, refraction](https://www.froyok.fr/blog/2024-12-refraction), [heat haze distortion](https://gamedev.net/shaderlab/38-heat-haze-distortion/).
- The Powder Toy's display modes, as a reference for the two looks only (GPLv3, nothing copied): [`Renderer.cpp`](https://raw.githubusercontent.com/The-Powder-Toy/The-Powder-Toy/master/src/graphics/Renderer.cpp).
