import { ELEMENTS, type ElementDef } from '../src/elements';

// The default table with a gold solid that melts into MOLTEN_METAL at 1,064 °C, far under steel's 1,538 °C, and sets back into
// itself: it gives molten memory a second metal to remember (the real rows come with M8.1f). The values are rough (a test
// table's), only the ordering matters: gold is denser than steel.

export const GOLD = 41;

export const GOLD_ABOVE = { temp: 1064, becomes: 'MOLTEN_METAL', latent: 2000 } as const;

export const MOLTEN_TABLE: readonly ElementDef[] = [
  ...(ELEMENTS as readonly ElementDef[]),
  {
    key: 'GOLD', id: GOLD, label: 'Gold', color: [0.95, 0.78, 0.20], state: 'solid', density: 19300, conductivity: 318, heatCapacity: 2.5,
    above: GOLD_ABOVE,
  },
];
