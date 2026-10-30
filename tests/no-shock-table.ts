import { ELEMENTS, type ElementDef } from '../src/elements';

// The default table with every shock limit taken out: its solids do not crack from a temperature difference. For the tests of
// a mechanic that runs beside hot and cold solids (heat conservation, phase changes, a blast's crush) and is not about thermal
// shock (M8.1k), where a cell cracking into its broken form would change what they count. The tests of the shock itself
// (`tests/shock.test.ts`) run on the real table.

export function withoutShock(elements: readonly ElementDef[] = ELEMENTS): readonly ElementDef[] {
  return elements.map((e) => {
    if (e.expansion === undefined) return e;
    return { ...e, expansion: undefined, stiffness: undefined, cracksInto: undefined, toughness: e.pressureAbove ? e.toughness : undefined };
  });
}

export const NO_SHOCK_TABLE: readonly ElementDef[] = withoutShock();
