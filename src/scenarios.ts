import type { Scene } from './scenes';

// The scenario scenes (`?scene=<name>`), each built from `scene-canvas.ts`'s primitives and registered here by
// the item that adds the scenario; `SCENES` spreads them in. A type-only import keeps `scenes.ts` free of a cycle.
export const SCENARIO_SCENES: Record<string, () => Scene> = {};
