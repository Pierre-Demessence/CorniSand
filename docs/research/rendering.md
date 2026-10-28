# Rendering

Research, not a plan: nothing here is decided. It gathers what would make the playing field look better, from changes that fit in hours now to the renderer that later milestones make possible, each weighed against its GPU cost. For each: what a player sees, how it works, its cost, what it needs from `docs/roadmap.md`, and whether the later renderer keeps it. The UI (panels, picker, buttons) is a separate research. An item that is chosen becomes a plan or a backlog line and leaves this doc; the doc is deleted when none is left.

Costs are GPU time per frame on the RTX 4080 at 2560×1340 (3.4M pixels, one cell each). None is measured: `tests/bench.gpu.ts` times compute passes only. "Estimate" marks a figure scaled from published measurements or from the bench's anchor (a full-grid pass over 4-byte cells costs about 0.04 ms, `docs/powder-toy.md`); "inferred" marks what is reasoned.

## Today

- One render pass (`Display.render`, `src/display.ts`): a fullscreen triangle whose fragment shader (`fs_main`, `src/shaders/display.wgsl.ts`) reads the cell under each pixel and the flyer overlay, and writes straight into the canvas texture (`getPreferredCanvasFormat()`, `src/gpu.ts`). No offscreen texture, no post-processing, no time input: nothing animates unless cells move.
- Each element is one flat color from its table row (`colorR` to `colorB`, three words of the 144-byte row the CA, the brush and the display share, `src/element-table.ts`). `variant`, 8 random bits per cell set by the brush and kept through phase changes, is ignored (backlog B10). Fire takes its color from its remaining life (`graphics_fire`). A cell above 525 °C adds `glowColor` × `glowWeight` to its own color (`src/heat.ts`), clamped at white by the 8-bit canvas: the glow never leaves its cell.
- Empty space is a near-black vertical gradient (0.06 to 0.10) with dither noise.
- The canvas is sized in CSS pixels (`src/main.ts`), one cell per pixel. A `?scene=` is stretched to the window, so its cells span several pixels; on a high-density screen the browser enlarges the whole canvas with smoothing.
- Cost: about 0.1–0.15 ms (estimate: 24 bytes read per pixel, the five fields and the flyer word).

A capture at 1,600×852 with sand, water, oil, fire, lava and metal painted looks like a vector drawing: flat fills with hard edges on a near-black void. Lava is a flat orange that reads as paint, not heat. Water is one flat blue. Hot smoke from the oil fire is a flat peach band along the top, each cell adding its glow color. Nothing has depth or light. The water's 45° slopes in it are the simulation (I27), not the drawing.

## The reference

A screenshot of a friend's falling-sand game, shown by the user, looks finished without any extra simulation:

- A lit wall behind the field: mid-grey, brighter at the top center, darker toward the edges.
- Long soft shadows cast on that wall from a light at the upper left: its strongest depth cue. Its flames cast them too, which a flame, giving light and see-through, would not.
- Glow: lava has a white-hot core, an orange rim and a halo over its surroundings; flames glow.
- Water: a teal body with a lighter line along its surface, darker below. Sand: a grain texture. Steam: a white spray.
- Its cells look 2–3 screen pixels wide (inferred), so its effects run on fewer cells than a field at one cell per pixel.

## Direction

- **Two looks for the normal view.** The finished look is the default, for play, screenshots and recordings. The cells look draws every cell as itself: today's drawing with grain shading and the backdrop, and nothing that blurs, spills or distorts. The heat and air views stay precise. The Powder Toy has the same split: its "Fancy" display (fire, glow, blur and a gravity "warp" pass) against "Nothing", base colors only (TPT `Renderer.cpp`).
- **Effects driven by the simulation's state first.** Glow from temperature, shimmer from the air's temperature and pressure, water tinted by depth, fog from gas density: each shows something the simulation computes. Decorative-only effects (embers, ripples, light rays) come later and are optional.
- **One pipeline that grows.** Each quick win below is a piece of the later renderer, not a stopgap: a coverage pass, low-resolution fields, a glow from the cells' emission, and one composite pass; the smooth look and the light field add fields to it.
- **Settings.** Every effect and field resolution is a setting (`docs/decisions.md`, "Tuned on a desktop GPU first, then scaled down"), so M10 can trim them; the cells look costs what today's drawing does.
- **Budget.** The frame keeps about 4.7 ms for drawing, compositing and spikes (`docs/powder-toy.md`, "Frame budget"). Proposed: the renderer at most 1 ms on the RTX 4080 for everything but the light field, measured once the bench times render passes. The light field counts in the simulation's 8 ms for heat, air, electricity, gravity and light, since it also carries radiant heat (see "Lighting").
- **Visual properties in a display-only table**, generated from `ELEMENTS` like the shared table: grain strength, opacity, absorption, emission scale, texture. The shared row has three free words, and its growth from 96 to 144 bytes is a suspect in D36, so the CA should not pay for columns only the display reads.
- **Color.** The table's colors are display RGB. The finished look converts them to linear light, adds emission, glow and light, tone maps with Khronos PBR Neutral (it keeps hues and compresses only above about 0.76, where ACES and AgX desaturate and cannot reach saturated yellows, greens and blues; its small offset meant for PBR reflections would darken flat colors and can be left out, inferred), encodes to sRGB, and dithers once, last (blue noise, about one step of the 8-bit output: Wronski 2016). The cells look and the heat and air views skip tone mapping: they keep today's colors, which their tests check, and the heat and air ramps keep the strictly rising brightness their legends promise.

## Pipeline

All passes go into the frame's one encoder, after `simulate` and `recordOverlay` (AGENTS.md: a frame is one `GPUCommandEncoder` and one `submit()`).

| Pass | Resolution | Writes | Cost (estimate) |
| --- | --- | --- | --- |
| Coverage | half and quarter | emission (`rgba16float`, half); opacity, liquid and gas coverage (quarter) | 0.05 ms: reads `kind` and `temp` once |
| Backdrop shadow | quarter | shadow | 0.02–0.1 ms |
| Glow chain | half down to 1/32 | glow | 0.1–0.15 ms |
| Composite | full, into the canvas | the frame | 0.2–0.25 ms: today's 0.1–0.15 plus a few cached samples |
| Later: smoothed liquid field | full | liquid field | 0.1–0.3 ms |
| Later: light field | quarter | light | 0.3–0.9 ms |

The quick wins together: about 0.4–0.55 ms against today's 0.1–0.15 ms, so 0.3–0.4 ms more (estimate). An integrated GPU is roughly 10× slower (`docs/powder-toy.md`): about 4–5 ms at the same size, which is what M10's presets are for.

## Quick wins

Each fits in hours to a day, and the later renderer keeps it or it is a few lines that are cheap to swap.

### Grain shading

- **Sees**: sand and gunpowder read as heaps of grains, stone as speckled rock. A grain keeps its shade as it falls, melts and sets. Liquids stay smooth: per-cell noise is what makes water look like blue grains.
- **How**: brightness, and a slight hue shift, from `variant`, scaled by a strength per state: strong for powders, faint for solids, none for liquids, gases and fire; a `graphics` function can override it (metal's sheen). The shade lives in the cell and moves with it, like Sandspiel's per-cell lightness byte and sandengine's per-cell color seed. On solids only, which never move, a faint low-frequency noise in world space can break up large flat areas, as Signs of Danger darkens Perlin-noise blotches over its terrain textures; on a powder it would stay put while the grains flow through it.
- **Cost**: none measurable: `variant` is in the `kind` word the pass already reads.
- **Survives**: yes: both looks keep it, and light later multiplies it. Closes B10.

### Backdrop

- **Sees**: the field stands in front of a wall instead of floating in a void: dark grey-blue, lighter toward the top center, darker in the corners. Oil, gunpowder and smoke stand out against it instead of sinking into black.
- **How**: replaces the gradient in `fs_main`: two colors, a radial falloff, a vignette, the existing dither moved to the very end. Its brightness can be a setting, from a lit room like the reference to a dark one where only hot things shine.
- **Cost**: none.
- **Survives**: a few lines; the light field later lights this wall in place of the gradient.

### Glow

- **Sees**: lava, fire, molten metal and anything above 525 °C look hot: a bright core and a soft halo over their surroundings, brighter and wider the hotter they are. Brightness, not only hue, rises with temperature, which reads without telling red from green. Lava's surface, cooled by the air, dims as it sets into a crust by the same rule.
- **How**: the coverage pass writes each cell's emission into a half-resolution `rgba16float` texture: the incandescence colors of `GLOW_RAMP`, with an intensity that keeps growing with temperature, and fire by its life. A blur chain spreads it: dual Kawase (4 downsamples and 4 upsamples give about a 97×97 blur at 7% of a linearly sampled Gaussian's bandwidth, Bjørge 2015) or Call of Duty: Advanced Warfare's 13-tap downsample and tent upsample over 5–6 levels (Jimenez 2014). The composite adds it. Driven by emission, as Signs of Danger blurs a lighting-only image, only hot things glow; a bright-pass over the finished image would also make snow, steam and a white wall glow. No full-resolution HDR copy of the frame is needed: the composite computes each pixel's color, adds the glow and tone maps in one pass. With backlog I17 (the flyer overlay carries `temp`), flying hot cells glow as sparks.
- **Cost**: 0.1–0.15 ms for the chain (estimate: Intel measured a 63×63 Gaussian of a half-resolution buffer at 2560×1600 at 0.5 ms on a Radeon R9 290X, Kawase filters 1.5–3× faster, and the RTX 4080 has about twice its bandwidth).
- **Survives**: yes: the emission texture is the light field's input, and the blur chain and tone mapping serve every later effect.

### Backdrop shadows

- **Sees**: matter casts a soft shadow on the wall behind it from a light at the upper left, so everything stands out in front of the wall, as in the reference. Flames and gases cast none, liquids a lighter one.
- **How**: the coverage pass writes a quarter-resolution opacity (solids and powders 1, liquids partial). A pass marches 16–32 texels from each texel toward the light and keeps the strongest occlusion, fading with distance: the field is treated as a slab with some depth in front of the wall, so its shadow is offset and smeared along the light (a thin layer would cast only an offset copy). The composite darkens empty space by it, sampled bilinearly, so the edges come out soft.
- **Cost**: 0.02–0.1 ms (estimate: 214,000 texels × 32 cached taps).
- **Survives**: the opacity texture feeds soft gases, the smooth look and the light field. The shadow itself is a style, one switch: the light field lights the plane of the field and does not replace a light standing in front of it, though a dark setting would dim it.

### Liquid depth and surface

- **Sees**: water reads as a body of liquid: a bright line along its surface, the wall faintly visible through the top few cells, darker and bluer with depth. Oil is dark and nearly opaque, lava opaque and glowing.
- **How**: in the composite, for a liquid pixel: the surface line and the see-through top from the 2–4 cells above (a falling-sand liquid shader lowers alpha the same way for each empty cell among the N above it, leothelegion 2023); the depth below the surface from the quarter-resolution liquid coverage (a march up a few dozen texels, saturating beyond); the tint by an absorption per liquid from the display table (water absorbs red first, so deep water turns blue-green and dark). At 1.36 mm per cell, water's real absorption tints a pool a metre deep and barely a shallow one (estimate); the drawing may exaggerate it, since it changes no physics. M7's optical properties later supply the data.
- **Cost**: a few cached reads per liquid pixel, under 0.05 ms (estimate).
- **Survives**: the cells look keeps exactly this; the smooth look keeps the depth and takes the surface from its smoothed field.

### Air shimmer

- **Sees**: the air above lava, fire and a hot plate wavers, and a blast sends a ripple ring outward ahead of its debris. Hot air and shock waves bend light this way (schlieren photographs show both), so the shimmer shows the air the simulation already computes.
- **How**: the composite moves the point it reads (the cell and every texture) by a small offset: animated noise scaled by how much hotter than the room the air is, plus the pressure gradient. `airCentersAt` already samples the air at every pixel; a time uniform is new. Off in the cells look and the views. A pressure wave crosses one cell per dispatch (D33), so a ripple crosses the screen in a few seconds at 1x. Once the light field exists, the offset either stays a read offset or becomes one pass over a scene-color texture (games accumulate the offsets in a half-resolution buffer and apply them once, Froyok 2024).
- **Cost**: two to four more reads of an air grid 16 times smaller than the screen, cached: under 0.05 ms (estimate).
- **Survives**: yes: M9's lensing around heavy bodies is the same displacement, as TPT's "warp" pass is for its gravity.

### Soft gases

- **Sees**: smoke and steam as soft translucent clouds, thicker where denser, instead of scattered dots or a flat band; hot smoke glows dimly from inside.
- **How**: the coverage pass sums the gas cells of each quarter-resolution texel (density and color); the composite draws them, sampled bilinearly, as a translucent layer over the wall. Blending each frame's sum with the previous one steadies the flicker of single cells hopping (inferred). The cells look draws the dots.
- **Cost**: one more channel and one more sample: negligible (estimate).
- **Survives**: it is the smooth look's gas drawing.

## The smooth look

What the user asked for: less raw, liquids that look like liquid. It is the larger upgrade, independent of the roadmap, and builds on the coverage pass.

- **Liquids**: a full-resolution mask of liquid cells, blurred over 2–3 cells and thresholded with a soft edge (LiquidFun Paint blurs and thresholds alpha; GM Shaders' fluid shader takes a `smoothstep` of the blurred field). One-cell notches and holes close and the surface becomes a smooth curve; a lone drop keeps at least its own cell, so spray stays. The field's slope gives the surface's direction: a highlight where it faces the light, and the wall seen through it slightly shifted (four taps, GM Shaders). Colors come from the liquid cells themselves, so oil on water keeps its sharp line. Blurring a 0/1 mask moves the contour each time a cell flips; a radius of 2–3 cells or more hides it (inferred). Cost: a mask pass and two blur passes over a 1-byte texture, 0.1–0.3 ms (estimate: about 61 million fetches at the RTX 4080's 761 GTexel/s, plus bandwidth).
- **Fire**: a soft glowing volume from the fire cells' field, with the glow: flames instead of orange dots. TPT's fire display accumulates fire into a blurred buffer that decays each frame, which gives flames a soft trail.
- **Powders**: grains stay (sand is grains), shaded as volumes: the smoothed matter field's slope lights the top of a pile and darkens its underside.
- **Solids**: a bevel (a lit upper-left edge, a shaded lower-right one) from the smoothed solid field, or from a distance field by jump flooding (about 12 rounds of 9 taps at full resolution; 0.15–0.3 ms at half, estimate); textures in world space for solids only, since they never move: brick courses, wood grain, brushed metal. Noita's materials take a texture image and undocumented edge variants (`texture_file`, `pixel_top`, `pixel_lonely` and others), and Signs of Danger stamps edge graphics along outlines.
- **Bigger cells**: where one cell spans several pixels (a `?scene=` stretched to the window, M10's smaller grids on weak GPUs, a future zoom), fields sampled smoothly give round shapes instead of blocks: this is where the smooth look gains most. Thresholding a bilinear field wobbles at corners; a distance field thresholded at its middle gives crisp edges with rounded corners, and outlines and glows from the same field (Green 2007).
- **High-density screens**: drawing the canvas at device pixels while the grid stays in CSS pixels (`docs/decisions.md`, "One cell per CSS pixel, grid fixed at load") makes these edges sharp there, at the composite's cost times the pixel ratio squared.
- **Cost**: about 0.3–0.5 ms on top of the quick wins (estimate). The cells look skips it.

Pixel-art upscalers (Scale2x/EPX, hqx, xBR, MMPX) are the other way to enlarge cells. They compare neighbors' colors, so with shaded grains they need an element-ID plane; their output flips whenever one neighbor flips; MMPX enlarges by 2 only (McGuire 2021). They suit sprites; for a moving liquid the fields are steadier (inferred).

## Lighting

- **Sees**: fire, lava and hot metal light their surroundings: a cave around a fire glows orange, a lava pool lights the water above it, walls cast soft shadows in the plane of the field, colored light passes through tinted glass. A setting runs from daylight (a light from the sky plus the backdrop's) to darkness, where only hot things light the scene.
- **How**: radiance cascades (Sannikov). Probes on a grid gather light along short rays near them and long rays far away; each coarser cascade has a quarter of the probes and four times the rays, so each costs the same, and merging them gives the light at each texel within one frame, with no accumulation over time to lag behind moving sand. Inputs: the glow's emission texture and the opacity texture, with a colored transmittance where M7 gives one (the formulation allows partial, colored opacity, Sannikov eqs. 8–11; Holographic RC stores RGB transmittance). Most implementations also build a distance field by jump flooding to skip empty space, which treats occluders as opaque, so water absorbing light needs a march that accumulates absorption (inferred). Small bright lights ring; the usual fixes cost about twice as much.
- **Cost**: 0.3–0.9 ms at quarter resolution (640×335), 1.1–3.4 ms at half, 5–14 ms at full (estimate: Holographic RC measured 0.55 ms at 256², 1.85 ms at 512² and 7.67 ms at 1024² on an RTX 3080 Laptop, about linear in pixels; with a Unity implementation's 1080p figures that is 4–8 ns per pixel, and the RTX 4080 is taken as 2–3× faster). `docs/powder-toy.md` estimates "2D lighting at half resolution, about 1 ms"; these figures put half resolution at 1–3 ms, so quarter resolution is the likely default (light is smooth).
- **Shared with the simulation**: the light at each texel is what radiant heat needs (I26: "warming what the radiation reaches waits for the lighting work"): the power a cell absorbs is the light reaching it times its absorptivity, which equals its emissivity (Kirchhoff's law). M7's "light reflected or absorbed by element" is the same field with each element's optics. One light field serves the eye, heat and M7, so it belongs in the simulation's budget and plans, not only the renderer's.
- **Cheaper alternatives, rejected**: light by jump flooding per color channel (GPU-Falling-Sand-CA, a Margolus sand CA like this one: cheap, but blocky, diamond-shaped light); light spread cell by cell as in Terraria (no crisp shadows, and light bends around corners); one shadow march per light (fire is hundreds of lights); a few rays per pixel averaged over frames (noisy, and it ghosts behind moving sand).
- **WebGPU**: the light reaches the composite and the CA as a sampled texture: the display already binds 7 of its 8 storage buffers (AGENTS.md), and a stage has 16 sampled textures by default.

## Later, with the roadmap

| Brings | Needs | Sees |
| --- | --- | --- |
| Element graphics | M8.1 | Glass translucent with a bright edge (light through it waits for M7), metals in their own colors with a brushed sheen, brick courses, snow that sparkles, gravel in several tones, mercury as a mirror-bright liquid, molten colors by what melted (M8.1's `molten` graphics) |
| Flash and soot | M8.2 | An explosion's flash (a burst of emission, so the glow and the light field light the scene for a few frames), smoke as dark as what burned (I16), fireworks as colored glowing flyers, cold flame's blue, thermite's glare |
| Glowing elements | M8.3 | Glow under pressure and dust colored by its speed, as graphics functions with emission |
| Distortions | M8.7, M9 | A swirl around portals, lensing around black holes: the shimmer's displacement, from the gravity field for M9 |
| Energy and optics | M7 | Sparks running along wires, photons and beams as glowing lines, lightning with a flash; transparency and reflection per element feed the light field's colors and the liquids' absorption |
| Flyer streaks | I17 | Thrown grains and sparks drawn as short streaks along their velocity (instanced lines from the flyer list), so a blast reads as a spray |
| Light field | the lighting work, I26 | "Lighting" above |
| Presets | M10 | Each effect on or off, field resolutions, glow levels, the light field's resolution; the in-app benchmark counts the renderer; the smooth look hides the larger cells of weak GPUs |

Decorative-only effects, any time, optional: embers rising from fire as a particle overlay (TPT has a sparks layer), slow ripples in still water (Sandspiel animates noise on its liquids), light rays from bright sources (a radial blur toward the light, GPU Gems 3, chapter 13).

## Not recommended

- A full-resolution HDR copy of the frame with a bright-pass for the glow: twice the traffic, and white things glow (above).
- HDR output to the screen (`toneMapping: { mode: 'extended' }`): Chrome 129+ on Windows, macOS and ChromeOS, Linux from 144; not Firefox; Safari accepts it but shows SDR. Screenshots and recordings are SDR, and an SDR screen clamps. An option for later.
- Pixel-art upscalers, per-light shadows, few-ray lighting averaged over frames (above).
- A marching-squares mesh of the liquid surfaces: a mesh pass every frame for what a fragment threshold does (inferred).
- Copying TPT's renderer: GPLv3 (`docs/decisions.md`); its display modes are references only.

## Measuring and testing

- Time the render passes in `npm run bench` (timestamp writes on every pass the renderer records), so each effect's cost is measured before it lands, not estimated.
- `tests/display.test.ts` renders cells and reads pixels back. Each effect gets deterministic checks there: the cells look and the heat and air views show what their tests compute whatever effects are on; the glow brightens empty cells beside lava in the finished look and none in the cells look; a backdrop shadow never darkens a filled cell; grain shading never changes a liquid's color; with the air at rest and at room temperature, the shimmer moves nothing.
- A physics behavior is judged on cell data or in the cells look, never through the finished look, which can hide holes and jagged surfaces.

## Recommendation

1. Time the render passes in the bench.
2. Grain shading and the backdrop: hours, and the largest change per hour in a screenshot; B10 closes.
3. Glow, with tone mapping and I17: the backbone, and the largest effect on lava, fire and blasts.
4. Backdrop shadows and soft gases, on one coverage pass.
5. Liquid depth and surface, and the air shimmer.

Together a small rendering milestone, 0.3–0.4 ms more per frame on the RTX 4080 (estimate), every piece kept by what follows. It touches only the drawing code (`src/display.ts`, `src/shaders/display.wgsl.ts`, a new display table, a toggle in `src/main.ts`), not the simulation, so it can run beside M8.9's scenarios (inferred). Done before M8.1, it gives M8.1's 21 new materials their look (grain strength, opacity, absorption) in their table rows from the start.

Then the smooth look as a milestone of its own, and the light field when the lighting work is planned, with I26's radiant heat, before or with M7.

## Decided by the user

- The wall is medium-dark with soft backdrop shadows by default; its brightness is a setting, from a lit room to a dark one where only hot things shine.
- The finished look is the default, the cells look is on a key, and the heat and air views are always precise.
- Effects the simulation drives come first; decorative-only ones (embers, water ripples, light rays) come later and are optional.
- The quick wins (the Recommendation's items 1 to 5) are a rendering milestone that runs before M8.1, beside M8.9's scenarios.

For the plan, not the user: field resolutions, blur radii, the emission curve, the shadow's angle and length, the exposure, the key for the cells look, and the milestone's ID in `docs/roadmap.md`.

## Sources

- The Powder Toy's renderer and display modes: [`Renderer.cpp`](https://raw.githubusercontent.com/The-Powder-Toy/The-Powder-Toy/master/src/graphics/Renderer.cpp), [wiki, Display modes](https://powdertoy.co.uk/Wiki/W/Display_modes.html) (search excerpts; the wiki is behind bot protection).
- Noita: [Modding: Making a custom material](https://noita.wiki.gg/wiki/Modding:_Making_a_custom_material), [Modding: Lua API](https://noita.wiki.gg/wiki/Modding:_Lua_API).
- Signs of Danger (Slow Rush Games): [texturing terrain](https://slowrush-com.pages.dev/news/texturing-terrain), [bloom in a falling-sand game](https://slowrush-com.pages.dev/news/bloom-falling-sand).
- Sandspiel: [Making Sandspiel](https://maxbittker.com/making-sandspiel), [`sand.glsl`](https://raw.githubusercontent.com/MaxBittker/sandspiel/master/js/glsl/sand.glsl). [sandengine](https://github.com/Ijtihed/sandengine). [GPU-Falling-Sand-CA](https://github.com/GelamiSalami/GPU-Falling-Sand-CA).
- Smooth liquids: [LiquidFun Paint programmer's guide](https://google.github.io/LiquidFunPaint/md__programmers_guide.html), [GM Shaders Mini: Fluids](https://mini.gmshaders.com/p/gm-shaders-mini-fluids-1507038), [a falling-sand liquid shader (leothelegion 2023)](https://leothelegion.net/2023/11/10/introducing-oil-and-a-new-liquid-shader-in-my-falling-sand-simulator/).
- Distance fields: Green 2007, [Improved Alpha-Tested Magnification for Vector Textures and Special Effects](https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf) (Valve); jump flooding: [Rong and Tan 2006](https://www.comp.nus.edu.sg/~tants/jfa/i3d06.pdf), [Wikipedia](https://en.wikipedia.org/wiki/Jump_flooding_algorithm), [Golus, The Quest for Very Wide Outlines](https://bgolus.medium.com/the-quest-for-very-wide-outlines-ba82ed442cd9).
- Pixel-art upscalers: [McGuire 2021, MMPX (JCGT)](https://casual-effects.com/research/McGuire2021PixelArt/McGuire2021PixelArt.pdf), [Wikipedia, Pixel-art scaling algorithms](https://en.wikipedia.org/wiki/Pixel-art_scaling_algorithms).
- Radiance cascades: [Sannikov's paper](https://github.com/Raikiri/RadianceCascadesPaper), [GM Shaders](https://mini.gmshaders.com/p/radiance-cascades), [McGhee, Fundamentals of Radiance Cascades](https://jason.today/rc), [Holographic Radiance Cascades (arXiv 2505.02041)](https://arxiv.org/abs/2505.02041), [the bilinear fix (arXiv 2408.14425)](https://arxiv.org/html/2408.14425v1), [TypeGPU radiance cascades](https://docs.swmansion.com/TypeGPU/ecosystem/typegpu-radiance-cascades/), [a Unity implementation with 1080p timings](https://github.com/ErwinTerpstra/RadianceCascades). Alternatives: [Terraria lighting modes](https://terraria.wiki.gg/wiki/Lighting_mode), [0fps, voxel lighting](https://0fps.net/2018/02/21/voxel-lighting/), [McGhee, few-ray GI](https://jason.today/gi).
- Glow: [Jimenez 2014, Next Generation Post Processing in Call of Duty: Advanced Warfare](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/), [LearnOpenGL, Physically Based Bloom](https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom), [Bjørge 2015, Bandwidth-Efficient Rendering (notes)](https://community.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_marius_2D00_notes.pdf), [Intel, An investigation of fast real-time GPU-based image blur algorithms](https://www.intel.com/content/www/us/en/developer/articles/technical/an-investigation-of-fast-real-time-gpu-based-image-blur-algorithms.html).
- Tone mapping: [Khronos PBR Neutral](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral), [model-viewer's comparison](https://modelviewer.dev/examples/tone-mapping). Dithering: [Wronski 2016](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/), [free blue-noise textures](https://momentsingraphics.de/BlueNoise.html).
- WebGPU: [format capabilities](https://gpuweb.github.io/gpuweb/#plain-color-formats), [HDR canvas in Chrome 129](https://developer.chrome.com/blog/new-in-webgpu-129), [browser support data](https://github.com/mdn/browser-compat-data/blob/main/api/GPUCanvasContext.json), [WebKit bug 272702](https://bugs.webkit.org/show_bug.cgi?id=272702).
- Shimmer and light rays: [Froyok 2024, refraction](https://www.froyok.fr/blog/2024-12-refraction), [heat haze distortion](https://gamedev.net/shaderlab/38-heat-haze-distortion/), [GPU Gems 3, chapter 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process).
- The RTX 4080's texel rate: [technical.city](https://technical.city/en/gpu/GeForce-RTX-4080).
