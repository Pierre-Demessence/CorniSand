## Features

| Feature                    | Status | Description                                                |
|----------------------------|--------|------------------------------------------------------------|
| GPU sand simulation        | Done   | Margolus neighborhood cellular automaton on GPU             |
| Wall particles             | Done   | Static solid blocks that sand piles on                      |
| Brush drawing              | Done   | Left-click paint with line interpolation                    |
| Eraser                     | Done   | Right-click erase with brush                                |
| Brush size control         | Done   | Scroll wheel adjusts brush radius                           |
| Clear button               | Done   | Reset entire simulation grid                                |
| Keyboard shortcuts         | Done   | 1-4 for particle selection, [/] for speed                   |
| Touch support              | Done   | Pointer events for mobile                                   |
| FPS counter                | Done   | Real-time framerate display                                 |
| Particle count display     | Done   | Live count of active particles (updated every 2s when idle) |
| Simulation speed control   | Done   | Variable speed 1/4x–8x via buttons or [/] keys             |
| Water particles            | Done   | Liquid that flows sideways, fills containers, density interactions |
| Smoke particles            | Done   | Gas that rises upward, disperses horizontally, lighter than all solids/liquids |
| Gas particles              | TODO   | Additional gas types (steam, toxic, etc.)                   |
| Particle interactions      | TODO   | Chemical reactions, temperature, state changes              |
