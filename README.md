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

- Sand, water, oil, fire, smoke, wall, metal, stone, ice, lava and steam particles, one per screen pixel
- Density layering: sand sinks through liquids, oil floats on water, smoke rises
- Liquids that fall, spread and settle flat, as in The Powder Toy: water and oil pour into basins, oil floats on water (connected vessels do not level)
- Test scenes to watch: `?scene=uTube`, `?scene=damBreak`, `?scene=oilOnWater` and more (`src/scenes.ts`)
- Fire burns oil in chain reactions, dies into smoke, and is put out by water
- Heat: every material has a temperature that spreads to its neighbors, much faster through metal than through stone. Ice melts and water boils, steam condenses on a cold surface, lava sets into stone, metal melts, and oil catches fire from anything hot enough; hot things glow
- Heat and Cool tools, a heat view (H) with a temperature legend, and the element and temperature under the pointer in the toolbar
- Heat scenes to watch: `?scene=heatBars`, `?scene=iceLava`, `?scene=steamCeiling` and `?scene=moltenMetal`
- Brush drawing (mouse or touch) with line interpolation, erasing, and Shift to draw over existing particles
- Simulation speed from 1/4x to 8x, FPS and live particle count

## Controls

- **Left click**: draw the selected particle
- **Right click**: erase
- **Scroll wheel**: brush size
- **1–9**: select Sand, Water, Oil, Fire, Smoke, Wall, Metal, Stone, Ice (Lava and Steam by their buttons)
- **Heat / Cool buttons**: hold the left button to warm or cool what is under the brush
- **H**: heat view on / off
- **[ / ]**: slower / faster
- **Shift + click**: draw over existing particles (except walls)

## How it works

Each frame runs, in WGSL compute shaders over storage buffers, a Margolus-neighborhood cellular automaton for every material (movement, fire, heat conduction and phase changes), then draws the cells with a fullscreen render pass. No framework, direct WebGPU API. Details in [docs/simulation.md](docs/simulation.md); contributor and agent notes in [AGENTS.md](AGENTS.md).
