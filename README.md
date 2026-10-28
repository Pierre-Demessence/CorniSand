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

- Sand, water, oil, fire, smoke, wall, metal, stone, ice, lava, steam and gunpowder particles, one per screen pixel
- Density layering: sand sinks through liquids, oil floats on water, smoke rises
- Liquids that fall, spread and settle flat, as in The Powder Toy: water and oil pour into basins, oil floats on water (connected vessels do not level)
- Test scenes to watch: `?scene=uTube`, `?scene=damBreak`, `?scene=oilOnWater` and more (`src/scenes.ts`)
- Fire burns oil in chain reactions, dies into smoke, and is put out by water
- Heat: every material has a temperature that spreads to its neighbors, much faster through metal than through stone. Ice melts and water boils, steam condenses on a cold surface, lava sets into stone, metal melts, and oil catches fire from anything hot enough; hot things glow
- Heat and Cool tools, a heat view (H) with a temperature legend, and the element and temperature under the pointer in the toolbar
- Heat scenes to watch: `?scene=heatBars`, `?scene=iceLava`, `?scene=steamCeiling` and `?scene=moltenMetal`
- Air: empty space is air that carries pressure, wind and heat, on a grid of 4×4-pixel cells. Lit gunpowder, and water flashing into steam, send out a pressure wave that throws sand and grains and crushes stone into sand; walls stop the air and the edge of the screen lets it out. Wind pushes smoke, flames and flying grains but not through a pile or a pool. Hot things warm the air above them, which rises in a plume that draws smoke in, so a hot block cools in the open and steam condenses into water
- Wind tool: drag to blow the air under the brush along the stroke, faster for a faster drag
- An air view (A) with a legend: pressure in colors that get lighter as it rises and arrows for the wind; the element, temperature and air pressure under the pointer in the toolbar
- Air scenes to watch: `?scene=explosion`, `?scene=plume` and `?scene=mound`; `?air=2` runs the air at 2×2-pixel cells (sharper, slower)
- Physics lab: `?scene=physics` shows a pot of water on a hot plate, dam breaks of water, oil and lava, hoppers of sand and gunpowder, an oil fire under a ceiling and a pond under a freezing ceiling
- Brush drawing (mouse or touch) with line interpolation, erasing, and Shift to draw over existing particles
- Simulation speed from 1/4x to 8x, FPS and live particle count

## Controls

- **Left click**: draw the selected particle
- **Right click**: erase
- **Scroll wheel**: brush size
- **1–9**: select Sand, Water, Oil, Fire, Smoke, Wall, Metal, Stone, Ice (Lava, Steam and Gunpowder by their buttons)
- **Heat / Cool buttons**: hold the left button to warm or cool what is under the brush
- **Wind button**: drag with the left button to blow the air along the stroke
- **H**: heat view on / off
- **A**: air view on / off (turns the heat view off)
- **[ / ]**: slower / faster
- **Shift + click**: draw over existing particles (except walls)

## How it works

Each frame runs, in WGSL compute shaders over storage buffers, a Margolus-neighborhood cellular automaton for every material (movement, fire, heat conduction and phase changes), steps a coarser air grid (pressure, wind and temperature) that the cells read and feed, then draws the cells with a fullscreen render pass. No framework, direct WebGPU API. Details in [docs/simulation.md](docs/simulation.md); contributor and agent notes in [AGENTS.md](AGENTS.md).
