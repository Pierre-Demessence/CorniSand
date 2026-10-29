import { MAX_ELEMENTS, validateElements, type ElementDef } from './elements';
import type { LookSettings } from './look';

// What the display reads of an element beyond its color: the visual properties of `ElementDef.look`, in a table of their
// own that only the display binds, so the CA's shared row (`src/element-table.ts`) does not grow for them (backlog D36).

interface DisplayField {
  name: string;
  value: (e: ElementDef, settings: LookSettings) => number;
}

/** The grain strength of a row: its own, or the default of its state (powders and solids only). */
export function elementGrain(e: ElementDef, settings: LookSettings): number {
  if (e.look?.grain !== undefined) return e.look.grain;
  if (e.state === 'powder') return settings.grainPowder;
  return e.state === 'solid' ? settings.grainSolid : 0;
}

/** How much of the wall a row hides: its own, or the default of its state. */
export function elementOpacity(e: ElementDef): number {
  if (e.look?.opacity !== undefined) return e.look.opacity;
  if (e.state === 'solid' || e.state === 'powder') return 1;
  return e.state === 'liquid' ? 0.35 : 0;
}

// The words of a row in struct order: the WGSL `DisplayProps` and `packDisplay` are both generated from this list. Eight
// 32-bit words, a multiple of four as a uniform array's stride needs; `pad0` to `pad2` are padding.
export const DISPLAY_FIELDS: readonly DisplayField[] = [
  { name: 'grain', value: elementGrain },
  { name: 'opacity', value: elementOpacity },
  { name: 'absorbR', value: (e) => e.look?.absorption?.[0] ?? 0 },
  { name: 'absorbG', value: (e) => e.look?.absorption?.[1] ?? 0 },
  { name: 'absorbB', value: (e) => e.look?.absorption?.[2] ?? 0 },
  { name: 'pad0', value: () => 0 },
  { name: 'pad1', value: () => 0 },
  { name: 'pad2', value: () => 0 },
];

const ROW_WORDS = DISPLAY_FIELDS.length;
export const DISPLAY_ROW_BYTES = ROW_WORDS * 4;

/** The display table as the uniform buffer holds it: `MAX_ELEMENTS` rows of `DISPLAY_ROW_BYTES`, rows for unused IDs zero. */
export function packDisplay(elements: readonly ElementDef[], settings: LookSettings): Float32Array<ArrayBuffer> {
  validateElements(elements);
  const words = new Float32Array(MAX_ELEMENTS * ROW_WORDS);
  for (const e of elements) {
    DISPLAY_FIELDS.forEach((field, i) => {
      words[e.id * ROW_WORDS + i] = field.value(e, settings);
    });
  }
  return words;
}

/** The display table in the GPU: one uniform buffer, bound by the display in its group 0. */
export class DisplayTable {
  readonly buffer: GPUBuffer;

  constructor(device: GPUDevice, elements: readonly ElementDef[], settings: LookSettings) {
    this.buffer = device.createBuffer({
      label: 'display table',
      size: MAX_ELEMENTS * DISPLAY_ROW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.buffer, 0, packDisplay(elements, settings));
  }
}
