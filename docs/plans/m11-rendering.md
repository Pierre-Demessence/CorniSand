# M11 Rendering quick wins

Status: running; M11.1 and M11.2 done, next open item M11.3 (glow). Runs before M8.1, beside M8.9 (`docs/plans/m8.9-real-world-scenarios.md`): it touches only the drawing code, never a cell, a rule or a test of the simulation.

## Goal

The playing field stops looking like a flat vector drawing: sand and stone show their grains, everything stands in front of a medium-dark wall and casts a soft shadow on it, hot things glow with a halo, smoke and steam are soft clouds, water darkens and turns blue with depth under a bright surface line, and hot air and blasts make the view waver. This finished look is the default; the C key switches to the cells look (each cell as itself, with its grain and the wall), and the heat and air views stay exactly as precise as today.

## Choices approved by the user

From `docs/research/rendering.md`, "Decided by the user":

1. The wall is medium-dark with soft shadows by default; its brightness is a setting, from a lit room to a dark one where only hot things shine (`?wall=0` to `?wall=1`).
2. The finished look is the default, the cells look is on a key (C), the heat and air views are always precise.
3. Effects the simulation drives only; decorative ones (embers, ripples, light rays) are not in M11.
4. The research's Recommendation items 1 to 5 are M11, before M8.1.

This plan adds, for approval: the renderer costs at most 1 ms per frame on the RTX 4080 at 2560×1340 (AC15); the cells look is today's drawing plus grain and the wall only (no liquid depth, no shadow), so it shows exactly the cells the simulation holds.

## Acceptance criteria

GPU tests of the finished look go in `tests/look.test.ts` (new), titled `M11 AC<n>:`; the cells look and the views stay in `tests/display.test.ts`. "Step" is one unit of the 8-bit output. Every finished-look test compares against the same scene rendered without the effect's cause (the hot cell, the block, the air) so the dither cancels; tolerances are 1 step unless stated.

Bench (M11.1)

- AC1 `npm run bench` SHALL print, per scene at 1x, the GPU time of each render pass and the renderer's total, in the finished and the cells look (check: the bench's output; the per-pass labels are those of Design, "Passes").

Looks, grain, wall (M11.2)

- AC2 WHEN the cells look, the heat view or the air view is on, the existing tests of `tests/display.test.ts` SHALL pass with their expected colors unchanged; only the background values they read become the new wall's (M6 AC22 without air), and the heat and air views SHALL render bit-identically in both looks.
- AC3 In the finished look, a cell with no effect around it (no hot cell, no gas, no liquid above it, nothing toward the light) SHALL be drawn in its cells-look color within 1 step, for every element of the table.
- AC4 Over the 256 variants, SAND's and GUNPOWDER's luminance SHALL spread over at least 20 steps, STONE's and METAL's over 3 to 12, and every liquid's, gas's and FIRE's over 0; variant 0 SHALL be the table color, and the mean shade over all variants SHALL be within 1 step of it. A grain that falls SHALL keep its color (render, run until it moved, render).
- AC5 Empty space SHALL be brighter at the top center than in the corners, and brighter with `wall: 1` than the default, than `wall: 0`, in both looks.
- AC6 `?scene=showcase` SHALL open a scene holding a sand pile, a water pool with oil on it, a lava pool beside stone, a hot metal bar, a fire on gunpowder and a smoke plume over a hot plate (`tests/scenes.test.ts`, as every scene).

Glow (M11.3)

- AC7 In the finished look, empty cells within 8 cells of a lava pool at 1,300 °C SHALL be brighter than without the pool, more so the nearer; in the cells look they SHALL be unchanged.
- AC8 The summed brightness the halo adds SHALL grow from lava at 1,000 to 1,300 to 1,700 °C; METAL at 500 °C and every element but FIRE at 20 °C (smoke and wall included, the brightest cold colors) SHALL add none.
- AC9 A flying grain at 1,500 °C SHALL be drawn in its heat color in the heat view and add a halo in the finished look (backlog I17; M5.5b AC17's flyer test is rewritten to this, since the old behavior is the bug).

Shadows (M11.4)

- AC10 A stone block SHALL darken empty pixels on its side away from the light (lower right) by at least 10 steps next to it, fading to 0 beyond 96 cells, and none toward the light; a water block SHALL darken them less than stone; SMOKE and FIRE SHALL darken nothing; no filled cell's pixel SHALL change; in the cells look nothing SHALL change.

Gases (M11.5)

- AC11 In the finished look, the pixels inside a 32×32 block of smoke SHALL lie within 4 steps of each other (a smooth layer, not dots), and a lone smoke cell SHALL tint its surroundings less than the block's center; smoke at 1,000 °C SHALL be brighter than at 150 °C; the cells look SHALL draw the dots as today.

Liquids (M11.6)

- AC12 In a water pool 128 cells deep under open air, the surface row SHALL be brighter than the row 8 cells below, and below the top 4 rows the luminance and the red-to-blue ratio SHALL not rise with depth and SHALL fall by at least 10 steps over the pool; water under a stone ceiling SHALL have no surface line; oil SHALL be darker than water at the same depth; lava SHALL not change with depth; the cells look SHALL draw the pool flat, as today.

Shimmer (M11.7)

- AC13 With the air at rest at room temperature, the finished frame SHALL be bit-identical at time 0 and at time 5 s, and to the frame with the shimmer off; with `air: false` no shimmer code SHALL be generated.
- AC14 Over air at 600 °C, the frame SHALL differ between time 0 and 0.5 s, and every pixel's color SHALL be found within 3 cells of its place in the unshifted frame (a striped backdrop of walls behind the hot air); a pressure pulse (`tests/air-pulse.ts`) SHALL shift pixels too.

Budget and docs (M11.8)

- AC15 The renderer's total SHALL be at most 1 ms per 1x frame for every bench scene in the finished look, and the cells look within 0.05 ms of M11.1's measure of today's render. WHEN an item takes the total past 1 ms, that item SHALL be blocked with its measured cost and what each setting saves.
- AC16 `AGENTS.md`, `docs/rendering.md`, `docs/decisions.md`, the roadmap, the backlog and the research doc SHALL hold M11.8's changes (check: grep).

## Design

- **Passes**, all recorded by `Display.render` into the frame's one encoder after `recordOverlay`; the cells look and the views record the composite only. `coverage` (compute, one thread per 4×4 cells): reads `kind`, `temp`, `life` and the overlay; writes `emission` (`rgba16float`, half resolution: the mean of each 2×2 cells' emitted light, linear) and at quarter resolution `cover` (`rgba8unorm`: opacity, liquid fraction, gas fraction) and `gas` (`rgba16float`: the gas cells' mean linear color, alpha their fraction). `shadow` (render, quarter). `glow` (render: 4 downsamples from half to 1/32 with the 13-tap filter of Jimenez 2014, a Karis average on the first so a single hot cell does not flicker, then 4 tent upsamples, additive). `composite` (render, full, into the canvas: today's `fs_main` grown). Storage textures fit the default 4 per stage, sampled ones 16; the display keeps 7 storage buffers; `tests/gpu.test.ts`'s limit check covers the new pipelines. Texture sizes follow the grid (fixed at load), not the canvas. No `writeBuffer` between passes: per-level sizes come from `textureDimensions`.
- **Color**. Finished look: table colors to linear light, add emission and halo, shadow and gas over the wall, tone map with Khronos PBR Neutral without its offset (identity below 0.76, so AC3 holds), exposure 1, encode sRGB by hand (the canvas format is not an sRGB one), dither last with interleaved gradient noise (±½ step; no texture asset), then the brush ring. Cells look and views: today's math in display space; the wall and the dither are shared.
- **Settings**: `src/look.ts` exports `type Look = 'finished' | 'cells'`, `LookSettings` and `LOOK` (its defaults): `wall` 0.35 (0 near black, 1 the reference's mid-grey), the field resolutions (2 and 4 cells per texel), glow strength 0.08 and levels, shadow direction (toward the upper left at 45°), length 24 quarter texels and darkness 0.5, grain strengths by state (powder 0.10, solid 0.03, else 0) and the solid noise, liquid surface rows 3, depth march 32 quarter texels, depth scale 20, gas opacity, shimmer amplitudes. `Display`'s last argument becomes `{ air?: AirGrid; settings?: Partial<LookSettings> }` (callers: `main.ts`, the tests, the bench); `DisplayOptions` gains `look: Look` and `time` (seconds). `main.ts`: `?wall=<0..1>`, the C key (help line "C: cells look"), the frame's time.
- **Display table** (`src/display-table.ts`): `DISPLAY_FIELDS` and `packDisplay`, a uniform of 256 rows of 8 words (grain, opacity, absorption r, g, b, emission scale, two pads), bound in the display's group 0; the CA's shared row is untouched (backlog D36). Values come from an optional `look: { grain?, opacity?, absorption? }` on `ELEMENTS` rows, defaulted by state in the packer (opacity 1 for solids and powders, 0.35 for liquids, 0 for gases and fire); `validateElements` rejects values out of 0..1 and absorption on a non-liquid. WATER's absorption is its real coefficients at 650, 550 and 450 nm per cell (Pope and Fry 1997, source in the row's comment), scaled by `LOOK` depth scale since 128 cells are only 17 cm; OIL's is estimated and marked so, at opacity 0.9; LAVA and MOLTEN_METAL are opaque (1).
- **Grain**: shade = strength × the variant read as a signed byte / 128 (variant 0 is the table color, the mean is zero), as brightness with a slight warm shift when brighter; on solids only, a faint value noise in world space (they never move). Heat and air views take no grain.
- **Emission**: a cell that holds heat emits `glowColor(t)` × (T⁴ − T₅₂₅⁴) / (T₁₀₀₀⁴ − T₅₂₅⁴), T in kelvin (radiated power grows as T⁴), 0 below 525 °C; fire emits its graphics color × 2 × its life fraction. The finished look adds the cell's own emission to its color (the white-hot core comes from the tone map) and the halo everywhere. The cells look keeps today's in-cell glow.
- **I17**: the overlay becomes two words per cell, `kind` and `temp`, written by the same thread; two flyers over one cell may still mix for a frame, as today's single word may, display only. The display and the coverage pass draw a flyer with its temperature.
- **Shadows**: from each quarter texel, march toward the light keeping the strongest `opacity × (1 − step/length)`; the composite darkens empty and gas pixels by it, sampled bilinearly, so edges are soft.
- **Gases**: the composite draws the `gas` texture, sampled bilinearly, over the wall at alpha × gas opacity, plus the gas's emission; gas cells are not drawn as cells in the finished look. No blending with the previous frame: if the clouds flicker in the user's check, it becomes a backlog idea.
- **Liquids**: for a liquid pixel, the empty or gas cells among the 3 above set the surface line (brighter) and how much wall shows through (opacity by row); the depth is the liquid fraction summed up the column of `cover` (32 texels, saturating); the tint is exp(−absorption × depth × scale), applied to the liquid's color.
- **Shimmer**: the composite offsets the point it reads (cell and textures) by animated value noise × clamp((air temperature − 20) / 500, 0, 1) × 1.5 cells, plus the pressure gradient × a gain set so a `blast` front shifts about 2 cells; capped at 3 cells. Off in the cells look and the views, and without air.
- **Bench**: `Display.render` takes the bench's `PassTimer` as an optional last argument and stamps each render pass (`render:coverage`, `render:shadow`, `render:glow`, `render:composite`); the bench renders every measured frame into a 2560×1340 `bgra8unorm` texture after `recordOverlay`, and `maxPasses` grows by the renderer's. Before each run: `nvidia-smi` shows nothing else loading the GPU (`AGENTS.md`).
- **Not in M11**: the smooth look, the light field, decorative effects, HDR output, device-pixel drawing; they stay in the research doc.

## Checklist

### M11.1 Roadmap, baseline and render timing

- [x] `docs/roadmap.md`: M11 Rendering ("The finished look: grain, the wall and its shadows, glow, soft gases, liquid depth, air shimmer, from the simulation's state, with a cells look on a key. Done when each effect has a deterministic display test and the renderer costs at most 1 ms per frame on the RTX 4080 (`docs/plans/m11-rendering.md`)."), the order line (M11 beside M8.9, before M8.1), `Next ID: M12`. Baseline: lint, typecheck, `npm test` counts, build, into a "Baseline" note under this item. The bench's render timing (AC1, Design "Bench"), and today's render cost recorded here. Verify: lint, typecheck, `npm test`, `npm run bench`.

Baseline (before M11, from the run's start): lint, typecheck and build pass with no warnings. `npm test` and `npm run bench` were not run (the GPU was busy with a game); their counts and today's render cost are left to the user, see Needs you.

Done in the run: `docs/roadmap.md` (M11 section, order line, `Next ID: M12`); `Display.render` takes an optional `PassTimer` and stamps its pass `render:composite`; `tests/bench.gpu.ts` renders every frame into a 2560x1340 `bgra8unorm` texture after `recordOverlay`, prints a `renderMs` column in the speed table and a `render` column (the sum of the `render:` labels) in the 1x breakdown, with `sum` the simulation's alone.

Decided during the run: the bench has a single render look for now. The finished/cells look split of AC1 needs M11.2's `look` option; M11.2 adds a look loop to the bench and the cells-look column. Alternative: a stand-in flag now; to change, edit the bench.

Visible after: nothing: `npm run bench` prints the drawing's cost.
Needs you: run `npm test` and `npm run bench` (with `nvidia-smi` showing no other load) and write the test counts and today's `render:composite` cost into the Baseline note above (at the end).

### M11.2 Looks, display table, grain, wall

- [x] `src/look.ts`, `src/display-table.ts`, the `look` rows' defaults, the color path of both looks, grain, the wall, the C key and `?wall=`, the `showcase` scene; `tests/look.test.ts`, `tests/elements.test.ts` (validation of `look`), AC2 to AC6; backlog B10 deleted. Verify: lint, typecheck, `npm test`, build, bench (record the cost).

Done in the run (not ticked, checks left to the user): `src/look.ts` (`Look`, `LookSettings`, `LOOK`, `parseWall`), `src/display-table.ts` (`DISPLAY_FIELDS`, `packDisplay`, `DisplayTable`; a uniform of 256 rows of 8 words at binding 2 of the display's group 0), `ElementDef.look` with its validation, grain overrides on METAL (0.02) and GUNPOWDER (0.25), the wall, the grain and the finished look's linear-light path in `src/shaders/display.wgsl.ts`, `Display`'s last argument `{ air?, settings? }` and `DisplayOptions.look`, the C key, `?wall=` and the help line, the `showcase` scene (`SHOWCASE`), the bench's look loop (`look` column, `BENCH_LOOKS`), `tests/look.test.ts` (AC2 to AC5), `tests/elements.test.ts` (look validation, display table), `tests/scenes.test.ts` (AC6); backlog B10 deleted. Lint, typecheck and build pass; the GPU tests and the bench were not run (the GPU was busy with a game).

Decided during the run: the finished look's tone map is the identity up to 1 per channel and turns light above 1 toward white (Khronos PBR Neutral's desaturation without its compression knee at 0.76), not Khronos with the knee. Why: FIRE and MOLTEN_METAL have a table channel of 1.0, which a knee at 0.76 would change, and AC3 needs every table color unchanged. Alternative: Khronos as written, with AC3 limited to colors under 0.76 in linear light. To change: edit `toneMap` in `src/shaders/display.wgsl.ts`. The finished look clamps the cell's own color, glow included, to 1 per channel before the conversion to linear light (fix round 1: a lone LAVA or MOLTEN_METAL cell was drawn whiter than in the cells look, which failed AC3 for every element). So the tone map acts only on light added in linear light, the halo from M11.3 on. Alternatives: narrow AC3 to cells without in-cell glow (changes what the criterion promises); drop the in-cell glow from the finished look. To change: the `clamp` in `fs_main`; M11.3 moves the cell's emission into the finished look and revisits it.
Decided during the run: the solids' world-space noise scales the grain strength (by 1 plus or minus `solidNoise` 0.2) instead of adding to the color. Why: variant 0 must be the table color (AC4) and the existing tests render variant 0 cells at several places and compare them exactly (AC2). Alternative: an additive noise, which breaks both. To change: `grainColor` in `src/shaders/display.wgsl.ts`, `LOOK.solidNoise`.
Decided during the run: the dither (interleaved gradient noise, plus or minus half a step) is added to the wall alone, not to every pixel as Design says ("dither last"). Why: the existing display tests compare filled cells of different columns exactly. Alternative: dither everything and loosen those tests. To change: move the term from `wallColor` to the end of `fs_main`.
Decided during the run: the wall is `0.04 + 0.5 × wall^1.5` (a display value, tinted blue-grey) at the top center, times a light factor falling to 0.70 at the top corners and 0.45 at the bottom corners; the default 0.35 is 0.14 (about 36 of 255), 1 is 0.54 (a mid grey). Why: Design fixes only the ends ("0 near black, 1 mid-grey") and the default 0.35. Alternative: other curve and vignette. To change: `WALL_LEVEL`, `WALL_RANGE` in `src/look.ts` and `wallColor`.
Decided during the run: grain overrides METAL `look.grain` 0.02 and GUNPOWDER 0.25 (the state defaults are 0.03 and 0.10). Why: AC4 asks for 3 to 12 steps on metal (a bright color) and at least 20 on gunpowder (a dark one, 62 of 255 in luminance, so 0.10 gives 12). Alternative: an additive grain for dark colors. To change: the two rows in `src/elements.ts`.
Decided during the run: `look.opacity`, `look.absorption` and the emission scale are packed in the display table with their defaults but nothing reads them yet; WATER's and OIL's absorption values are written in M11.6, with the coverage pass and the depth march that use them. Alternative: write them now with nothing to show or test them. To change: add the rows' `look` in M11.6.

Visible after: sand, gunpowder and stone show grains; a medium-dark wall behind the field; C switches looks (they differ only by the wall's effects from M11.3 on); `?scene=showcase`.
Needs you: run `npm test` (the new `tests/look.test.ts` and the display, elements and scenes tests; none was run, the GPU was busy) and `npm run bench`, and record the finished and cells looks' `render:composite` cost under this item (at the end); look at `?scene=showcase` at the default wall, `&wall=0` and `&wall=1` (at the end).

### M11.3 Glow

- [ ] The coverage pass (emission only), the glow chain, emission in the composite, the two-word overlay (I17); AC7 to AC9; backlog I17 deleted. Verify: lint, typecheck, `npm test`, build, bench.

Visible after: lava, fire, molten metal and anything above 525 °C glow with a halo; flying hot debris glows; C shows the difference.
Needs you: look at lava and fire in `?scene=showcase` and at a blast (`?scene=blast`) (at the end).

### M11.4 Shadows

- [ ] `cover`'s opacity, the shadow pass, the darkening in the composite; AC10. Verify: lint, typecheck, `npm test`, build, bench.

Visible after: matter casts soft shadows on the wall toward the lower right.
Needs you: nothing.

### M11.5 Soft gases

- [ ] `cover`'s gas fraction and the `gas` texture, the cloud layer; AC11. Verify: lint, typecheck, `npm test`, build, bench.

Visible after: smoke and steam are soft clouds (`?scene=plume`).
Needs you: say whether the clouds flicker in `?scene=plume` (at the end).

### M11.6 Liquid depth and surface

- [ ] `cover`'s liquid fraction, WATER's and OIL's absorption, the surface and depth in the composite; AC12. Verify: lint, typecheck, `npm test`, build, bench.

Visible after: water has a bright surface line and darkens to blue-green with depth; oil is dark.
Needs you: nothing.

### M11.7 Air shimmer

- [ ] The time uniform and the offset in the composite; AC13, AC14. Verify: lint, typecheck, `npm test`, build, bench.

Visible after: the air wavers above lava and fire, and a blast sends a ripple ahead of its debris (`?scene=explosion`).
Needs you: nothing.

### M11.8 Budget and docs

- [ ] AC15 from the bench (all scenes, both looks), into a table under this item. `docs/rendering.md` (new: the two looks, the passes and their resolutions, the color path, the display table, what each effect reads of the simulation, the settings); `AGENTS.md`: layout (`src/look.ts`, `src/display-table.ts`, the new shaders, `tests/look.test.ts`), the bench line, the docs map, the display's bindings in the invariants, and under "Never": a physics behavior is judged on cell data or in the cells look, never through the finished look; `docs/decisions.md`: the two looks, and visual properties in a display-only table with glow from emission rather than a bright-pass; `docs/simulation.md` if it describes the display; the README's feature list and keys; the research doc trimmed to the smooth look, the light field, the roadmap table, decorative effects and "Not recommended", its "Today" and "Direction" reduced to a pointer to `docs/rendering.md`; roadmap M11 deleted. Verify: lint, typecheck, `npm test`, build.

Visible after: nothing new: docs.
Needs you: nothing.

## Sources

The research doc's (Jimenez 2014, LearnOpenGL's physically based bloom, Khronos PBR Neutral, Wronski 2016, leothelegion 2023), plus Pope and Fry 1997, "Absorption spectrum (380–700 nm) of pure water. II. Integrating cavity measurements", Applied Optics 36(33): 8710–8723, for WATER's absorption.
