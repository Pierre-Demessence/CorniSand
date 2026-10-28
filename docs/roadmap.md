# Roadmap

Direction: everything The Powder Toy simulates, in the browser on the GPU, on a larger playing field, then what only a GPU can afford. The reasoning and the frame budget are in `docs/powder-toy.md`. Every milestone keeps the frame budget set there on the reference RTX 4080, measured by `npm run bench`, with every size and resolution a setting so M10 can scale it down (`docs/decisions.md`). IDs are stable.

## M7 Electricity and energy particles

Sparks travel through conductors and power elements (heaters, switches, batteries), and photons, neutrons and electrons share cells with matter. Done when scene tests show a spark crossing a wire at a known speed, a powered heater warming water, and light reflected or absorbed by element.

## M8 Element catalogue

The rest of The Powder Toy's elements, family by family (explosives, nuclear, life, special), including the long-range ones (beams, portals, pistons). Done when every family is present and each element has a scene test of its main behavior.

## M9 Newtonian gravity

A gravity field computed from the mass layout pulls particles toward each other. Done when scene tests show a cloud of particles clumping and a light particle orbiting a heavy body.

## M10 Scaling down

The settings shrink to a default that is still as fun (no field, grid or step count bigger than it needs to be), then the game is measured on weaker hardware (real, or the dev machine's integrated GPU) and either trimmed further where a large speed gain costs little, or given presets or an in-app benchmark that picks settings. Done when the default holds 60 fps on the RTX 4080 with headroom, and a named low-end setup (at least the integrated GPU) holds 60 fps with its preset or detected settings.
