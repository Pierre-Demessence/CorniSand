# I31 Scene menu

Status: I31.1 to I31.3 done; the user's review asked for one-line descriptions, a search bar and a menu that scales to hundreds of scenes (I31.4 and I31.5, written in as accepted, awaiting the user's approval). Next: I31.4. The Finish step is at the end of I31.5.

## Goal

A Scenes button in the toolbar lists every scene the game has, grouped (liquids, heat, air, labs, real-world scenarios), each with a name and one line saying what to watch; picking one opens it, so nobody has to guess `?scene=` names. The menu stays quick to use with hundreds of scenes: a search bar, categories, variants folded into one row. A real-world scenario's target, waiting time and state are shown in the scene itself by I33 (roadmap M15.1), not in the menu.

## Scope

In: per-scene menu info; the menu; every scenario variant the tests build registered as its own scene; `sealedBars`, `coolingBlock` and `heatedPot` built as scenes; the docs below.

Not in: save files (I32; scenes stay code: `docs/decisions.md` entry below), a live readout of a scenario's measurement in the game (I33, roadmap M15.1; it also carries the target, the waiting time and whether the game passes yet), loading a scene without a page reload, `freezingPond` and `sandPile` as scenes (a test-only ceiling row, a brush pour; the `physics` lab shows both).

## Choices approved by the user

1. Picking a scene reloads the page at `?scene=<key>`: the link stays shareable, back works, one loading path; what was painted is lost.
2. Scenes stay code, not save files; saves are a later feature of their own.
3. Each variant is its own entry; the three renamed scenarios that can be scenes become scenes.
4. (After the first review.) Descriptions are one line, scenarios included: target and waiting time move to I33's in-scene readout; the waiting state stays in the menu as a field of its own. The menu is a centered panel with a search bar (label, description and group), a category list with counts, variants folded into one row with version chips, keyboard navigation. A scenario that waits for a mechanic says so in its row ("Waits for I26") and is listed in its own category, apart from the scenarios that pass; no recent list.

## Acceptance criteria

Tests titled `I31 AC<n>:`.

- AC1 Every key of `SCENES` SHALL have a `SCENE_INFO` entry (label, group, description, all non-empty) and every `SCENE_INFO` key SHALL be a scene (unit, `tests/scenes.test.ts`). A later plan adding a scene without info fails it.
- AC2 `sceneMenuGroups(SCENE_INFO)` SHALL return the groups in `SCENE_GROUPS` order, scenarios last, empty groups left out, each scene in exactly one group in registry order (unit, `tests/scene-menu.test.ts`).
- AC3 `sceneSearch(search, key)` SHALL set `scene` and keep every other parameter (`air`); `sceneSearch(search, null)` SHALL remove `scene` (unit).
- AC4 WHEN the user clicks Scenes (or focuses it and presses Enter), THE panel SHALL list "Empty world" then every scene by group with its label and description; the current one has a border, bold label and the text "current" (not color alone); Escape, the button again or a click outside closes it (browser check).
- AC5 WHEN a scene is picked, the page SHALL reload at its URL with the other parameters kept, and the grid info SHALL show the scene's label (browser check, two scenes and Empty world).
- AC6 WHEN `?scene=` names no scene, the world SHALL start empty as today and the menu SHALL mark Empty world current (browser check).
- AC7 Every variant a scenario test builds through a builder parameter (fast/full, the two `heatedLayer` layers, the two `hourglass` outlets, `steamBurn`'s water case, any other the M8.9 run added) SHALL be registered as `<name>-<version>` with its own info, and `findScene` SHALL return the same cells as the builder called with that variant (unit).
- AC8 `sealedBars` (one key per material), `coolingBlock` and `heatedPot` SHALL be built in `src/scenarios.ts`, their tests SHALL build from them, and those tests SHALL pass with their bars unchanged; while both exist, a one-off check SHALL show the new builders give the same fields as the test setups bit for bit (then the test setups are deleted).
- AC10 Every description SHALL fit one line: at most 110 characters, one sentence, no line break; scenarios included (unit, `tests/scenes.test.ts`). A scenario's description says what to watch; a target in it is allowed only when it fits and changes with the test's target.
- AC11 `sceneMenuFilter(info, query, category)` SHALL return the scenes whose label, description or group label contain every word of the query (case and accents ignored), across all categories when the query is not empty, in registry order, with a variant row folded under its family (unit, `tests/scene-menu.test.ts`).
- AC12 WHEN the menu opens, THE search field SHALL have focus; typing filters at once; Arrow Up and Down move the highlighted row, Enter opens it, the first Escape clears the search and the second closes the menu; a query with no match shows "No scene matches" (browser check).
- AC13 WHEN the window is wide, THE menu SHALL show the category list beside two columns of one-line rows, and at phone width the categories become a row of chips above one column; the panel never needs horizontal scrolling and scrolls only its list (browser check at 1280 and 390 px).
- AC14 WHEN a family has variants, THE menu SHALL show one row with a chip per version (the main version first), and the row and each chip open their own scene; the current scene's row or chip carries the border, bold label and the word "current". (browser check).
- AC15 `SceneInfo` SHALL have an optional `waitsFor: string[]` (roadmap or backlog IDs), the one place that says a scenario does not pass yet: every scenario test takes its waiting state from it, so the test titles (`[waits for <ID>]`) and the menu cannot disagree; a scene with `waitsFor` SHALL be in the scenarios group, and a `waitsFor` on any other scene fails (unit, `tests/scenes.test.ts`).
- AC16 WHEN a scene has `waitsFor`, THE menu SHALL show in its row the text "Waits for <IDs>" (a text badge, not color alone) and list it under the category "Waiting for a mechanic" and not under "Real-world scenarios"; "All" and the search list it with its badge (unit for the category split in `sceneMenuFilter`/`sceneMenuGroups`, browser check for the badge).

## Design

- **Info.** `SceneInfo { label, group, description }` and `SCENE_GROUPS` (ordered: liquids, motion, heat, air, labs, scenarios) in `src/scenes.ts`; `SCENE_INFO: Record<string, SceneInfo>` beside `SCENES`, spreading `SCENARIO_INFO` from `src/scenarios.ts` as `SCENES` spreads `SCENARIO_SCENES`. `SCENES` keeps its type (`() => Scene`), so the tests that use it do not change and the menu never builds a scene to read its label (`blast` and `physics` are large).
- **Menu.** `src/scene-menu.ts`: the pure `sceneMenuGroups` and `sceneSearch` (AC2, AC3) and `renderSceneMenu(button, panel, info, current)`; `main.ts` wires it and sets `location.search`. A "Scenes" button at the start of the toolbar's status part (M8.1's picker replaces the element buttons, not that part), its panel above the toolbar, scrolling vertically when taller than the window, tokens of the existing toolbar styles in `index.html`. Description text is set with `textContent`.
- **Grid info** shows the label instead of the key.
- **Variants.** A scenario builder with a variant parameter is registered once per variant by a small loop in `src/scenarios.ts`, the main version under the bare name (as M8.9 registered it).
- **Descriptions** are one line (AC10), from each test's comment; a target written in one changes with the test's target, in the same commit (`AGENTS.md`, "Real-world scenarios").
- **Menu v2.** `SceneInfo` gains `family?: string` (the main scene's key) and `version?: string` (the chip's label: "fast", "full", "steel"); the main version has neither or names itself. `SceneInfo` also gains `waitsFor?: string[]` (AC15). The pure `sceneMenuFilter` (AC11) lives in `src/scene-menu.ts` beside `sceneMenuGroups`, which derives the categories: the groups of `SCENE_GROUPS`, with the scenarios that have `waitsFor` moved out of "Real-world scenarios" into a last category "Waiting for a mechanic" (a virtual category: the scene's `group` stays `scenarios`, so a scene moves when its item lands and `waitsFor` is deleted, with no other edit). Tests read `SCENE_INFO[name].waitsFor` where they call `scenario({ waitsFor })` today. The panel is a centered dialog over a dimmed backdrop (`min(960px, 100vw - 32px)` by `min(640px, 100vh - 64px)`), header with the search field and a result count, a category list on the left ("All", then the categories with counts), the rows in a grid of two columns that scrolls alone. A row is label plus its description on one line, cut with an ellipsis, the full text in the row's accessible name. Focus stays in the search field while Arrow keys move the highlight (`aria-activedescendant`); Tab still reaches every control. Colors are the toolbar's tokens; the current scene is shown by border, bold and text, never color alone. No new dependency.
- **Moving the three setups** changes no cell: copy each setup into a builder, compare fields with the test's own setup once, then point the test to the builder and delete the old setup. `tests/scenes.test.ts` already skips scenario scenes in the element-temperature check.
- **Failure modes.** An unknown key in the menu cannot happen (built from `SCENE_INFO`, AC1 ties it to `SCENES`); a scene too large for the device is today's behavior, unchanged.

## Checklist

### I31.1 Menu

- [x] `SceneInfo`, `SCENE_GROUPS`, `SCENE_INFO` for every scene registered at that time (labels and descriptions written from the builders' comments; scenario entries are I31.2's), `SCENARIO_INFO` (empty or partial until I31.2), AC1 in `tests/scenes.test.ts`.
- [x] `src/scene-menu.ts`, `tests/scene-menu.test.ts` (AC2, AC3), the button and panel in `index.html` and `main.ts`, the grid info label.
- [x] Browser check of AC4 to AC6 (Sonnet sub-agent with Playwright, on the user's running dev server if there is one, else its own on another port; no localStorage touched).
- [x] `AGENTS.md` layout (`src/scene-menu.ts`, `SCENE_INFO`) and rule: a new scene gets its `SCENE_INFO` entry; README: the scene lists point to the Scenes menu; `docs/decisions.md` entry "Scenes are code; saves are a format of their own": scenes are builders with named regions the tests measure, variants as parameters, always on the current element table and cell format; save files would freeze them, go stale with each field or default change and make test setups unreviewable; rejected: scenes as save files.
- [x] Verify: lint, typecheck, `npm test`, build.

Decided during the run: `SCENARIO_INFO` has a short entry (label, group, description with the target where the test states one) for each of the nine scenario scenes registered today, not an empty or partial one, because AC1 requires an entry for every key of `SCENES`. I31.2 rewrites them with AC9's content (target, waiting time) and adds the variants. Alternative: leave the scenarios out of `SCENE_INFO` until I31.2 and weaken AC1 meanwhile; change by editing `SCENARIO_INFO` in `src/scenarios.ts`.
Decided during the run: `renderSceneMenu` takes a fifth argument, `onPick(key | null)`, so that `main.ts` sets `location.search` (with `sceneSearch`) and the module stays free of `window`; the plan's signature listed four. The panel's open and close handling (button, Escape, click outside) lives in `renderSceneMenu` too.
Decided during the run: the browser check of AC4 to AC6 ran in the same session with Playwright on a dev server started on port 5199 and stopped afterwards, rather than in a sub-agent; no localStorage was touched.

Visible after: the Scenes button and its list; picking a scene opens it.
Needs you: open the menu, pick two scenes and Empty world, say if anything reads wrong (at the end).

### I31.2 Scenario entries

- [x] Info for every scenario scene, with AC9's content; variants registered (AC7).
- [x] `sealedBars`, `coolingBlock`, `heatedPot` as scenes (AC8) in `src/scenarios.ts`, their tests in `tests/physics.test.ts`, `tests/air-heat.test.ts` and `tests/convection.test.ts` built from them.
- [x] Rule in `AGENTS.md` "Real-world scenarios": a scenario's description states its target and changes with it.
- [x] Verify: lint, typecheck, `npm test`, build; the menu shows the scenarios group (browser check).

Decided during the run: the versions of a scenario are registered by what its tests build through a builder parameter: `iceCup` (full) and `iceCup-fast`, `steamBurn` (steam) and `steamBurn-water`, `heatedLayer` (above) and `heatedLayer-below`, `hourglass` (outlet 8) and `hourglass-wide` (outlet 16), `sealedBars` (steel), `sealedBars-stone` and `sealedBars-ice`. `redHotBar`'s fast and full versions differ only by target (the same scene), so it has one entry stating both targets, as do the scenarios whose versions swap an element for a control. Alternative: one more key per target. Change by editing `SCENARIO_SCENES` and `SCENARIO_INFO` in `src/scenarios.ts`.
Decided during the run: in `heatedPot`, the floor and ceiling rows of WALL carry the scene canvas's temperature word (20 °C) where the old test setup held 0; the one-off comparison showed every other field, and every cell that holds heat, bit for bit equal. A WALL cell's temperature is never read (it holds no heat), and the test's bars are unchanged. Alternative: write 0 into those rows to match the old setup. Change by adding a `fillTemp` in `heatedPot`.
Decided during the run: a scenario's description also says when its test waits for an item (`waitsFor`), and the `AGENTS.md` rule says so, so that a description opened from the menu does not promise a pass the game cannot give; the plan's rule listed the target only. Alternative: leave the waiting state to the test titles. Change by editing the rule in `AGENTS.md` and the descriptions.
Decided during the run: the Finish step (I31 deleted from the backlog and from the roadmap's Order line, this plan deleted) is not done in this run: a run never deletes its plan until the user says "finish".

Decided during the run: `hourglass-wide`'s description gives the wait of the rate window as measured today (about 23 s, the game's rate is 1.85 times the 8-cell one) and as it would be at the target rate (12 to 15 s), because the test waits for B17 and the live wait changes when it passes. Alternative: state only the target's wait. Change by editing the description.

Visible after: the menu's real-world scenarios group, each saying what to expect and how long to wait, with the fast and full versions as separate entries.
Needs you: open `iceCup` and one waiting scenario (`redHotBar`) from the menu and say whether the description tells you what to look for (at the end).

### I31.3 One-line descriptions

- [x] Rewrite the description of every scene (about 34) to one line of at most 110 characters, from each test's comment; drop wait times and waiting states from them; AC10 in `tests/scenes.test.ts`.
- [x] `waitsFor` (AC15, AC16's data): add it to every scenario scene whose test waits today and make the scenario tests read it (`tests/scenario.ts` helper and the scenario test files); the one-line descriptions then say nothing of waiting.
- [x] `AGENTS.md` "Real-world scenarios", "Described in the menu": one line saying what to watch, a target only when it fits; the target, the waiting time and the waiting state belong to I33's readout. `docs/backlog.md` I33: add that the readout also shows the target and the waiting time in game time. The rule "A scenario that starts passing before its item" also says that the commit that makes a scenario pass deletes its `waitsFor`.
- [x] Verify: lint, typecheck, `npm test`, build.

Decided during the run: `waitsFor()` in `tests/scenario.ts` reads a scene's `SCENE_INFO` entry and takes an optional narrowing (`waitsFor('hourglass', 'B17')`), checked against the entry, so a check that waits for only some of the scene's items keeps its exact `[waits for ...]` title (`redHotBar` fast waits for I26 only; the `hourglass` ratio for B17, its angles for B18). Alternative: every check of a scene takes the whole list. Change by dropping the narrowing arguments.
Decided during the run: descriptions that state a target keep it only where it fits in 110 characters (`iceCup` 10 °C, `contactTemp` 71 °C, `redHotBar` 715-755 °C, `viscousSpread`, `freeFall`, `sealedBars`, `coolingBlock`, `heatedPot`, `hourglass`, `heatedLayer`); `lavaCrust` and `heatedLayer-below` name none. Alternative: no target in any description. Change by editing `SCENARIO_INFO`.
Decided during the run: AC10's one-sentence check is "no `.`, `!` or `?` followed by whitespace and more text", and `DESCRIPTION_MAX` (110) is exported from `src/scenes.ts` for I31.5 to reuse.

Visible after: the menu's entries are one line each.
Needs you: nothing.

### I31.4 Menu search and families

- [ ] `SceneInfo.family` / `version` on the variants registered in I31.2 (AC7 keys keep their names); `sceneMenuFilter` and the category split with their unit tests (AC11, the unit part of AC16).
- [ ] Verify: lint, typecheck, `npm test`, build.

Visible after: nothing: the panel still shows the old list; I31.5 uses these.
Needs you: nothing.

### I31.5 Menu panel

Depends on: I31.4

- [ ] Rebuild the panel in `src/scene-menu.ts`, `index.html` and `main.ts` as the Design describes: search field, category list, two-column rows, chips, the "Waits for" badge and its category, keyboard handling, empty state, phone layout.
- [ ] Browser check of AC4 to AC6 (as before, still valid) and AC12 to AC14 and AC16 at 1280 and 390 px (Sonnet sub-agent with Playwright, own dev server on another port; no localStorage of the user touched).
- [ ] `AGENTS.md` layout line for `src/scene-menu.ts`; README sentence if it describes the old list.
- [ ] Verify: lint, typecheck, `npm test`, build.
- [ ] Finish: I31 deleted from the backlog and from the roadmap's Order line, this plan deleted in the commit.

Visible after: the new Scenes panel: type to search, pick a category, arrow keys and Enter, variants as chips, a badge on scenarios that wait for a mechanic.
Needs you: open the menu on desktop width and in a narrow window, search for "ice", step through with the arrows, open a variant chip, look at the "Waiting for a mechanic" category, and say if anything is awkward to use (at the end).
