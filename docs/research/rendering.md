# Rendering

Research, not a plan: nothing here is decided. What the drawing does today (the two looks, the passes, the color path, the effects and their settings) is in `docs/rendering.md`; this doc keeps what could come after it: the smooth look, the light field, the drawing that later milestones bring, decorative effects and what is not recommended. An item that is chosen becomes a plan or a backlog line and leaves this doc; the doc is deleted when none is left.

Costs are GPU time per frame on the RTX 4080 at 2560×1340 (3.4M pixels, one cell each), as `npm run bench` prints them (the `render:` labels). "Estimate" marks a figure scaled from published measurements or from the bench's anchor (a full-grid pass over 4-byte cells costs about 0.04 ms, `docs/powder-toy.md`); "inferred" marks what is reasoned. The renderer's budget is 1 ms for everything but the light field, which counts in the simulation's 8 ms for heat, air, electricity, gravity and light, since it also carries radiant heat (see "Lighting"). The frame keeps about 4.7 ms for drawing, compositing and spikes (`docs/powder-toy.md`, "Frame budget"). An integrated GPU is roughly 10× slower (`docs/powder-toy.md`), which is what M10's presets are for.

Two passes of the pipeline are still to come:

| Pass | Resolution | Writes | Cost (estimate) |
| --- | --- | --- | --- |
| Smoothed liquid field | full | liquid field | 0.1–0.3 ms |
| Light field | quarter | light | 0.3–0.9 ms |

## The smooth look

What the user asked for: less raw, liquids that look like liquid. It is the larger upgrade, independent of the roadmap, and builds on the coverage pass and the cover texture (`docs/rendering.md`).

- **Liquids**: a full-resolution mask of liquid cells, blurred over 2–3 cells and thresholded with a soft edge (LiquidFun Paint blurs and thresholds alpha; GM Shaders' fluid shader takes a `smoothstep` of the blurred field). One-cell notches and holes close and the surface becomes a smooth curve; a lone drop keeps at least its own cell, so spray stays. The field's slope gives the surface's direction: a highlight where it faces the light, and the wall seen through it slightly shifted (four taps, GM Shaders). Colors come from the liquid cells themselves, so oil on water keeps its sharp line. Blurring a 0/1 mask moves the contour each time a cell flips; a radius of 2–3 cells or more hides it (inferred). Cost: a mask pass and two blur passes over a 1-byte texture, 0.1–0.3 ms (estimate: about 61 million fetches at the RTX 4080's 761 GTexel/s, plus bandwidth).
- **Fire**: a soft glowing volume from the fire cells' field, with the glow: flames instead of orange dots. TPT's fire display accumulates fire into a blurred buffer that decays each frame, which gives flames a soft trail.
- **Powders**: grains stay (sand is grains), shaded as volumes: the smoothed matter field's slope lights the top of a pile and darkens its underside.
- **Solids**: a bevel (a lit upper-left edge, a shaded lower-right one) from the smoothed solid field, or from a distance field by jump flooding (about 12 rounds of 9 taps at full resolution; 0.15–0.3 ms at half, estimate); textures in world space for solids only, since they never move: brick courses, wood grain, brushed metal. Noita's materials take a texture image and undocumented edge variants (`texture_file`, `pixel_top`, `pixel_lonely` and others), and Signs of Danger stamps edge graphics along outlines.
- **Bigger cells**: where one cell spans several pixels (a `?scene=` stretched to the window, M10's smaller grids on weak GPUs, a future zoom), fields sampled smoothly give round shapes instead of blocks: this is where the smooth look gains most. Thresholding a bilinear field wobbles at corners; a distance field thresholded at its middle gives crisp edges with rounded corners, and outlines and glows from the same field (Green 2007).
- **High-density screens**: drawing the canvas at device pixels while the grid stays in CSS pixels (`docs/decisions.md`, "One cell per CSS pixel, grid fixed at load") makes these edges sharp there, at the composite's cost times the pixel ratio squared.
- **Cost**: about 0.3–0.5 ms on top of the finished look (estimate). The cells look skips it.

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
| Flyer streaks | the flyer overlay (M11) | Thrown grains and sparks drawn as short streaks along their velocity (instanced lines from the flyer list), so a blast reads as a spray |
| Light field | the lighting work, I26 | "Lighting" above |
| Presets | M10 | Each effect on or off, field resolutions, glow levels, the light field's resolution; the in-app benchmark counts the renderer; the smooth look hides the larger cells of weak GPUs |

Decorative-only effects, any time, optional: embers rising from fire as a particle overlay (TPT has a sparks layer), slow ripples in still water (Sandspiel animates noise on its liquids), light rays from bright sources (a radial blur toward the light, GPU Gems 3, chapter 13).

## Not recommended

- A full-resolution HDR copy of the frame with a bright-pass for the glow: twice the traffic, and white things glow (`docs/decisions.md`, "Visual properties live in a display-only table").
- HDR output to the screen (`toneMapping: { mode: 'extended' }`): Chrome 129+ on Windows, macOS and ChromeOS, Linux from 144; not Firefox; Safari accepts it but shows SDR. Screenshots and recordings are SDR, and an SDR screen clamps. An option for later.
- Pixel-art upscalers, per-light shadows, few-ray lighting averaged over frames (see "The smooth look" and "Lighting").
- A marching-squares mesh of the liquid surfaces: a mesh pass every frame for what a fragment threshold does (inferred).
- Copying TPT's renderer: GPLv3 (`docs/decisions.md`); its display modes are references only.

## Sources

- The Powder Toy's renderer and display modes: [`Renderer.cpp`](https://raw.githubusercontent.com/The-Powder-Toy/The-Powder-Toy/master/src/graphics/Renderer.cpp), [wiki, Display modes](https://powdertoy.co.uk/Wiki/W/Display_modes.html) (search excerpts; the wiki is behind bot protection).
- Noita: [Modding: Making a custom material](https://noita.wiki.gg/wiki/Modding:_Making_a_custom_material), [Modding: Lua API](https://noita.wiki.gg/wiki/Modding:_Lua_API).
- Signs of Danger (Slow Rush Games): [texturing terrain](https://slowrush-com.pages.dev/news/texturing-terrain).
- Smooth liquids: [LiquidFun Paint programmer's guide](https://google.github.io/LiquidFunPaint/md__programmers_guide.html), [GM Shaders Mini: Fluids](https://mini.gmshaders.com/p/gm-shaders-mini-fluids-1507038).
- Distance fields: Green 2007, [Improved Alpha-Tested Magnification for Vector Textures and Special Effects](https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf) (Valve); jump flooding: [Rong and Tan 2006](https://www.comp.nus.edu.sg/~tants/jfa/i3d06.pdf), [Wikipedia](https://en.wikipedia.org/wiki/Jump_flooding_algorithm), [Golus, The Quest for Very Wide Outlines](https://bgolus.medium.com/the-quest-for-very-wide-outlines-ba82ed442cd9).
- Pixel-art upscalers: [McGuire 2021, MMPX (JCGT)](https://casual-effects.com/research/McGuire2021PixelArt/McGuire2021PixelArt.pdf), [Wikipedia, Pixel-art scaling algorithms](https://en.wikipedia.org/wiki/Pixel-art_scaling_algorithms).
- Radiance cascades: [Sannikov's paper](https://github.com/Raikiri/RadianceCascadesPaper), [GM Shaders](https://mini.gmshaders.com/p/radiance-cascades), [McGhee, Fundamentals of Radiance Cascades](https://jason.today/rc), [Holographic Radiance Cascades (arXiv 2505.02041)](https://arxiv.org/abs/2505.02041), [the bilinear fix (arXiv 2408.14425)](https://arxiv.org/html/2408.14425v1), [TypeGPU radiance cascades](https://docs.swmansion.com/TypeGPU/ecosystem/typegpu-radiance-cascades/), [a Unity implementation with 1080p timings](https://github.com/ErwinTerpstra/RadianceCascades). Alternatives: [Terraria lighting modes](https://terraria.wiki.gg/wiki/Lighting_mode), [0fps, voxel lighting](https://0fps.net/2018/02/21/voxel-lighting/), [McGhee, few-ray GI](https://jason.today/gi).
- WebGPU: [format capabilities](https://gpuweb.github.io/gpuweb/#plain-color-formats), [HDR canvas in Chrome 129](https://developer.chrome.com/blog/new-in-webgpu-129), [browser support data](https://github.com/mdn/browser-compat-data/blob/main/api/GPUCanvasContext.json), [WebKit bug 272702](https://bugs.webkit.org/show_bug.cgi?id=272702).
- Light rays and refraction: [Froyok 2024, refraction](https://www.froyok.fr/blog/2024-12-refraction), [GPU Gems 3, chapter 13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process).
- The RTX 4080's texel rate: [technical.city](https://technical.city/en/gpu/GeForce-RTX-4080).
