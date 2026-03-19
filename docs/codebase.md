## Codebase Map

```
src/
├── main.ts              # App entry: async WebGPU init, animation loop, UI wiring
├── gpu.ts               # WebGPU device/context initialization, device-lost handler
├── simulation.ts        # GPU simulation engine (CA + pressure diffusion pipelines)
├── display.ts           # Display renderer (render pipeline, fullscreen triangle)
├── input.ts             # Pointer/keyboard/wheel input handling
├── cell-buffer.ts       # Storage buffer ping-pong manager (32 bytes/cell)
├── particles.ts         # Particle type constants and per-type physics properties
└── shaders/
    ├── solid-ca.wgsl.ts     # Full Margolus CA compute shader (all particle types)
    ├── pressure.wgsl.ts     # Pressure/velocity diffusion for liquid cells
    └── display.wgsl.ts      # Color mapping + brush cursor (vertex + fragment)
```

## Conventions

- Shaders are WGSL, exported as JS template literal strings
- Simulation runs as a WebGPU compute shader (not fragment shader)
- Display uses a fullscreen triangle (3 vertices, no vertex buffer)
- Cell data stored in storage buffers as 32-byte `Cell` structs:
  `{ pType: u32, variant: f32, lifetime: f32, pressure: f32, velocityX: f32, velocityY: f32, _pad0: f32, _pad1: f32 }`
- Simulation uses ping-pong `GPUBuffer` storage buffers via `CellBuffer` class
- Per-step `GPUCommandEncoder` submit (one encoder per CA step, not per frame) to avoid uniform buffer race conditions
- After CA steps, lightweight pressure diffusion passes spread pressure/velocity across liquid cells
- Pre-created bind groups for both CA and pressure pipelines (A→B and B→A)
- Particle counting uses atomic counters in a compute shader with async `mapAsync` readback
- Water physics use 3-phase logic: vertical gravity+density, diagonal slide, horizontal liquid flow (pressure-biased for wave effects)
- Liquid flow direction is biased by pressure gradient — higher pressure pushes liquid toward lower pressure
- Pressure diffusion shader runs after each CA step pair (Jacobi-style averaging across liquid neighbors)
- Smoke physics use reverse gravity (rises), horizontal dispersion when blocked above
- `canDisplace()` implements density ordering: smoke < empty < oil < water < sand < wall
- `canRiseThrough()` lets smoke rise through empty, water, oil, and fire
- Fire is stationary (no movement phases) with a reaction phase for aging, oil ignition, and water extinguishing
- Particle type constants are duplicated in `src/particles.ts` (TS) and `src/shaders/solid-ca.wgsl.ts` (WGSL) — keep in sync

## Adding new particle types

1. Add constant to `src/particles.ts` (both `PARTICLE_TYPES` and `PARTICLE_PHYSICS`)
2. Add `TYPE_X` constant and `isFoo()` helper to `src/shaders/solid-ca.wgsl.ts`
3. Add physics rules (update `isFalling`, `isLiquid`, `isGas`, `canDisplace`, `canRiseThrough` as needed)
4. Add reaction logic if applicable (e.g., fire Phase 5)
5. Handle `makeCellWithLife()` in brush spawn if the particle uses lifetime
6. Add color mapping to `src/shaders/display.wgsl.ts`
7. Add UI button in `index.html` with matching `data-type`
8. Add keyboard shortcut in `src/input.ts` and `typeMap` in `src/main.ts`
