# CorniSand

GPU-accelerated falling sand simulation built with native WebGPU compute shaders.

**[Live Demo](https://pierre-demessence.github.io/CorniSand/)**

## Quick Start

```bash
npm install
npm run dev
```

Requires a WebGPU-capable browser (Chrome 113+, Edge 113+, Safari 18.2+).

## Controls

- **Left click**: Draw selected particle
- **Right click**: Erase particles
- **Scroll wheel**: Change brush size
- **1-6**: Select particle type
- **[/]**: Adjust simulation speed
- **Shift+click**: Draw over existing particles (except walls)

## Architecture

The simulation runs entirely on the GPU using a **Margolus neighborhood cellular automaton** in WebGPU compute shaders (WGSL). State is stored in ping-pong RGBA8 storage textures, enabling millions of particles at 60+ FPS. No framework dependencies — direct WebGPU API usage.

See [docs/INDEX.md](docs/INDEX.md) for full documentation.
