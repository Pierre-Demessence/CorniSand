## Codebase Map

```
src/
├── main.ts              # App entry: Three.js setup, animation loop, UI wiring
├── simulation.ts        # GPU simulation engine (ping-pong render targets)
├── display.ts           # Display renderer (maps state texture to colors)
├── input.ts             # Pointer/keyboard/wheel input handling
├── particles.ts         # Particle type constants
└── shaders/
    ├── fullscreen.vert.ts    # Shared fullscreen quad vertex shader
    ├── simulation.frag.ts    # Margolus neighborhood cellular automaton
    └── display.frag.ts       # Color mapping + brush cursor overlay
```

## Conventions

- Shaders are exported as JS template literal strings (no GLSL plugin needed)
- Particle types encoded in R channel of RGBA8 textures (0-255 types)
- G channel stores per-particle color variant for visual variety
- B channel stores lifetime for fire particles (200 at spawn, decays to 0 → smoke)
- Simulation uses ping-pong render targets (`rtA` / `rtB`)
- Margolus offset alternates 0/1 each simulation step for full cell coverage
- Water physics use 3-phase logic: vertical gravity+density, diagonal slide, horizontal liquid flow
- Smoke physics use reverse gravity (rises), horizontal dispersion when blocked above
- `canDisplace()` implements density ordering: smoke < empty < oil < water < sand < wall
- `canRiseThrough()` lets smoke rise through empty, water, oil, and fire
- Fire is stationary (no movement phases) with a reaction phase for aging, oil ignition, and water extinguishing

## Adding new particle types

1. Add constant to `src/particles.ts`
2. Add `TYPE_X` define and `isFoo()` helper to `src/shaders/simulation.frag.ts`
3. Add physics rules (update `isFalling`, `isLiquid`, `isGas`, `canDisplace`, `canRiseThrough` as needed)
4. Add reaction logic if applicable (e.g., fire Phase 5)
5. Handle B channel encoding in brush spawn if the particle uses lifetime
6. Add color mapping function to `src/shaders/display.frag.ts`
7. Add UI button in `index.html` with matching `data-type`
8. Add keyboard shortcut in `src/input.ts` and `typeMap` in `src/main.ts`
