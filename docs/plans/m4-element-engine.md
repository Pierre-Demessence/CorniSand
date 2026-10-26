# M4 Element engine

Status: M4.1 to M4.5 done (the user's browser check of the liquids from M4.2 is open; AC19 is not met after M4.5, see M4.5 results). Next: M4.6.

## Goal

Every material is a row in one element table, and cells move by a velocity, so that the rest of The Powder Toy (TPT) can be added element by element. Liquids flow by local rules as in TPT instead of the FLIP simulation, which is removed, and the whole screen full of particles runs well inside the frame budget.

## Scope

In: the movement-model prototype (research doc Q3, options A and C), removal of the FLIP liquids, liquids as CA rules, per-cell fields in separate buffers, the element table driving the CA, the brush, the display and the toolbar, movement by velocity with the chosen model, the bench at full screen.

Not in M4, each arrives with the first rule that reads it: heat and pressure properties and transitions (M5, M6), `ctype` and `tmp` fields (first element that needs them), a blast or wind tool (M6 brings pressure and wind; M4 uses scenes), sleeping regions for the CA (only if M4.6 misses the budget), B10 (variant shading).

Deviation from the roadmap text: M4's table holds only the properties M4's rules read (movement, density, flammability, lifetime, color). The roadmap lists heat and pressure properties too; they arrive with M5 and M6, so no column exists that nothing reads (AGENTS.md "Never tune a constant without confirming the value reaches a rule"). M4.4 updates the roadmap wording.

## Terms

- **Dispatch**: one Margolus CA pass over the 2×2 blocks. **Superstep**: two dispatches (offset 0 then 1). The 1x speed is 4 supersteps per frame.
- **Velocity** is in cells per dispatch. y = 0 is the bottom row; gravity points to −y.
- **Flyer** (option C only): a cell that left the grid and moves as a free particle with a float position until it lands.

## Acceptance criteria

Prototype (M4.1)

- AC1 WHEN the prototype measurement runs (`npm run bench`), THE SYSTEM SHALL report, for the baseline rules, model A and model C: GPU time per 1x frame at 2560×1340 for scenes T1–T4, the pile angle of P1, the 99th-percentile debris distance of P2, the wind drift of P3, the jammed-flyer count (C), and whether two runs with the same seed are bit-identical.
- AC2 WHEN any prototype scene runs under any model, THE SYSTEM SHALL keep the number of grains exactly constant (grid plus flyers in flight).
- AC3 WHEN the measurements are in, THE SYSTEM SHALL pick the model by the decision rule of M4.1, recorded in `docs/decisions.md`, and the user approves it at the M4.1 gate.

Liquids and FLIP removal (M4.2)

- AC4 WHEN M4.2 is done, THE SYSTEM SHALL contain no FLIP code, CPU fluid reference, liquid acceptance suite or FLIP-only doc, backlog or decision entry (`git grep -i "flip\|fluid\|particleBuffer"` over `src`, `tests`, `docs`, `AGENTS.md` finds only the I11 idea and the new liquids decision).
- AC5 WHEN the `damBreak` scene runs, THE SYSTEM SHALL keep the water count unchanged and reach a surface where every column's water height is within 1 cell of every other (`flatness` ≤ 1) within 2,000 supersteps.
- AC6 WHEN the `oilOnWater` scene runs, THE SYSTEM SHALL have no oil cell below a water cell in any column after 1,000 supersteps, and keep both counts unchanged.
- AC7 WHEN sand is dropped into water or oil, THE SYSTEM SHALL sink it to the floor; WHEN smoke starts under water or oil, THE SYSTEM SHALL bring it above the surface; the fire tests (oil burns, water puts fire out, burning never raises the oil count) pass without particles.

Cell fields (M4.3)

- AC8 THE SYSTEM SHALL declare the per-cell fields once (`src/cell-fields.ts`), one storage buffer each, and generate every shader's accessors from that list; adding a field is one entry there plus the rules that use it.
- AC9 WHEN a cell moves, THE SYSTEM SHALL move all its fields with it: a sand grain loaded with a non-zero `life` still has that `life` where it lands.
- AC10 THE SYSTEM SHALL update the cells in place (one buffer per field, no ping-pong); two runs with the same seed are bit-identical, and every behavior test of M4.2 still passes.

Element table (M4.4)

- AC11 THE SYSTEM SHALL describe every current material (empty, sand, wall, water, smoke, oil, fire) as a row of `src/elements.ts`; no shader, HTML or TS file outside the table names an element ID except through the generated constants, and the toolbar is built from the table with the current order and labels.
- AC12 WHEN a test passes the simulation a table with one extra powder row (density between water and sand) and no other change, THE SYSTEM SHALL make it fall, pile, sink through water and stay on top of sand.
- AC13 WHEN a test passes a table with one extra element that has an optional rule, THE SYSTEM SHALL run that rule for cells of that element only.

Movement (M4.5)

- AC14 WHEN a powder or liquid cell falls from rest through empty space, THE SYSTEM SHALL accelerate it by its element's gravity: its height after n dispatches matches the discrete free-fall formula within 1 cell until it reaches its top speed.
- AC15 WHEN a cell moves faster than one cell per dispatch, THE SYSTEM SHALL never let it pass through a wall one cell thick.
- AC16 WHEN a pile has settled, THE SYSTEM SHALL hold every velocity in it at exactly 0.
- AC17 WHEN the `blast` scene runs, THE SYSTEM SHALL throw debris at least as far as the prototype's chosen model did on P2 (within 10%), conserve every element's count, and rerun bit-identically.
- AC18 (model C only) WHEN more cells launch than the flyer cap, THE SYSTEM SHALL keep the rest moving in the CA and lose nothing.

Budget and docs (M4.6)

- AC19 WHEN `npm run bench` runs on the RTX 4080, THE SYSTEM SHALL spend at most 4 ms of GPU time per 1x frame at 2560×1340 on each of `mix75`, `full100` and `blast` (M4's share of the 12 ms simulation budget, leaving 8 ms for heat, air, electricity, gravity and light).
- AC20 WHEN M4 is done, THE SYSTEM SHALL have `docs/simulation.md`, `AGENTS.md`, `docs/decisions.md`, `docs/backlog.md`, the TPT topic doc and the roadmap describing the element engine, with the M4 roadmap entry and this plan deleted.

## Design

### M4.1 Movement prototype

A standalone harness, not wired into the game, so FLIP's ~300 idle dispatches per frame do not pollute the timing and the game keeps working. Sand, wall and empty only. It reuses `cell.wgsl.ts` (cell word, `pcg`, `hash2`) and nothing else.

- `src/proto/movement.ts`: `MovementProto(device, width, height, { model: 'baseline' | 'a' | 'c', seed })` with `load(cells, velocities?)`, `simulate(encoder, supersteps)`, `blast(x, y, radius, speed)`, `setWind(ax, ay)`, read-back helpers and a `render` with its own small display shader (flyers drawn on top).
- `src/proto/shaders.ts`: the WGSL of the three models.
- State: the cell word as today, plus `motion: vec4f` per cell (vx, vy, remainder x, remainder y). Both live in single buffers updated in place: a Margolus thread reads and writes only its own block, so blocks never race (this also tries out M4.3's in-place layout).
- **baseline**: today's sand rules (fall, slide), velocity ignored. The cost and pile reference.
- **A, velocity-driven Margolus**: per dispatch, in each block: velocity += gravity (and wind on exposed grains, P3), remainder += velocity; a cell whose remainder reaches ±1 on an axis tries the neighbor in that direction if it is inside the block (the alternating offset gives each direction a chance every superstep), moves when the target is empty, and subtracts the step from the remainder. A blocked axis zeroes that velocity component and clamps the remainder; a grain blocked below falls back to the diagonal slide rule. Speed is clamped to 1 cell per dispatch.
- **C, hybrid**: A, plus: a cell whose speed exceeds `launchSpeed` (above A's clamp) launches. Once per superstep:
  1. *Launch*: a prefix sum over the cells with speed > `launchSpeed`, in cell order, gives each one a flyer slot after the live flyers; the cell becomes empty and the flyer carries the cell word, position (cell center + remainder) and velocity. Past the cap (`MAX_FLYERS`, 2^18) the cell stays in the CA with its speed clamped.
  2. *Flight*: each flyer adds gravity and drag for two dispatches, then walks the cells from its position to the new one (a DDA over the grid, read-only). It stops in the last empty cell before a non-empty one.
  3. *Landing*: a flyer that hit something, or whose speed dropped below `launchSpeed`, claims its stop cell with `atomicMin(claim[cell], slot)`. A second pass writes the winners into the grid with their remaining velocity, clamped to A's maximum, and clears the claims. Losers stay airborne and retry the next superstep; a retry counter per flyer feeds the jam metric.
  4. *Compaction*: a stable prefix-sum compaction drops the landed flyers, keeping the order.
  Every slot comes from a prefix sum in a fixed order and every conflict is resolved by the slot index, so nothing depends on thread scheduling and reruns are bit-identical. Flyers do not collide with each other in flight.
- Constants: gravity, drag, `launchSpeed` and the cap live in `src/proto/params.ts`, chosen before the first measurement and frozen. Suggested start: gravity 1/32 cell/dispatch² (a grain reaches A's top speed after falling 16 cells), flyer drag 1/64 per dispatch, `launchSpeed` 1.5.

Scenes (physics metrics on a 1024×512 tank with 2-cell walls; timing at 2560×1340):

- **P1 pour**: sand poured from a 4-cell-wide source at the top center for 2,000 supersteps, then 500 to settle. Pile angle: least-squares slope of the column heights on each flank between 10% and 90% of the peak, in degrees, both flanks averaged.
- **P2 blast**: a 100-deep sand layer; at the center of its surface, every grain within radius 32 gets an outward speed of 8 cells/dispatch at the center, falling linearly to 0 at the radius (A clamps it to 1). Metric: the 99th-percentile distance from the blast center of the grains that started inside the radius, after 120 supersteps. A grain is followed by a marker bit in its variant byte.
- **P3 wind**: a 10-deep sand layer; grains with an empty cell above get an acceleration of (+1/64, +1/256) per dispatch. Metric: shift of the grains' horizontal center of mass after 400 supersteps.
- **Timing** (median of 60 frames at 1x after a warm-up, on the RTX 4080): T1 full screen of sand at rest; T2 the top half sand over an empty bottom half, from load; T3 (C) blasts that keep about 100k flyers in the air, and one at the cap; T4 A at 2x and 4x speed on T1 and T2, the "more steps per frame" alternative for fast debris (also its P2 distance at 4x).
- **Determinism**: P2 twice from the same seed; the cell, motion and flyer buffers compared word for word.

Decision rule, fixed before measuring. C if all of:

- c1: AC2 and determinism hold for A and C.
- c2: C's P2 debris distance is at least 3× A's at 1x.
- c3: C costs at most 0.5 ms more than A on T1 and T2.
- c4: C with 100k flyers (T3) costs at most 2 ms more than A on T1.
- c5: the P1 pile angles of A and C are within 5° of each other.
- c6: at most 1% of the flyers launched in P2 retry their landing for 8 supersteps or more.

Otherwise A. If only c3, c4 or c6 fail, by less than half their margin, the gate shows both and recommends one; the user decides.

The user sees it on a dev-only page: `proto.html` at the repo root (Vite serves it with `npm run dev`; `vite build` builds `index.html` only, so it never ships). It runs A and C side by side on the same scene and seed, with a scene picker (pour, blast, wind) and a reset; a click blasts both halves at the same spot.

Measurements: `tests/proto-movement.bench.gpu.ts`, added to `vitest.bench.config.ts`'s `include`, prints the tables. Correctness on small grids (AC2, determinism, a fast grain against a 1-cell wall): `tests/proto-movement.test.ts`, GPU-skipping like the other suites. The results go in this plan, section "M4.1 results".

When the model is approved: a `docs/decisions.md` entry "Cells move by velocity", named after the chosen model (the decision, the numbers that settled it, the other model as the rejected alternative). Option B is rejected there without a prototype: its cost grows with every moving particle, dense piles make most claims conflict, and density swaps and reactions would need a second mechanism.

### M4.2 FLIP removal and liquids as CA rules

Removed: `src/fluid.ts`, `src/fluid-params.ts`, `src/shaders/fluid-*.wgsl.ts`, the particle spawning in `brush.wgsl.ts`, `Simulation.create` and the capacity probe, the fluid options of `SimulationOptions`; `tests/cpu/`, `tests/fluid-*.test.ts`, `tests/liquid*.ts`, `tests/liquids-*.test.ts`, `tests/gpu-liquid-model.ts`, the fluid helpers of `tests/gpu.ts`, the FLIP-specific scenes (`deepPool`, `uTubeLarge`, `uTubeHuge`, `uTubeUnequal`, `uTubeOil`, `sealedChamber`, `droplet`, `film`) and the `Scene` fields and metrics no remaining test reads. `basin`, `damBreak`, `sandIntoPool`, `oilOnWater` and `uTube` stay as `?scene=` scenes (`uTube` now shows the documented limit: the arms do not level).

Liquid rules in the CA shader (renamed `solid-ca.wgsl.ts` → `ca.wgsl.ts`), in the spirit of TPT's liquids:

- fall into the cell below when it is empty, gas, or a lighter liquid (water through oil);
- blocked below, slide to the opposite bottom corner like sand;
- otherwise move sideways into an empty cell of the same row, only if the cell did not already move in this dispatch (as smoke does). A liquid cell remembers its direction in the `life` field (0 none, 1 left, 2 right), keeps it while it moves, and turns around when it faces anything but empty space, or one time in 64 when it could move: random-direction spreading levels the dam break in more than 16,000 supersteps, remembered direction in about 1,200 (AC5 asks 2,000);
- a heavier liquid above a lighter one swaps down; side by side, different liquids never swap, so a layered body stays layered.

Sand sinks through liquids and smoke rises through them as today. Burning oil no longer removes particles. The invariants about liquid particles and "the CA never moves liquid" go.

Docs: `docs/decisions.md` replaces the four liquid entries (velocity field and global pressure solve, FLIP particles, multigrid solve, weak density correction) with one, "Liquids move by CA rules, as in TPT": local rules cannot level connected vessels, TPT has the same limit, FLIP cost 49 ms a frame at full screen, the rejected alternative of keeping FLIP as an option and why (research doc, "The realistic water"), and where the measurements are (`git log --all -- docs/plans/physics-foundation.md`, `git log --all -- src/fluid.ts`). `docs/backlog.md` deletes B12, D13–D15, D18–D22, I8 and I9, rewrites I10 to its scenes part, and updates the pointers of D11 and D17. `docs/simulation.md` loses the Liquids section and documents the liquid rules. `AGENTS.md` loses the fluid commands, layout entries and invariants. The research doc has no open question left once M4.1 and this item are done: it becomes the topic doc `docs/powder-toy.md` (what TPT simulates, how each part maps to the GPU, the frame budget, beyond TPT; the Q3 and realistic-water sections go, their decisions now in `docs/decisions.md`), and the roadmap and the AGENTS.md docs map point to it.

Bench (`tests/bench.gpu.ts`) is rewritten for the CA alone: ms per frame at 2560×1340 at 1x to 8x for `tank` (the current bench scene) and `mix75` (75% of the cells a random mix of sand, water, oil and smoke, the rest empty, so everything keeps moving), plus the creation timing (D17). Its numbers are M4's baseline.

### M4.3 Cell fields in separate buffers, updated in place

- `src/cell-fields.ts`: `CELL_FIELDS`, an ordered list of `{ name, wgslType }` (each field one 32-bit word per cell: `u32`, `i32`, or `f32`, or a packed pair read with `unpack2x16float`). M4.3 has `kind` (bits 0–7 element, 8–15 variant, 16–31 reserved) and `life` (`u32`). M4.5 adds the motion field(s); M5 adds temperature the same way.
- `src/cell-buffer.ts` becomes `CellFields`: one `STORAGE | COPY_SRC | COPY_DST` buffer per field, `load(fields)`, `clear()`, `read(name)` for tests.
- Generated WGSL (`src/shaders/cell.wgsl.ts`): `struct Cell { kind: u32, life: u32 }`, the bindings of every field in one bind group (`@group(1)`, binding = field index, `read_write` or `read` per pass), `loadCell(i) -> Cell`, `storeCell(i, Cell)`, and the existing accessors on `kind`.
- In place: the CA reads its block, runs the rules and writes back only the fields of the cells that changed. Blocks are disjoint, so this is race-free; the invariant becomes "a CA rule reads and writes only the cells of its own block". The brush, the counter and the display bind the same buffers; nothing swaps.
- `CELL_BYTES` (used to size buffers against the device limits in `grid.ts`) becomes the sum over the fields.
- Scenes produce `Record<fieldName, Uint32Array>` (missing fields are zero); `packCell` keeps packing the `kind` word.
- `docs/decisions.md`: "Cell state in storage buffers, one packed u32 per cell" becomes "Per-cell fields in separate buffers, updated in place" (a pass binds and reads only the fields it uses; in place halves the memory and skips writes for blocks that did not change; rejected: ping-pong pairs, one struct per cell).

### M4.4 Element table

- `src/elements.ts` replaces `src/particles.ts`:

  ```ts
  interface ElementDef {
    key: string;            // 'SAND'; generates ELEMENT.SAND and the WGSL constant EL_SAND
    id: number;             // stable, never reused
    label: string;          // toolbar text
    color: [number, number, number];
    state: 'empty' | 'solid' | 'powder' | 'liquid' | 'gas';
    density: number;        // kg/m³ from physical data or our own tuning; a movable cell displaces a lighter one
    flammable?: boolean;    // becomes fire when a fire cell is in its block
    life?: { start: number; decay: number; becomes: string };  // fire: 200, 4, 'SMOKE'
    rule?: string;          // optional WGSL rule, src/shaders/rules/<rule>.wgsl.ts
    graphics?: string;      // optional color function in the display shader
    toolbar?: number;       // position in the toolbar; absent = not paintable
  }
  ```

  M4.5 adds the movement properties (gravity, drag). Densities: smoke below air (it rises), oil 900, water 1000, sand about 1600.
- GPU: the table is packed into a uniform buffer `array<ElementProps, MAX_ELEMENTS>` (MAX_ELEMENTS 256, one 32-byte struct each, 8 KiB), with the WGSL struct and the TS packer generated from one field list. A uniform buffer rather than generated `const` arrays: indexed by a runtime type, it is one cached read, where a `const` array may be copied into every thread's private memory.
- The CA becomes generic: movement by `state` and `density` (powders fall and slide, liquids also spread sideways, gases rise and spread, a movable cell displaces any lighter movable cell), then lifetimes (`decay`, `becomes`), then flammability, then the optional rules through a generated `switch` on the element. Fire's rule is "next to water becomes smoke"; burning, ignition and burnout are table rows. The phase order keeps the M4.2 tests passing.
- `Simulation` and the shader generators take the table as an option (default `ELEMENTS`), which is how AC12 and AC13 add rows in a test without touching the game.
- The brush takes the life start from the table; the display takes the color from it and calls `graphics` where set (fire's life-based color). `main.ts` builds the toolbar buttons from the table, so `index.html` no longer repeats the IDs and the help hint's key range follows the button count. Out-of-bounds reads stay `ELEMENT.WALL`; the counter still counts every cell that is not empty or wall.
- `AGENTS.md` "Adding a particle type" becomes "Adding an element": a row, optionally a rule and a graphics function, a scene test; the `data-type` invariant goes. The roadmap's M4 wording drops the heat and pressure columns (see Scope).

### M4.5 Movement by velocity

Ports the approved model from `src/proto/` into the engine, then deletes `src/proto/`, `proto.html` and the prototype tests.

- Motion state as `CELL_FIELDS` entries, at most 8 bytes per cell: velocity as two `f16` in one word (`pack2x16float`), and the sub-cell remainder in a second word unless M4.5's measurements show a cheaper encoding with the same test results.
- Element properties `gravity` (cells/dispatch², 0 for walls, negative for gases if smoke's tests still pass that way) and `drag`.
- The generic movement phase of M4.4 is driven by velocity as in the prototype; liquids keep their sideways spread and gases their random spread on top of it.
- If C: the flyer passes (launch, flight, landing, compaction) run once per superstep between the CA dispatches, in the frame's one compute pass. The flyer struct is generated from `CELL_FIELDS`, so a flyer carries every field (temperature included, in M5) without extra code. The display draws flyers from a per-frame overlay buffer (a scatter of the flyers' cells). The brush's erase and replace remove flyers inside the stroke; Clear empties the flyer list; the particle counter adds the live flyers. Anything else that acts on cells misses flyers (backlog I13); in M4 that is only the `blast` scene's initial velocities, set before any cell launches.
- Scenes `pile` and `blast` (a sand layer with P2's initial velocities, loaded through the velocity field), shown with `?scene=`. No blast or wind tool before M6.
- The D5 test "a sand grain falls two cells per superstep" becomes AC14: grains now accelerate. Visible change: falling things speed up instead of falling at one constant speed.

### M4.6 Budget and docs

- Bench scenes `mix75`, `full100` (every cell a random mix of sand, water, oil and smoke inside the wall frame: constant density swaps) and `blast` (with flyers, under C), at 1x to 8x, with per-pass timestamps.
- If a scene misses AC19: measure where the time goes, and apply the levers that do not change the look (fewer bound fields per pass, skipping blocks that are uniformly empty or solid); if that is not enough, stop at a gate with the numbers and the remaining options (sleeping tiles for the CA, a lower default field size).
- Docs: `docs/simulation.md` (element table, fields, movement, flyers), `AGENTS.md` (layout, invariants, adding an element), `docs/powder-toy.md` frame budget rewritten with the measured M4 numbers, the M4 roadmap entry deleted, backlog entries for anything deferred, this plan deleted in the last commit.

### Edge cases and failure modes

- Determinism: every random choice comes from `pcg`/`hash2` on block or cell coordinates and the dispatch seed; every list slot from a prefix sum in a fixed order; every conflict from the slot index. A GPU test reruns each model and scene from one seed and compares buffers.
- In-place updates break silently if a rule reads outside its block: the M4.3 invariant states it, and a race shows up as a mismatch between reruns, but a deterministic out-of-block read does not (M4.3 results, deviation 7).
- A flyer landing where the brush just painted: the brush runs at frame start, flyers land after it; a claimed cell must be empty at landing, else the flyer retries.
- Flyer cap reached: the extra cells stay in the CA, clamped (AC18).
- `f16` velocity: the smallest gravity step must stay representable at top speed (1/32 next to 8 is fine in `f16`: about 3 decimal digits).
- Grid sizing: `computeGrid` divides the buffer limit by the bytes of the largest field buffer, not the sum, since each field is its own buffer.

## Checklist

### M4.1 Movement prototype (options A and C) (tasks)

- [x] M4.1a `src/proto/params.ts`, `src/proto/shaders.ts`, `src/proto/movement.ts`: baseline, A and C as specified in Design; small-grid tests in `tests/proto-movement.test.ts` (grain conservation for every model and scene, bit-identical reruns, a grain at 8 cells/dispatch against a 1-cell wall under C, a launch past the cap). Verify: `npm test`, `npm run lint`, `npm run typecheck`.
- [x] M4.1b `proto.html` and `src/proto/main.ts`: A and C side by side, scene picker, reset, click to blast both. Verify in a browser on the user's running dev server (or one started for the check) that both halves run, a click blasts both, and the console shows no WebGPU error.
- [x] M4.1c `tests/proto-movement.bench.gpu.ts` in `vitest.bench.config.ts`: the metrics of P1–P3 and the timings T1–T4, as tables. Run `npm run bench` on the RTX 4080 (the test prints the adapter), record the tables and the decision rule's verdict in "M4.1 results" below.
- [x] M4.1d Gate: report the results to the user in plain words, with the `proto.html` steps to see the difference; on approval, add the movement decision to `docs/decisions.md`.

Visible after: nothing in the game. A dev-only page, `proto.html` under `npm run dev`, shows the two movement models side by side.
Needs you: the gate. Open `proto.html`, blast the sand in both halves, compare how far and how naturally debris flies, and approve the model.

### M4.2 FLIP removal and CA liquids (tasks)

- [x] M4.2a Liquid rules in `ca.wgsl.ts`, with GPU tests AC5–AC7 in `tests/simulation.test.ts`. They land with M4.2b in one commit: the CA must move liquids from the moment FLIP stops writing them.
- [x] M4.2b Delete the FLIP code, tests, scenes and helpers listed in Design; `main.ts` uses `new Simulation`; `index.html` unchanged. Verify: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; AC4's `git grep`.
- [x] M4.2c Rewrite `tests/bench.gpu.ts` for the CA (`tank`, `mix75`, creation timing); run it, record the numbers below as M4's baseline.
- [x] M4.2d Docs: the decisions, backlog, `simulation.md`, `AGENTS.md` changes listed in Design; research doc → `docs/powder-toy.md`; roadmap and docs map links.

Visible after: water and oil flow by themselves in the TPT way: they fall, spread sideways, settle flat in a basin, oil stays on top of water. Connected vessels no longer level (the U-tube's arms stay uneven, as in TPT). Pouring a lot of liquid no longer slows the game down.
Needs you: a quick browser check (steps in the item's report): pour water and oil into a wall basin, drop sand into them, set the oil on fire.

### M4.3 Cell fields (tasks)

- [x] M4.3a `src/cell-fields.ts`, `CellFields`, generated accessors; CA, brush, counter and display on the field buffers, in place; scenes and `tests/gpu.ts` read and write fields by name. AC9 test (a `life` marker on a falling grain) and a determinism test (same seed, two runs, every field compared). Verify: lint, typecheck, `npm test`, build, `npm run bench` (record `tank` and `mix75` next to the M4.2 baseline).
- [x] M4.3b Docs: decisions entry, `simulation.md` cell format, `AGENTS.md` invariants (cell layout, in-place CA, block-only reads).

Visible after: nothing: the cells' data is reorganized, the game behaves the same.
Needs you: nothing.

### M4.4 Element table (tasks)

- [x] M4.4a `src/elements.ts` with the seven current elements, generated constants, the uniform table and its packer; `particles.ts` removed and every user moved to `ELEMENT`. Verify: lint, typecheck, `npm test`.
- [x] M4.4b Generic CA phases driven by the table, fire's optional rule, generated rule `switch`; the `elements` option of `Simulation`. AC12 and AC13 tests; every M4.2 behavior test unchanged. Verify: `npm test`, bench (record).
- [x] M4.4c Brush, display (color, `graphics`) and toolbar from the table; unit test of the toolbar builder (labels, order, data attributes) on a table. Verify: lint, typecheck, `npm test`, build; a browser look that the toolbar and colors are unchanged.
- [x] M4.4d Docs: `AGENTS.md` "Adding an element", `simulation.md` (table, generic phases, density order), roadmap M4 wording.

Visible after: nothing: the toolbar, colors and behaviors are the same, now driven by the table.
Needs you: nothing.

### M4.5 Movement by velocity (tasks)

- [x] M4.5a Motion fields, `gravity` and `drag` in the table, velocity-driven movement phase; AC14–AC16 tests; the D5 falling test replaced. Verify: `npm test`, bench.
- [x] M4.5b (C only) Flyer passes, overlay drawing, brush and Clear handling, counter; AC17–AC18 tests. Verify: `npm test`, bench, determinism test with flyers.
- [x] M4.5c Scenes `pile` and `blast`; delete `src/proto/`, `proto.html` and the prototype tests and bench file. Verify: lint, typecheck, `npm test`, build.

Visible after: falling sand and water speed up as they fall; `?scene=blast` throws sand far across the field and it lands back into piles.
Needs you: a browser look at `?scene=blast` and at pouring sand from high up, compared with the approved prototype.

### M4.6 Budget and docs (tasks)

- [ ] M4.6a Bench `mix75`, `full100`, `blast` with per-pass timing; AC19 on the RTX 4080, levers or gate as in Design.
- [ ] M4.6b Docs per AC20; `docs/decisions.md` gets only what passes its test; deferred items to `docs/backlog.md`; this plan deleted in the final commit.

Visible after: nothing new; the frame rate with a full screen of mixed materials is measured and within budget.
Needs you: nothing, unless the budget is missed (then a decision at the gate).

## M4.1 results

Measured with `npx vitest run --config vitest.bench.config.ts proto` on the RTX 4080 (`vendor="nvidia" architecture="lovelace"`, D3D12 driver 32.0.16.2101, through Dawn). GPU timestamps are quantized to 65.5 µs, so times below 0.2 ms are only indicative.

Physics (1024×512 tank, 1x speed unless noted):

| Model | P1 pile angle | P1 grains | P2 debris p99 | P3 wind drift | P2 launched | P2 jammed (≥ 8 retries) | P2 max retries | Grains conserved | Bit-identical rerun |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 48.5° | 5016 | 31.9 cells | 0 | 0 | 0 | 0 | yes | yes |
| A | 43.7° | 1600 | 36.9 cells | 1.00 | 0 | 0 | 0 | yes | yes |
| C | 43.7° | 1600 | 237.1 cells | 1.00 | 2119 | 0 | 5 | yes | yes |
| A at 4x steps (T4) | 44.0° | 1780 | 247.1 cells | 1.04 | 0 | 0 | 0 | yes | yes |

P1 pours fewer grains under A and C than under the baseline: a grain now starts at rest and accelerates, so it blocks the source longer. A and C pour the same grains, so their angles compare.

GPU time per frame at 2560×1340 (median of 60 frames after 20 warm-up frames, frames submitted back to back):

| Scene | baseline | A 1x | A 2x | A 4x | C 1x |
| --- | --- | --- | --- | --- | --- |
| T1 full, at rest | 0.07 ms | 1.18 ms | 2.36 ms | 5.18 ms | 1.31 ms |
| T2 top half falling | 0.13 ms | 2.23 ms | 4.98 ms | 6.09 ms | 2.29 ms (229,583 flyers) |
| T3 blasts, same schedule | | 1.38 ms | | | 1.77 ms (61,133 flyers, median) |
| T3 one blast past the cap (374,805 launches refused) | | | | | 1.97 ms median, 3.41 ms slowest of 20 frames |

Decision rule:

- c1 pass: A and C conserve every grain in every scene (`tests/proto-movement.test.ts`, P1, P2) and rerun P2 bit-identically.
- c2 pass: C throws debris 237.1 cells against A's 36.9, 6.4×.
- c3 pass: C costs 0.13 ms more than A on T1 and 0.06 ms more on T2.
- c4 pass: T3 under C costs 1.77 ms, 0.59 ms over A on T1, with 61k flyers. The schedule could not hold 100k (deviation 9); T2 holds 229k flyers at 2.29 ms, 1.11 ms over A on T1, inside the 2 ms margin as well.
- c5 pass: both piles stand at 43.7°.
- c6 pass: no P2 flyer retried its landing 8 times; the worst retried 5 times.

Verdict: C.

Also measured: A at 4x speed throws debris as far as C (247 cells) but costs 5.18 ms at rest against C's 1.31 ms. The velocity CA costs about 15× the baseline's rules (1.18 ms against 0.07 ms on T1), which takes a large share of AC19's 4 ms. Inferred, not measured pass by pass: most of it is the 16-byte `motion` per cell, which takes the working set out of the GPU's L2 cache; M4.3 and M4.5 should store motion more compactly.

Deviations from Design, each found while making the measurements hold:

1. Friction: a grain resting on another loses 1/4 of its horizontal speed per dispatch (`PROTO.friction`). Without it, a grain that landed sideways slides forever and no pile forms.
2. P2's blast center is half its radius under the surface, not on it. With the center on the surface, half the disc is pushed down into the sand and nothing is thrown up.
3. P3's top two rows are half full (seeded). A full flat layer has no grain that can move sideways, so the wind had nothing to push.
4. A grain blocked by a slower grain moving the same way keeps that grain's speed instead of stopping (`bumped`), so a falling column falls together.
5. A grain at rest gets gravity only in a dispatch where it is the top cell of the block. Otherwise each level of a resting stack banks one more gravity step than the one below, and the top of a deep layer launches.
6. Landing: the lowest claim wins by (cells walked, slot) instead of slot alone, so a grain that stops at once keeps its own cell. Two landing rounds per superstep; between them, a loser claims a random free cell within 3 cells, or, buried, around the first free cell above it. Searching the nearest free cell first jammed 10% of the P2 flyers.
7. A flyer is 40 bytes (position, velocity, cell, stop cell, claim key, retries, status).
8. Behavior-neutral speedups: a block with no empty cell and no motion skips the rules, and the launch scan skips a superstep without launches.
9. Bench: frames are submitted back to back after 1 s of GPU load; waiting after each frame let the GPU clock down and inflated the times up to 3×. T3's closed-loop schedule (up to 32 blasts of radius 128 a frame) peaks below 100k flyers because the blasts dig the ground away; c4 is also checked on T2.

## Baseline (M4.2)

Measured with `npx vitest run --config vitest.bench.config.ts tests/bench.gpu.ts` on the RTX 4080 (`vendor="nvidia" architecture="lovelace"`, D3D12 driver 32.0.16.2101, through Dawn), 2560×1340, median of 60 frames after 20 warm-up frames, frames submitted back to back after a 2 s burn-in. Three runs agree within 0.1 ms up to 4x. GPU timestamps are not used here: the time is the wall time from submit to `onSubmittedWorkDone`.

| Scene | 1x (4 supersteps) | 2x | 4x | 8x (32 supersteps) |
| --- | --- | --- | --- | --- |
| `tank` (water quarter-full, sand block above it) | 0.32–0.33 ms | 0.67–0.69 ms | 1.07–1.27 ms | 10.9–13.6 ms |
| `mix75` (75% random sand, water, oil, smoke) | 0.31–0.34 ms | 0.57–0.75 ms | 1.25–1.51 ms | 8.5–11.6 ms |

The 8x row does not scale (0.27–0.43 ms per superstep against 0.07–0.09 up to 4x); backlog D23. Simulation creation (D17): 126–130 ms the first time, 1–2 ms after.

Deviations from Design:

1. The liquid spread rule remembers a direction per cell (see Design), because the plan's random direction does not meet AC5.
2. `uTube` lost its options (scale, arm widths, liquid) and the `expectedLevel` field, with `chamberLevel` kept for its test; `bubbleCount`, `foamCount` and `expectedLevel` were removed from `tests/metrics.ts` with the FLIP suites that read them. The sealed, droplet and film scenes went with the other FLIP scenes.
3. The test of oil beside fire and water runs in a sealed 2×2 chamber, since liquids now move.
4. Added tests: water under oil rises above it (AC6), sand sinks to the floor in water and in oil (AC7), smoke rises through oil as well as water (AC7).

## M4.3 results

`npm run bench` on the RTX 4080 after M4.3 (`tests/bench.gpu.ts`, same method as the M4.2 baseline), seven runs of the new code and three runs of the M4.2 commit back to back, ms per frame:

| Scene | 1x | 2x | 4x | 8x |
| --- | --- | --- | --- | --- |
| `tank` (new) | 0.30–0.34 | 0.70–0.78 | 1.22–1.34 | 12.0–12.7 |
| `mix75` (new) | 0.32–0.39 (one run 1.39) | 0.57–0.87 (one run 2.21) | 1.25–2.0 (one run 2.69) | 2.3–13.4 (a run each 5.1, 10.9, 24.7) |
| `mix75` (M4.2, same session) | 0.31–0.42 | 0.62–0.80 | 1.29–1.37 | 10.3–11.9 |

M4.3 does not change the speed within the noise: `tank` equals the M4.2 baseline, and `mix75` at 1x to 4x overlaps the M4.2 runs, with a few outlier runs on the new side (the 8x row is backlog D23). In-place updates and generated accessors cost nothing measurable. Creation: 77–108 ms the first time, 0–2 ms after.

Deviations from Design:

1. The fields live in `src/cell-fields.ts` (the list) and `src/cell-field-buffers.ts` (`CellFields`, formerly `cell-buffer.ts`).
2. `FIELD_BYTES` (4, one 32-bit word per field) replaces `CELL_BYTES`: the device limits apply to one buffer, so the grid is sized by the largest field buffer, not the sum (Design says "sum" in one place and "largest" under Edge cases; the latter is right).
3. All fields are bound in every pass (two groups: read-only for the counter and the display, read-write for the CA and the brush), not only the fields a pass reads. With two fields the saving is nil; per-pass binding comes with M4.5, when the motion fields make it matter.
4. The prototype keeps the old packed cell word in its own `PACKED_CELL_WGSL` (`src/proto/shaders.ts`) so it still runs; it goes with M4.5c.
5. `Cell` is a WGSL struct, so cells are compared with a generated `cellEq`, and the rules keep their form (`makeCell(type, variant, life)` returns a `Cell`).
6. Scenes expose `fields: CellData` (every field, zeros where unused); `packCell` and the test helper `cell()` pack the `kind` word only, and tests that need a `life` pass it as a second array to `loadScene`.
7. Equivalence with M4.2: a read-only reviewer ran the M4.2 ping-pong code and the new code over random mixes of every element (101×67 for 100 supersteps, 64×48 for 300, 33×129 for 57, 200×60 for 400) and the `kind` and `life` hashes matched in all four, so the in-place CA is bit-identical to the old rules. That is a one-off check, not a test: AC10 (two runs of one seed agree) cannot detect an out-of-block read that is deterministic, which the reviewer confirmed by inserting one. A reference check (CPU rules or a pinned hash) would need re-pinning at every rule change from M4.4 on, so it is not added.

## M4.4 results

Bit-identical to M4.3: a one-off run of the M4.3 commit's code and the new code over four random mixes of every element, fire included (101×67 for 100 supersteps, 64×48 for 300, 33×129 for 57, 200×60 for 400), gave the same hash of the `kind` and `life` buffers in all four. Not a test, for the reason in M4.3 deviation 7.

`npm run bench` on the RTX 4080, `tests/bench.gpu.ts`, three runs of the new code and two of the M4.3 commit back to back (the GPU ran slower in this session than in M4.3's, so compare within the rows below only), ms per frame:

| Scene | 1x | 2x | 4x | 8x |
| --- | --- | --- | --- | --- |
| `tank` (new) | 1.41–1.46 | 0.72–1.59 | 2.54–2.58 | 4.73–4.87 |
| `tank` (M4.3, same session) | 1.43–1.46 | 1.55–1.58 | 2.57 | 4.46–4.94 |
| `mix75` (new) | 1.44–1.50 | 2.22–2.31 | 3.21–3.26 | 5.34–5.56 |
| `mix75` (M4.3, same session) | 1.45–1.48 | 1.72–2.15 | 2.61–2.65 | 4.92–4.95 |

The table costs nothing measurable on `tank` and at 1x, and `mix75` at 4x is about 0.6 ms (20%) slower: every state and density check is a read of the table where it was a compare of a constant. M4.6 measures where the time goes.

Deviations from Design:

1. Fire's state is `plasma`, a sixth state beside empty, solid, powder, liquid and gas. Smoke rises through fire and nothing else moves it, which no other state says: a solid is not passed through, and a gas would rise by itself.
2. Densities (kg/m³): air 1.2, smoke 0.6, fire 0.3, oil 900, water 1000, sand 1600, wall 2500. Smoke is below air as planned; the fire value only has to be set.
3. The phase order is movement, lifetimes, rules, ignition, not lifetimes, ignition, rules: oil that ignites beside water must burn for a step (the M4.2 test), so a rule must not see a cell that ignites in the same dispatch. Which cells ignite is decided right after the lifetimes (a fire about to be put out still lights its neighbors) and applied after the rules.
4. A row is 8 words: the color as three floats, density, state, flammable, `life.start`, and `life.decay` with the ID of `becomes` in one word.
5. Rules take `(i, block)`: the index of the cell in its block and a pointer to the block's four cells. A rule is registered by name in `src/shaders/rules/index.ts`; `graphics` functions are in `src/shaders/graphics.wgsl.ts` (one file, not one per function). `Simulation` takes an `elements` option and a `rules` option (extra rule sources by name), and `Display` takes the `ElementTable` of the simulation.
6. The toolbar builder is `src/toolbar.ts`: `toolbarEntries` (the unit-tested part: order, labels, number keys) and `renderToolbar`. The first button starts selected, and the help hint's key range is set from the button count.
7. Added tests: `tests/display.test.ts` renders one cell of each element and compares its pixel with the table's color (and fire at three life values); `tests/elements.test.ts` covers the table's validation and packing.
8. Browser check (Playwright on a dev server, `?scene=sandIntoPool`): the six buttons in the old order and labels with Sand selected, the sand, water and smoke colors as before, no WebGPU error in the console. Fire's colors are covered by `tests/display.test.ts`, not by eye.
9. `src/proto/` keeps working: its shaders take the element constants from `elementConstantsWGSL`, and its tests the `ELEMENT` map.

## M4.5 results

Tests: lint, typecheck, build and `npm test` (87 tests, GPU suites included) pass. AC14 to AC18 are tests in `tests/simulation.test.ts`: a grain falls as the discrete formula says within 1 cell for 23 supersteps (sand and water), a fast grain lands with all its fields, sand falling at a one-cell wall and a grain thrown sideways at 8 cells per step never get through, a settled pile ends with velocity and remainder exactly 0, the blast's debris p99 is at least 90% of the prototype's 237.1, a rerun is bit-identical in every field and every flyer, and launches past a cap of 64 flyers stay in the grid with no grain lost.

The blast reproduces the prototype: p99 237.1 cells after 120 supersteps, 102,000 sand cells conserved, about 2,108 launched, 0 jammed, at most 5 retries.

Browser check (Playwright on a dev server, `?scene=blast`, `?scene=pile`): the blast throws sand across the field and it lands into piles, the pile settles, no WebGPU error in the console.

`npm run bench` (RTX 4080, 2560×1340, same method as M4.4), ms per frame at 1x: `tank` 6.4 (M4.4: 1.4), `mix75` 8.1 (M4.4: 1.5). **AC19 (4 ms at 1x) is not met.** The velocity CA costs about 1.1 ms per superstep against 0.14 to 0.36 before, and the flyer passes add about 0.3 ms per superstep with no flyer in the air. The M4.1 prototype measured 1.18 ms for the CA on T1 (a full grid at rest) and 1.31 ms with flyers, so the cost was expected to be this high at 1x; the 1x frame is four supersteps. Backlog D26 holds the levers for M4.6a: fewer bound fields per pass, skipping blocks that are uniformly empty or solid, avoiding runtime-indexed private arrays, fewer small dispatches per superstep.

Deviations from Design:

1. AC14 is checked with the sub-cell remainder included (`start − cell row − remainder`, tolerance 0.05 cells): the cell row alone lags the formula by up to 1.06 cells because the grain only changes cell when its remainder reaches 1.
2. A table row is 12 words (48 bytes), not 8: gravity and drag are two more words and a uniform array's stride is a multiple of 16.
3. Gases are not velocity-driven; they keep their constant-speed rules. Only powders and liquids gain gravity.
4. The display reads the flyers through an overlay buffer at `@group(3)`, filled by `Simulation.recordOverlay` after `simulate`; the CA's launch counts use `@group(3)` too.
5. Rules that rebuild a cell use `retype`, `withLife` and `withMotion` (backlog D25, deleted): every other field is kept.
6. Binary16 friction never reaches 0, so a sideways speed below `restSpeed` (1/256) snaps to 0; without it a pile never reaches exactly zero (AC16).
7. Only the brush's erase and replace reach a flyer (`Flyers.recordBrush`, run with the brush before the CA steps); everything else that acts on the grid misses flyers in flight (backlog I13, I14).
8. The flyer state buffer holds the survivor counts as well, to stay within 8 storage buffers per stage.
9. The prototype (`src/proto/`, `proto.html`, `tests/proto-*`) is deleted; `vitest.bench.config.ts` includes only `tests/bench.gpu.ts`.
