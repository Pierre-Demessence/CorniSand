# CorniSand

GPU-accelerated falling sand sandbox running entirely in native WebGPU compute shaders.

**[Live Demo](https://pierre-demessence.github.io/CorniSand/)**

## Quick Start

```bash
npm install
npm run dev
```

Requires a WebGPU-capable browser (Chrome 113+, Edge 113+, Safari 18.2+).

## Features

- Sand, water, oil, fire, smoke and wall particles, one per screen pixel
- Density layering: sand sinks through liquids, oil floats on water, smoke rises
- Liquids with pressure and momentum: connected vessels settle at the same level, water sloshes, splashes and runs up walls, oil floats on water
- Test scenes to watch: `?scene=uTube`, `?scene=damBreak`, `?scene=oilOnWater` and more (`src/scenes.ts`)
- Fire burns oil in chain reactions, dies into smoke, and is put out by water
- Brush drawing (mouse or touch) with line interpolation, erasing, and Shift to draw over existing particles; liquids drawn with the brush keep their volume
- Simulation speed from 1/4x to 8x, FPS and live particle count

## Controls

- **Left click**: draw the selected particle
- **Right click**: erase
- **Scroll wheel**: brush size
- **1–6**: select Sand, Water, Oil, Fire, Smoke, Wall
- **[ / ]**: slower / faster
- **Shift + click**: draw over existing particles (except walls)

## How it works

Each frame runs, in WGSL compute shaders over storage buffers, a FLIP particle fluid step for water and oil (a global pressure solve on a velocity grid) and a Margolus-neighborhood cellular automaton for sand, smoke and fire, then draws the cells with a fullscreen render pass. No framework, direct WebGPU API. Details in [docs/simulation.md](docs/simulation.md); contributor and agent notes in [AGENTS.md](AGENTS.md).
