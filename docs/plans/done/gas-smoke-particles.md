# Gas/Smoke Particles

## Requirements (EARS)

- WHEN the user selects Smoke and draws, THE SYSTEM SHALL spawn smoke particles at the brush location.
- WHILE smoke particles exist, THE SYSTEM SHALL move them upward (reverse gravity).
- WHILE smoke particles exist, THE SYSTEM SHALL disperse them horizontally when blocked above.
- WHEN smoke encounters sand or water, THE SYSTEM SHALL treat smoke as lighter (smoke rises above both).
- THE SYSTEM SHALL display smoke particles in a gray/light color palette.
- THE SYSTEM SHALL provide a Smoke toolbar button and keyboard shortcut (4).

## Design

### Particle type

- `SMOKE = 4` in particles.ts, `TYPE_SMOKE = 4.0` in shader.

### Density ordering (lightest → heaviest)

smoke → empty → water → sand → wall

Smoke displaces empty and water below it by rising. Smoke is displaced by sand and water pushing down.

### Physics (Margolus 2×2 CA)

**Phase 0 (new): Upward rise (smoke-specific)**

- If bottom cell is smoke and top cell is empty/water/sand → swap (smoke rises).
- Process both columns: BL↔TL, BR↔TR.

**Phase 1: Vertical fall (existing, unchanged)**

- Sand/water fall down. Sand sinks through water. These also push smoke down if smoke is below (but Phase 0 already moved smoke up).
- Update `isFalling` to NOT include smoke (smoke doesn't fall).
- Update `canDisplace` so sand/water can displace smoke downward.

**Phase 2: Diagonal slide (existing, unchanged)**

- Sand only.

**Phase 3: Horizontal liquid flow (existing, unchanged)**

- Water only.

**Phase 4 (new): Horizontal smoke dispersion**

- If smoke is blocked above (wall/other smoke), spread sideways.
- Bottom row: if smoke and adjacent is empty, swap.
- Top row: if smoke and blocked above, swap sideways.
- Randomized L/R direction like water flow.

### Display colors

- Smoke: light gray palette, `vec3(0.55, 0.55, 0.58)` to `vec3(0.35, 0.35, 0.38)`.

### UI

- Add "Smoke" button (data-type="4") in toolbar.
- Keyboard shortcut: `4`.
- Update help hint: `1-4: select tool`.

## Checklist

- [ ] Add SMOKE=4 to particles.ts
- [ ] Add TYPE_SMOKE, isSmoke(), isGas() helpers to simulation shader
- [ ] Add Phase 0 (upward rise) before existing Phase 1
- [ ] Update canDisplace for smoke interactions
- [ ] Add Phase 4 (horizontal smoke dispersion) after Phase 3
- [ ] Add getSmokeColor() to display shader
- [ ] Add display branch for smoke type
- [ ] Add Smoke button to index.html
- [ ] Add keyboard shortcut 4 in main.ts and input.ts
- [ ] Update help hint text
- [ ] Test: smoke rises, disperses, interacts with sand/water
- [ ] Update docs
