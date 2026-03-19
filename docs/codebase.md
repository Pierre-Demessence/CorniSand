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
- Simulation uses ping-pong render targets (`rtA` / `rtB`)
- Margolus offset alternates 0/1 each simulation step for full cell coverage
- Water physics use 3-phase logic: vertical gravity+density, diagonal slide, horizontal liquid flow
- Smoke physics use reverse gravity (rises), horizontal dispersion when blocked above
- `canDisplace()` implements density ordering: smoke < empty < water < sand < wall
- `canRiseThrough()` lets smoke rise through empty, water, and sand

## Adding new particle types

1. Add constant to `src/particles.ts`
2. Add physics rules to `src/shaders/simulation.frag.ts` (`isFalling`, swap logic)
3. Add color mapping to `src/shaders/display.frag.ts`
4. Add UI button in `index.html` with matching `data-type`
