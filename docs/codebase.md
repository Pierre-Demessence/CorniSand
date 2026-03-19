## Codebase Map

```
src/
├── main.ts              # App entry: async WebGPU init, animation loop, UI wiring
├── gpu.ts               # WebGPU device/context initialization, device-lost handler
├── simulation.ts        # GPU simulation engine (compute pipeline, ping-pong textures)
├── display.ts           # Display renderer (render pipeline, fullscreen triangle)
├── input.ts             # Pointer/keyboard/wheel input handling
├── particles.ts         # Particle type constants
└── shaders/
    ├── simulation.wgsl.ts   # Margolus neighborhood compute shader (WGSL)
    └── display.wgsl.ts      # Color mapping + brush cursor (vertex + fragment, WGSL)
```

## Conventions

- Shaders are WGSL, exported as JS template literal strings
- Simulation runs as a WebGPU compute shader (not fragment shader)
- Display uses a fullscreen triangle (3 vertices, no vertex buffer)
- Particle types encoded in R channel of RGBA8 textures (0-255 types)
- G channel stores per-particle color variant for visual variety
- B channel stores lifetime for fire particles (200 at spawn, decays to 0 → smoke)
- Simulation uses ping-pong `GPUTexture` storage textures (`texA` / `texB`)
- Margolus offset alternates 0/1 each simulation step for full cell coverage
- Single `GPUCommandEncoder` per frame, submitted once
- Particle counting uses atomic counters in a compute shader with async `mapAsync` readback
- Water physics use 3-phase logic: vertical gravity+density, diagonal slide, horizontal liquid flow
- Smoke physics use reverse gravity (rises), horizontal dispersion when blocked above
- `canDisplace()` implements density ordering: smoke < empty < oil < water < sand < wall
- `canRiseThrough()` lets smoke rise through empty, water, oil, and fire
- Fire is stationary (no movement phases) with a reaction phase for aging, oil ignition, and water extinguishing

## Adding new particle types

1. Add constant to `src/particles.ts`
2. Add `TYPE_X` constant and `isFoo()` helper to `src/shaders/simulation.wgsl.ts`
3. Add physics rules (update `isFalling`, `isLiquid`, `isGas`, `canDisplace`, `canRiseThrough` as needed)
4. Add reaction logic if applicable (e.g., fire Phase 5)
5. Handle B channel encoding in brush spawn if the particle uses lifetime
6. Add color mapping to `src/shaders/display.wgsl.ts`
7. Add UI button in `index.html` with matching `data-type`
8. Add keyboard shortcut in `src/input.ts` and `typeMap` in `src/main.ts`
