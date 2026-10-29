# I31 Scene menu

Status: approved; starts once the M8.9 run has ended: that run edits `src/scenes.ts`, `src/scenarios.ts`, the scenario tests, `docs/backlog.md` and `AGENTS.md`, which this plan edits too. Next: I31.1.

## Goal

A Scenes button in the toolbar lists every scene the game has, grouped (liquids, heat, air, labs, real-world scenarios), each with a name and one line saying what to watch; picking one opens it, so nobody has to guess `?scene=` names. Each real-world scenario says what reality does and what the game should show (the cup should end at 10.0 °C), so the experiments the tests run without a picture can be checked by eye.

## Scope

In: per-scene menu info; the menu; every scenario variant the tests build registered as its own scene; `sealedBars`, `coolingBlock` and `heatedPot` built as scenes; the docs below.

Not in: save files (I32; scenes stay code: `docs/decisions.md` entry below), a live readout of a scenario's measurement in the game (I33), loading a scene without a page reload, `freezingPond` and `sandPile` as scenes (a test-only ceiling row, a brush pour; the `physics` lab shows both).

## Choices approved by the user

1. Picking a scene reloads the page at `?scene=<key>`: the link stays shareable, back works, one loading path; what was painted is lost.
2. Scenes stay code, not save files; saves are a later feature of their own.
3. Scenario entries state their target; each variant is its own entry; the three renamed scenarios that can be scenes become scenes.

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
- AC9 Every scenario's description SHALL state its experiment, its target as the test states it, and how long to wait in game time (1x is real time: 240 supersteps per second at 60 fps) (review against each test).

## Design

- **Info.** `SceneInfo { label, group, description }` and `SCENE_GROUPS` (ordered: liquids, motion, heat, air, labs, scenarios) in `src/scenes.ts`; `SCENE_INFO: Record<string, SceneInfo>` beside `SCENES`, spreading `SCENARIO_INFO` from `src/scenarios.ts` as `SCENES` spreads `SCENARIO_SCENES`. `SCENES` keeps its type (`() => Scene`), so the tests that use it do not change and the menu never builds a scene to read its label (`blast` and `physics` are large).
- **Menu.** `src/scene-menu.ts`: the pure `sceneMenuGroups` and `sceneSearch` (AC2, AC3) and `renderSceneMenu(button, panel, info, current)`; `main.ts` wires it and sets `location.search`. A "Scenes" button at the start of the toolbar's status part (M8.1's picker replaces the element buttons, not that part), its panel above the toolbar, scrolling vertically when taller than the window, tokens of the existing toolbar styles in `index.html`. Description text is set with `textContent`.
- **Grid info** shows the label instead of the key.
- **Variants.** A scenario builder with a variant parameter is registered once per variant by a small loop in `src/scenarios.ts`, the main version under the bare name (as M8.9 registered it).
- **Descriptions** are written from each test's comment and annotations; a target written in a description changes with the test's target, in the same commit (rule added to `AGENTS.md`, "Real-world scenarios").
- **Moving the three setups** changes no cell: copy each setup into a builder, compare fields with the test's own setup once, then point the test to the builder and delete the old setup. `tests/scenes.test.ts` already skips scenario scenes in the element-temperature check.
- **Failure modes.** An unknown key in the menu cannot happen (built from `SCENE_INFO`, AC1 ties it to `SCENES`); a scene too large for the device is today's behavior, unchanged.

## Checklist

### I31.1 Menu

- [ ] `SceneInfo`, `SCENE_GROUPS`, `SCENE_INFO` for every scene registered at that time (labels and descriptions written from the builders' comments; scenario entries are I31.2's), `SCENARIO_INFO` (empty or partial until I31.2), AC1 in `tests/scenes.test.ts`.
- [ ] `src/scene-menu.ts`, `tests/scene-menu.test.ts` (AC2, AC3), the button and panel in `index.html` and `main.ts`, the grid info label.
- [ ] Browser check of AC4 to AC6 (Sonnet sub-agent with Playwright, on the user's running dev server if there is one, else its own on another port; no localStorage touched).
- [ ] `AGENTS.md` layout (`src/scene-menu.ts`, `SCENE_INFO`) and rule: a new scene gets its `SCENE_INFO` entry; README: the scene lists point to the Scenes menu; `docs/decisions.md` entry "Scenes are code; saves are a format of their own": scenes are builders with named regions the tests measure, variants as parameters, always on the current element table and cell format; save files would freeze them, go stale with each field or default change and make test setups unreviewable; rejected: scenes as save files.
- [ ] Verify: lint, typecheck, `npm test`, build.

Visible after: the Scenes button and its list; picking a scene opens it.
Needs you: open the menu, pick two scenes and Empty world, say if anything reads wrong (at the end).

### I31.2 Scenario entries

- [ ] Info for every scenario scene, with AC9's content; variants registered (AC7).
- [ ] `sealedBars`, `coolingBlock`, `heatedPot` as scenes (AC8) in `src/scenarios.ts`, their tests in `tests/physics.test.ts`, `tests/air-heat.test.ts` and `tests/convection.test.ts` built from them.
- [ ] Rule in `AGENTS.md` "Real-world scenarios": a scenario's description states its target and changes with it.
- [ ] Verify: lint, typecheck, `npm test`, build; the menu shows the scenarios group (browser check).
- [ ] Finish: I31 deleted from the backlog, this plan deleted in the commit.

Visible after: the menu's real-world scenarios group, each saying what to expect and how long to wait, with the fast and full versions as separate entries.
Needs you: open `iceCup` and one waiting scenario (`redHotBar`) from the menu and say whether the description tells you what to look for (at the end).
