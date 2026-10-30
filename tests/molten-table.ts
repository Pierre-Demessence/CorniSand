import { ELEMENTS, type ElementDef } from '../src/elements';

// The default table, named for the tests of the melts (molten.test.ts), which run on it, and the rows they cover: each solid
// or powder that melts, with the liquid of its own material, and the solid that liquid sets into.

export const MOLTEN_TABLE: readonly ElementDef[] = ELEMENTS;

/** A meltable row, the liquid it melts into, and the solid that liquid sets into (sand's melt sets into glass, aerogel's into aerogel). */
export interface Melt {
  solid: string;
  liquid: string;
  sets: string;
}

export const MELTS: readonly Melt[] = [
  { solid: 'STONE', liquid: 'LAVA', sets: 'STONE' },
  { solid: 'GRAVEL', liquid: 'LAVA', sets: 'STONE' },
  { solid: 'SAND', liquid: 'MOLTEN_GLASS', sets: 'GLASS' },
  { solid: 'BROKEN_GLASS', liquid: 'MOLTEN_GLASS', sets: 'GLASS' },
  { solid: 'GLASS', liquid: 'MOLTEN_GLASS', sets: 'GLASS' },
  { solid: 'METAL', liquid: 'MOLTEN_METAL', sets: 'METAL' },
  { solid: 'ALUMINIUM', liquid: 'MOLTEN_ALUMINIUM', sets: 'ALUMINIUM' },
  { solid: 'COPPER', liquid: 'MOLTEN_COPPER', sets: 'COPPER' },
  { solid: 'GOLD', liquid: 'MOLTEN_GOLD', sets: 'GOLD' },
  { solid: 'TITANIUM', liquid: 'MOLTEN_TITANIUM', sets: 'TITANIUM' },
  { solid: 'TUNGSTEN', liquid: 'MOLTEN_TUNGSTEN', sets: 'TUNGSTEN' },
  { solid: 'CERAMIC', liquid: 'MOLTEN_CERAMIC', sets: 'CERAMIC' },
  { solid: 'INSULATION', liquid: 'MOLTEN_AEROGEL', sets: 'INSULATION' },
];

/** The keys of the liquids the melts make: the molten rocks and metals. */
export const MOLTEN_LIQUIDS: readonly string[] = [...new Set(MELTS.map((m) => m.liquid))];

/** The solids and powders of the table that melt into a liquid and are not in `MELTS`: the melts of water, wax, nitrogen and mercury (tests/heat.test.ts walks every threshold). */
export const OTHER_MELTS: readonly string[] = ['ICE', 'SNOW', 'WAX', 'SOLID_NITROGEN', 'SOLID_MERCURY'];
