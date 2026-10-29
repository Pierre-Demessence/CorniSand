# Roadmap

Direction: elements that behave by real physics, with The Powder Toy as the inspiration for what to simulate, in the browser on the GPU, on a larger playing field, then what only a GPU can afford. The reasoning and the frame budget are in `docs/powder-toy.md`. Every milestone keeps the frame budget set there on the reference RTX 4080, measured by `npm run bench`, with every size and resolution a setting so M10 can scale it down (`docs/decisions.md`). IDs are stable. Next ID: M12.

Order: M8, then M7, M9, M10.

## M8 Element catalogue

The Powder Toy's elements that need only what the game simulates before M7 (heat, fire, air and pressure), slice by slice, with real physical properties. Each models a real material where one exists. Done when every slice is done: each element has a scene test of its main behavior, and the frame budget holds.

- **M8.1** Materials and the element picker (`docs/plans/m8.1-materials.md`).
- **M8.2** Fire and explosives: slow burning (wood, coal, fuse, ignition cord), acrylic (it burns; with M8.1's aluminium it makes the `iceOnMetal` scenario), dust that burns in a flash, flammable gas, plasma, cold flame, pressure-set explosives (C-4, nitroglycerin, diesel), TNT that goes off as a whole (backlog I18), bombs, thermite, fireworks, a cold-set explosive, and stored energy (uranium heats under pressure, vibranium, the singularity); ignition temperature, heat of combustion and burn speed as properties, oxygen in the air.
- **M8.3** Air, gases and force: heavy gases (carbon dioxide, dry ice), gases that expand when heated or cool when compressed (Boyle gas, refrigerant), vents and vacuum, accelerators and decelerators, repellers, anti-air dust, glow that lights up under pressure, goo, concrete, dust colored by its speed, a wall that opens under pressure.
- **M8.4** Chemistry: reactions between elements in contact: salt dissolves into salt water up to its solubility, clay and water make paste that bakes into brick, acid dissolves and base neutralizes it, hydrogen burns with oxygen into water (oxygen and liquid oxygen), lithium and rubidium explode in water, iron rusts into broken metal, platinum speeds reactions, soda water fizzes, virus spreads and soap cures it, antimatter annihilates, sponge and gel soak up water, yeast grows, freeze powder.
- **M8.5** Life: Life-like and Generations rules (Conway's Life and its variants, TPT's set of about 24, rules from LifeWiki's public catalogue) on painted cells, in a pass of their own outside the Margolus CA.
- **M8.6** Special and growing: clone, breakable clone, converter, void, warp, TRON, plants that drink water and grow, vines, seeds that grow trees, bizarre (it melts when cold).
- **M8.7** Portals and pipes: portals that carry what enters one to another of the same channel, pipes that carry particles along their length.

## M7 Electricity and energy particles

Sparks travel through conductors and power elements (heaters, switches, batteries), and photons, neutrons and electrons share cells with matter. It also brings the elements that need sparks or energy particles (TPT's electronics, powered materials and sensors, beams, pistons and frames, the radioactive elements that emit particles, quartz, filter, distilled water, noble gas, fog and rime, resist, shield, lightning and thunder), and the electrical and optical properties of every element (resistivity, transparency, reflection). Done when scene tests show a spark crossing a wire at a known speed, a powered heater warming water, and light reflected or absorbed by element.

## M9 Newtonian gravity

A gravity field computed from the mass layout pulls particles toward each other. And the elements that need it: black and white holes, the gravity bomb, gravitons, the gravity pump. Done when scene tests show a cloud of particles clumping and a light particle orbiting a heavy body.

## M10 Scaling down

The settings shrink to a default that is still as fun (no field, grid or step count bigger than it needs to be), then the game is measured on weaker hardware (real, or the dev machine's integrated GPU) and either trimmed further where a large speed gain costs little, or given presets or an in-app benchmark that picks settings. Done when the default holds 60 fps on the RTX 4080 with headroom, and a named low-end setup (at least the integrated GPU) holds 60 fps with its preset or detected settings.
