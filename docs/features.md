## Features

| Feature                    | Status | Description                                                |
|----------------------------|--------|------------------------------------------------------------|
| GPU sand simulation        | Done   | Margolus neighborhood CA on WebGPU compute with storage buffers |
| Wall particles             | Done   | Static solid blocks that sand piles on                      |
| Brush drawing              | Done   | Left-click paint with line interpolation, Shift to replace existing |
| Eraser                     | Done   | Right-click erase with brush                                |
| Brush size control         | Done   | Scroll wheel adjusts brush radius                           |
| Clear button               | Done   | Reset entire simulation grid                                |
| Keyboard shortcuts         | Done   | 1-6 for particle selection, [/] for speed                   |
| Touch support              | Done   | Pointer events for mobile                                   |
| FPS counter                | Done   | Real-time framerate display                                 |
| Particle count display     | Done   | Live count of active particles (updated every 2s when idle) |
| Simulation speed control   | Done   | Variable speed 1/4x–8x via buttons or [/] keys             |
| Water particles            | Done   | Liquid that flows sideways, fills containers, pressure-biased flow for wave effects |
| Smoke particles            | Done   | Gas that rises upward, disperses horizontally, lighter than all solids/liquids |
| Oil particles              | Done   | Liquid that floats on water, sinks sand, dark brown color |
| Fire particles             | Done   | Burns oil via chain reaction, dies without fuel → smoke, extinguished by water |
| Gas particles              | TODO   | Additional gas types (steam, toxic, etc.)                   |
| Pressure diffusion         | Done   | Lightweight pressure/velocity diffusion across liquid cells for wave propagation |
| Particle interactions      | Partial| Fire↔oil ignition, fire↔water extinguish, sand→liquid splash impulse; more reactions planned |
| GitHub Pages deployment    | Done   | Auto-deploy to GitHub Pages on push to main                 |
