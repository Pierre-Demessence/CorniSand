import {
  MAX_ELEMENTS, STATES, crushPressure, densityMode, densityProfile, elementByKey, elementConductivity, elementDrag, elementGravity, elementHeatCapacity, elementHoldsHeat, elementInert, elementSlide, elementSpread,
  elementTemperature, latentWidth, shockLimit, transitionBurst, validateElements, type ElementDef,
} from './elements';
import { NO_THRESHOLD } from './heat';

// The `pressureAbove` of an element with no pressure transition: a finite float no air pressure reaches (infinity is not
// guaranteed to compare the same on every GPU).
export const NO_PRESSURE = 3e38;

// What the GPU reads of a row, in struct order: the WGSL `ElementProps` and `packElements` are both generated from this
// list, so they cannot disagree. A multiple of four 32-bit words (16 bytes), the stride a uniform array needs.
interface PropField {
  name: string;
  wgslType: 'u32' | 'f32';
  value: (e: ElementDef, elements: readonly ElementDef[]) => number;
}

const DENSITY_MODES = ['constant', 'knots', 'gas'] as const;

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
  { name: 'conductivity', wgslType: 'f32', value: (e) => elementConductivity(e) },
  { name: 'heatCapacity', wgslType: 'f32', value: (e) => elementHeatCapacity(e) },
  // Derived from the row (`elementHoldsHeat`): whether the cell's `temp` word means anything.
  { name: 'holdsHeat', wgslType: 'u32', value: (e) => (elementHoldsHeat(e) ? 1 : 0) },
  // The transitions: the temperature of each threshold (NO_THRESHOLD past the range when the element has none, so the
  // clamp to them needs no branch) and the latent width past it, in °C.
  { name: 'belowTemp', wgslType: 'f32', value: (e) => e.below?.temp ?? -NO_THRESHOLD },
  { name: 'belowWidth', wgslType: 'f32', value: (e) => (e.below ? latentWidth(e, e.below) : 0) },
  { name: 'aboveTemp', wgslType: 'f32', value: (e) => e.above?.temp ?? NO_THRESHOLD },
  { name: 'aboveWidth', wgslType: 'f32', value: (e) => (e.above ? latentWidth(e, e.above) : 0) },
  // The ID of the element a cell becomes: below in bits 0-7, above in bits 8-15, the pressure transition (or, for a row that
  // only cracks from thermal shock, the element it cracks into) in bits 16-23.
  // 0 (EMPTY) when absent, which no cell reaches since the threshold is out of range. Bits 24-31 are free.
  {
    name: 'transitions',
    wgslType: 'u32',
    value: (e, all) =>
      (e.below ? elementByKey(all, e.below.becomes).id : 0)
      | ((e.above ? elementByKey(all, e.above.becomes).id : 0) << 8)
      | ((e.pressureAbove || e.cracksInto ? elementByKey(all, (e.pressureAbove?.becomes ?? e.cracksInto)!).id : 0) << 16),
  },
  // The pressure the cell releases into the air as it passes the above threshold, or ignites into FIRE.
  { name: 'aboveBurst', wgslType: 'f32', value: (e) => (e.above ? transitionBurst(e.above) : 0) },
  // The pressure above which the cell becomes the element in bits 16-23 of `transitions`; out of reach when absent.
  { name: 'pressureAbove', wgslType: 'f32', value: (e) => crushPressure(e) ?? NO_PRESSURE },
  // How the density follows the temperature: 0 not at all, 1 by the knots below, 2 by the ideal-gas law from the first knot.
  { name: 'densityMode', wgslType: 'u32', value: (e) => DENSITY_MODES.indexOf(densityMode(e)) },
  // The four points of the density by temperature (`densityProfile`): temperatures, then densities.
  ...[0, 1, 2, 3].map((i): PropField => ({ name: `densityTemp${i}`, wgslType: 'f32', value: (e) => densityProfile(e).temps[i] })),
  ...[0, 1, 2, 3].map((i): PropField => ({ name: `densityKnot${i}`, wgslType: 'f32', value: (e) => densityProfile(e).densities[i] })),
  // The chance per dispatch that a liquid spreads sideways, from its viscosity (1 for everything else).
  { name: 'spread', wgslType: 'f32', value: (e) => elementSpread(e) },
  // The sideways speed a powder grain gets when it slides off a step, in cells per dispatch, from its angle of repose (0 for everything else).
  { name: 'slide', wgslType: 'f32', value: (e) => elementSlide(e) },
  // Padding.
  { name: 'pad2', wgslType: 'u32', value: () => 0 },
  // The temperature difference to a neighbor above which the cell cracks into the element in bits 16-23 of `transitions`
  // (`shockLimit`); 0 for a row that cannot crack.
  { name: 'shockLimit', wgslType: 'f32', value: (e) => shockLimit(e) ?? 0 },
  // Padding to a multiple of four words.
  { name: 'pad3', wgslType: 'u32', value: () => 0 },
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
