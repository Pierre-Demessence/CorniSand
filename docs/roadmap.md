# Roadmap

Direction: a physics foundation shared by all materials. A velocity field and a global pressure solve run beside the cell grid, so liquids get pressure and momentum, and later gases and solids move with the flow. The Margolus CA keeps handling what it handles well: sand, reactions, fire. IDs are stable.

## M2 Gases on the velocity field

Smoke and fire are carried by the air's velocity field, with buoyancy from heat, a wind tool, and smoke that dissipates. Done when scene tests show a fire's smoke rising as a plume that flows around obstacles, wind pushing smoke across the grid, and smoke disappearing over time.

## M3 Momentum for solids

Sand and other grains take momentum from the flow: water currents carry sand, impacts and explosions throw it. Done when scene tests show a current eroding a sand pile and a splash throwing grains.
