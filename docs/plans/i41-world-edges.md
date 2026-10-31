# I41 World edges

Status: approved; the GPU bench steps are left out at the user's request (no bench before or after, no `Bench pending`); next I41.4.

## Goal

Each side of the world (left, right, floor, top) is open or closed, and the player switches each one while playing. Through an open side matter leaves the world for good while pressure and heat pass to the rest of the world at room temperature; a closed side is an endless wall for matter, pressure and heat alike. By default the floor is closed and the sides and top are open, so sand still piles on an empty screen while smoke and steam leave through the top.

## Choices

1. Per-side switches in the game, the floor closed by default (sides and top open).
2. A closed side seals the air too: one switch per side for matter, pressure and heat, no separate air switch.
3. No hidden margin of cells beyond the screen: matter is deleted as it crosses an open side, as in The Powder Toy.
4. Grains thrown out through an open top are gone like any other matter (falling back in is backlog I42).
5. Scenes carry no edges: the edges are the player's, and a scene that needs a side closed draws a wall there.

## Acceptance criteria

- AC1: WHEN a side is open, a powder, liquid or gas cell that moves past it leaves the world: a column of sand over an open floor empties, water released against an open side drains through it, smoke under an open top leaves through it (each scene's cell count reaches 0). WHEN the side is closed, the same scenes keep every cell. Check: `tests/edges.test.ts`.
- AC2: WHEN a position past the grid is beyond two sides (a corner), it is closed if either side is: sand sliding along a closed floor leaves through an open left side, and sand against an open left side above a closed floor never falls through the corner. Check: `tests/edges.test.ts`.
- AC3: WHEN a flyer's path crosses an open side, the flyer is removed and the particle count drops by one; WHEN the side is closed, it lands against the edge as before. Check: `tests/edges.test.ts`, a cell given a launch-speed velocity toward each side.
- AC4: WHEN all four sides are closed, cells and flyers behave bit for bit as before this plan: through I41.1 (whose default is all closed) every existing test passes unchanged. Check: `npm test`.
- AC5: WHEN a side is closed, the air does not pass it: a pressure pulse reflects off a closed side with no wall drawn as it does off the drawn wall ring of the open-edge control in `tests/air.test.ts` (above 0.5 of the arriving wave), and in a world closed on all four sides with no wall drawn, the total heat C·T of cells and air stays within the sealed box's tolerance in `tests/air-heat.test.ts`. WHEN all sides are open, the open-edge test of `tests/air.test.ts` (echo under 30%, pressure under 5% within 65 supersteps) passes unchanged. Check: those two files.
- AC6: WHEN no edges are given, the floor is closed and the other sides open, in `Simulation` and in the game: sand poured on an empty grid piles on the floor and smoke leaves through the top. Check: `tests/edges.test.ts`.
- AC7: WHEN the player toggles a side in the Edges panel, it applies from the next frame and the world is kept; each side shows its state in text and by line style (solid closed, dashed open); the choice is kept in `?edges=`, so a reload or a scene pick keeps it, and the default writes no parameter. WHEN `?edges=` holds an unknown side name, the game warns in the console and uses the default. Check: unit tests of `parseEdges`/`formatEdges`, a headless browser check.
- AC8: The block-locality test passes with all sides open and all sides closed. Check: `tests/block-locality.test.ts`.
- AC9: No scenario's target or tolerance changes. A test whose scene relies on an edge states the edges it runs with; a regression bar that moves under every edge setting is re-measured, before and after logged under I41.2. Check: review of the diff.
- AC11: `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass after each item.

## Design

**Model.** A closed side is a WALL beyond the grid: matter stops, the air's faces on it are closed, and no heat crosses (WALL holds none). An open side is today's open air edge (pressure 0, room temperature beyond) and deletes matter that crosses it. A position beyond two sides is closed if either is.

**`src/edges.ts`.** `Side` (`'left' | 'right' | 'bottom' | 'top'`), `Edges` (`Record<Side, 'open' | 'closed'>`), `DEFAULT_EDGES` (bottom closed), `ALL_OPEN`, `ALL_CLOSED`, `edgesWord(edges)` (one bit per open side), `parseEdges`/`formatEdges` for the URL: the value lists the closed sides by name, comma-separated (`bottom` is the default and is not written, `none` is all open, `left,right,bottom,top` all closed).

**Reaching the passes.** `Simulation` takes `edges` (default `DEFAULT_EDGES`; `ALL_CLOSED` during I41.1) and `setEdges(edges)`, applied from the next `simulate`. The word goes to the CA as a third word of `StepUniforms` (written with the slots each frame) and to the flight and mask passes in one small uniform buffer that `setEdges` writes. No pipeline is recompiled and no buffer reallocated; uniforms do not count toward the 8 storage buffers.

**CA.** `readCell` returns WALL out of bounds when the position is beyond a closed side, else EMPTY (zero velocity, so the inert skip and the launch count still hold); `writeCell` already skips out-of-bounds writes, so a cell moved there is gone. After the movement phases (0–3), out-of-bounds slots are reset to EMPTY, so lifetimes, rules, ignition, conduction and phase changes never see a leaving cell; `releaseBurst` gets a bounds guard as well (it has none, `ca.wgsl.ts`). Slots stay `blk0`–`blk3`.

**Flyers.** In `walk`, a step past an open side is an exit: the flyer is marked LANDED with no grid write, the path the brush removal takes (`flyerBrushWGSL`), so flight, the landing count, compaction and the overlay drop it and `state.landed` stays unchanged. A step past a closed side is a hit, as today.

**Air.** The mask pass sets the openness of a closed side's edge faces to 0: the ghost cells' faces on the left and bottom, and the faces at `NX·s` and `NY·s` on the right and top, so an air cell hanging over the grid's edge counts as inside. That closes the velocity, pressure, advection and diffusion passes at once. `KEEP_EDGE` damping stays on every side: the drawn wall ring already reflects above 0.5 with it, and pressure is not conserved anyway (`AIR.pressureLoss`). The sampled gradient stays 0 on edge faces; the exchange pass and the display's edge blending are unchanged.

**UI.** An Edges button in the status bar after Scenes opens a small panel: four toggles around a square (Top above, Left and Right beside, Floor below), each labeled with its side and state ("Floor: closed") and drawn as a solid bar (closed) or a dashed one (open). A click calls `setEdges` and rewrites `?edges=` with `history.replaceState`, so `sceneSearch` keeps it; Escape or a click outside closes the panel. Device re-creation in `main.ts` keeps the current edges. A prototype control (the UI is redesigned once all features exist).

**Tests.** `createSim` uses the `Simulation` default. Migration rule for I41.2: a test that fails under the new default gets the edges its scene relies on, with a comment (conservation and bare-grid scenes with matter at a side: `ALL_CLOSED`; open-air tests such as the open-edge test of `tests/air.test.ts`, `coolingBlock` and the 2×1 grids "alone with the world's edge": `ALL_OPEN`); a bar that moves under every setting is re-measured and logged; a scenario that misses its target under the edges of its experiment blocks the item. Likely candidates (from a survey, not run): `simulation.test.ts` D5, `air-wind`, `air-burst` AC27, `air-heat` AC16, AC17, AC28 and the 16×16 block, `display` edge blending. The bench (`tests/bench.gpu.ts`) is set to `ALL_CLOSED` so a full grid keeps its matter, but is not run in this plan.

**Left out.** The closed floor holds no heat, where real ground takes some. No wrap-around mode (The Powder Toy's third edge mode).

## Checklist

### I41.1 Matter leaves through open sides

- [x] `src/edges.ts` without the URL helpers; `Simulation` `edges` option (default `ALL_CLOSED` in this item), `setEdges`, the uniform and the `StepUniforms` word.
- [x] CA: `readCell` by side, the out-of-bounds reset after phase 3, the `releaseBurst` guard.
- [x] Flyers: the exit through an open side.
- [x] `tests/edges.test.ts` for AC1–AC4; `tests/block-locality.test.ts` with `ALL_OPEN` as well (AC8).
- [x] `docs/simulation.md` "Boundaries" and "Flyers"; `AGENTS.md` invariants on out-of-bounds reads and flyers, and `src/edges.ts` in Layout.

Decided during the run: `setEdges` only stores the edges and `simulate` writes the edges uniform buffer (with the step slots) each frame, instead of `setEdges` calling `writeBuffer` itself. Why: the change then applies from the next `simulate`, as the plan says, even when `setEdges` is called between recording a frame and submitting it, and one place writes both copies of the word. The alternative is a `writeBuffer` in `setEdges`; to change it, move the 4-byte write from `simulate` into `setEdges`.
Visible after: nothing: the game still runs with every side closed; only the tests open them.
Needs you: nothing.

### I41.2 Closed sides seal the air; the floor-only default

- [x] Mask pass: bind the edges uniform, close a closed side's edge faces; tests for AC5.
- [x] `Simulation` default to `DEFAULT_EDGES`; the AC6 test; migrate the suite by the rule above and log every re-measured bar here.
- [x] `docs/simulation.md` "Walls and edges", the `AGENTS.md` air invariant ("The world's edge is open air…"), `README.md` (the air line).

Decided during the run: the mask pass binds the edges uniform that `Simulation` already writes each frame (the `AirGrid` constructor takes the buffer, group 3 of the mask pipeline), instead of `AirGrid` owning a second copy of the word. Why: one writer, and the air sees the same edges as the CA and the flight pass in the same frame. The alternative is a separate uniform written by `setEdges`; to change it, give `AirGrid` its own buffer and a `setEdges`.
Decided during the run: tests whose experiment needs matter or air kept at a side run with `ALL_CLOSED`, stated in the test or in its `NO_AIR` constant (`heat`, `materials`, `molten`, `physics`: the existing `NO_AIR` options gain `edges: ALL_CLOSED`; `simulation` fire-burns-oil, AC7 smoke, D5 and AC9; `air-matter` AC7/AC8; `air-heat` AC17); `air.test.ts` AC4 runs `ALL_OPEN`. Every such run is bit for bit what it was under I41.1's default, so no bar of those moved. The alternative is a per-test wall box; to change it, draw walls and drop the option.
Re-measured bar (AC9): `air-heat` AC17 (steam in a box, M8.8 AC8). Before: the box's air had an open edge and the matter did not, mean steam temperature 96.3 °C after 3,600 supersteps, bar under 100. After, in a world closed on all sides (the steam must stay in; with an open top it leaves): 105.4 °C, bar under 108, because the sealed box's air cannot carry the heat away. Steam count stays 64 and the no-air control stays at 110.
Tests added for AC5: `tests/air.test.ts` (all four sides closed with no wall drawn reflect the pulse over 0.5, each side closed alone at size 4; the open-edge tests run `ALL_OPEN`) and `tests/air-heat.test.ts` (a world closed on all sides with no wall drawn keeps its total heat within 1e-4 over 1,000 supersteps, with an all-open control that loses over 1%); AC6 in `tests/edges.test.ts`. The bench (`tests/bench.gpu.ts`) is set to `ALL_CLOSED`, not run.
Visible after: in every scene and on an empty field, smoke, steam and other gases leave through the top, and sand or water that reaches a side leaves through it; things still pile on the floor; heat and pressure still leave through the top and sides, but no longer through the floor.
Needs you: nothing: covered by tests (`?scene=plume` shows smoke leaving through the top).

### I41.3 The Edges panel and `?edges=`

- [x] `parseEdges`/`formatEdges` with unit tests; `main.ts` reads `?edges=` (a warning and the default on a bad value), passes it to `Simulation`, keeps it on device re-creation.
- [x] The panel and its button as in Design, wired in `main.ts`; unit tests for its labels and the URL it writes; a headless browser check that a toggle changes the side, keeps the world and survives a scene pick.
- [x] `AGENTS.md` Layout (`main.ts`, the panel's file), `README.md` feature list.

Decided during the run: an empty `?edges=` value is unknown (warning and the default), as is `none` among other names; only `none` alone means all open. Why: `formatEdges` never writes an empty value, and the plan names only `none` for all open. The alternative is reading an empty value as all open; to change it, return `ALL_OPEN` for an empty value in `parseEdges`.
Decided during the run: the panel's pure parts (`edgeLabel`, `edgesSearch`) are tested without a DOM (the suite has no DOM environment); the toggle, URL write, Escape and outside-click closing were checked in headless Chrome (a toggle of the floor emptied 5.6K sand to 0, `?edges=none` written, kept on reload with a scene, `?edges=sky` warned and gave the default).
Visible after: an Edges button in the status bar; each side can be opened or closed while playing, and the choice survives a reload and a change of scene.
Needs you: a look at the panel: open the game, paint sand on the floor, click Edges and open the floor; expected: the sand falls out of the screen and Floor reads "open" with a dashed bar (at the end).

### I41.4 Docs and finish

- [ ] `docs/decisions.md`: one switch per side for matter and air together, the floor-only default, no hidden margin.
- [ ] Delete backlog I41 and I41 from the roadmap's Order line; on "finish", delete this plan.

Visible after: nothing: docs.
Needs you: nothing.
