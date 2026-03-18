## Codebase Map

```
src/
├── main.js              # App entry: Three.js setup, animation loop, UI wiring
├── simulation.js        # GPU simulation engine (ping-pong render targets)
├── display.js           # Display renderer (maps state texture to colors)
├── input.js             # Pointer/keyboard/wheel input handling
├── particles.js         # Particle type constants
└── shaders/
    ├── fullscreen.vert.js    # Shared fullscreen quad vertex shader
    ├── simulation.frag.js    # Margolus neighborhood cellular automaton
    └── display.frag.js       # Color mapping + brush cursor overlay
```

## Conventions

- Shaders are exported as JS template literal strings (no GLSL plugin needed)
- Particle types encoded in R channel of RGBA8 textures (0-255 types)
- G channel stores per-particle color variant for visual variety
- Simulation uses ping-pong render targets (`rtA` / `rtB`)
- Margolus offset alternates 0/1 each simulation step for full cell coverage

## Adding new particle types

1. Add constant to `src/particles.js`
2. Add physics rules to `src/shaders/simulation.frag.js` (`isFalling`, swap logic)
3. Add color mapping to `src/shaders/display.frag.js`
4. Add UI button in `index.html` with matching `data-type`
