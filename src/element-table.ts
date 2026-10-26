import { MAX_ELEMENTS, STATES, elementByKey, elementDrag, elementGravity, elementInert, elementTemperature, validateElements, type ElementDef } from './elements';

// What the GPU reads of a row, in struct order: the WGSL `ElementProps` and `packElements` are both generated from this
// list, so they cannot disagree. Twelve 32-bit words, 48 bytes, which is a legal stride for a uniform array.
interface PropField {
  name: string;
  wgslType: 'u32' | 'f32';
  value: (e: ElementDef, elements: readonly ElementDef[]) => number;
}

export const PROP_FIELDS: readonly PropField[] = [
  { name: 'colorR', wgslType: 'f32', value: (e) => e.color[0] },
  { name: 'colorG', wgslType: 'f32', value: (e) => e.color[1] },
  { name: 'colorB', wgslType: 'f32', value: (e) => e.color[2] },
  { name: 'density', wgslType: 'f32', value: (e) => e.density },
  { name: 'state', wgslType: 'u32', value: (e) => STATES.indexOf(e.state) },
  { name: 'flammable', wgslType: 'u32', value: (e) => (e.flammable ? 1 : 0) },
  { name: 'lifeStart', wgslType: 'u32', value: (e) => e.life?.start ?? 0 },
  // The decay in bits 0-7, the ID of the element a cell becomes when its life runs out in bits 8-15.
  { name: 'lifeRule', wgslType: 'u32', value: (e, all) => (e.life ? e.life.decay | (elementByKey(all, e.life.becomes).id << 8) : 0) },
  { name: 'gravity', wgslType: 'f32', value: (e) => elementGravity(e) },
  { name: 'drag', wgslType: 'f32', value: (e) => elementDrag(e) },
  // Derived from the row (`elementInert`), for the CA's skip of blocks that cannot change.
  { name: 'inert', wgslType: 'u32', value: (e) => (elementInert(e) ? 1 : 0) },
  { name: 'temperature', wgslType: 'f32', value: (e) => elementTemperature(e) },
];

const ROW_WORDS = PROP_FIELDS.length;
export const ROW_BYTES = ROW_WORDS * 4;

/** The table as the uniform buffer holds it: `MAX_ELEMENTS` rows of `ROW_BYTES`, rows for unused IDs zero. */
export function packElements(elements: readonly ElementDef[]): ArrayBuffer {
  validateElements(elements);
  const buffer = new ArrayBuffer(MAX_ELEMENTS * ROW_BYTES);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  for (const e of elements) {
    PROP_FIELDS.forEach((field, i) => {
      const at = e.id * ROW_WORDS + i;
      const v = field.value(e, elements);
      if (field.wgslType === 'f32') floats[at] = v;
      else words[at] = v;
    });
  }
  return buffer;
}

// The table in the GPU: one uniform buffer, bound as group 2 by every pass that needs a row. Indexed by a runtime
// element ID, a uniform array is one cached read, where a `const` array may be copied into every thread's memory.
export class ElementTable {
  readonly elements: readonly ElementDef[];
  readonly layout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  private readonly buffer: GPUBuffer;

  constructor(device: GPUDevice, elements: readonly ElementDef[]) {
    this.elements = elements;
    // Packing validates the table, so an invalid one fails before anything is allocated.
    const packed = packElements(elements);
    this.buffer = device.createBuffer({
      label: 'element table',
      size: MAX_ELEMENTS * ROW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.buffer, 0, packed);
    this.layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
  }
}
