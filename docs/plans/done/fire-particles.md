# Fire Particles

## Requirements (EARS)

- WHEN the user selects Fire and draws, THE SYSTEM SHALL spawn fire particles with a lifetime.
- WHILE fire exists next to oil, THE SYSTEM SHALL spread fire to the oil (oil becomes fire).
- WHILE fire exists next to water, THE SYSTEM SHALL extinguish the fire (fire becomes smoke).
- WHILE fire has no fuel, THE SYSTEM SHALL age and eventually extinguish the fire (becomes smoke).
- THE SYSTEM SHALL display fire with orange-red color that dims as lifetime decreases.

## Design

### Particle type
- `FIRE = 6` in particles.ts, `TYPE_FIRE = 6.0` in shader.

### B channel lifetime
- Spawned with B = 200 (lifetime)
- Each step: B decreases by ~4
- At B = 0: fire → smoke
- When fire spreads to oil: new fire gets fresh B = 200

### Movement
- Fire does NOT move (not falling, not liquid, not gas)
- Fire is NOT displaceable (acts like wall for physics)
- Smoke CAN rise through fire

### Reaction phase (after all movement)
Within each 2×2 block:
1. Age all fire cells (decrease B channel)
2. Oil adjacent to fire → oil becomes fire (fresh lifetime)
3. Fire adjacent to water → fire becomes smoke
4. Fire with B=0 → smoke

### Density model update
- `canDisplace()`: fire is NOT a valid target (blocks movement like wall)
- `canRiseThrough()`: add fire (smoke can rise through fire)

### Display
- Orange-red color, brightness proportional to lifetime (B channel)
- Fresh fire: bright yellow-orange `vec3(1.0, 0.7, 0.1)`
- Dying fire: dark red `vec3(0.8, 0.2, 0.05)`

### UI
- "Fire" button (data-type="6")
- Keyboard shortcut: '6'
- Help hint: "1-6: select tool"
