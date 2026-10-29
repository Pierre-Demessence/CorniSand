import { ELEMENTS, type ElementDef } from '../src/elements';

// The default table with two more solids that melt into the molten elements it has, which is how M8.1d's tests give
// molten memory more than stone and steel to remember (the real rows come with M8.1e and M8.1f):
// - GLASS, a solid that melts into LAVA at 1,713 °C and sets back into itself;
// - SAND, which melts into the same LAVA at the same temperature but sets into GLASS (sand melts into glass);
// - GOLD, which melts into MOLTEN_METAL at 1,064 °C, far under steel's 1,538 °C, and sets back into itself.
// The values are rough (a test table's), only the ordering matters: gold is denser than steel, glass than stone.

export const GLASS = 40;
export const GOLD = 41;

export const SAND_SETS_INTO_GLASS = { temp: 1713, becomes: 'LAVA', latent: 800, setsInto: 'GLASS' } as const;
export const GLASS_ABOVE = { temp: 1713, becomes: 'LAVA', latent: 1000 } as const;
export const GOLD_ABOVE = { temp: 1064, becomes: 'MOLTEN_METAL', latent: 2000 } as const;

export const MOLTEN_TABLE: readonly ElementDef[] = [
  ...(ELEMENTS as readonly ElementDef[]).map((e): ElementDef => (e.key === 'SAND' ? { ...e, above: SAND_SETS_INTO_GLASS } : e)),
  {
    key: 'GLASS', id: GLASS, label: 'Glass', color: [0.55, 0.80, 0.82], state: 'solid', density: 2500, conductivity: 1, heatCapacity: 2,
    above: GLASS_ABOVE,
  },
  {
    key: 'GOLD', id: GOLD, label: 'Gold', color: [0.95, 0.78, 0.20], state: 'solid', density: 19300, conductivity: 318, heatCapacity: 2.5,
    above: GOLD_ABOVE,
  },
];
