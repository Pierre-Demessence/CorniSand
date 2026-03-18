# CorniSand

GPU-accelerated falling sand simulation built with Three.js and WebGL shaders.

## Quick Start

```bash
npm install
npm run dev
```

## Controls

- **Left click**: Draw selected particle
- **Right click**: Erase particles
- **Scroll wheel**: Change brush size
- **1**: Select Sand
- **2**: Select Wall

## Architecture

The simulation runs entirely on the GPU using a **Margolus neighborhood cellular automaton** encoded in GLSL fragment shaders. State is stored in ping-pong RGBA8 render targets, enabling millions of particles at 60+ FPS.

See [docs/INDEX.md](docs/INDEX.md) for full documentation.
