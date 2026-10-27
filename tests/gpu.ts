import type { AirData } from '../src/air-grid';
import { ELEMENT } from '../src/elements';
import { MAX_SUPERSTEPS, Simulation, type SimulationInput, type SimulationOptions } from '../src/simulation';
import { mulberry32 } from '../src/random';

export { mulberry32 };

// Dawn crashes the process if the GPU instance is garbage-collected while its device is in use. One instance
// serves every device, so a device made with other adapter options cannot outlive the instance holding it.
let gpu: GPU | undefined;

export async function createDevice(options?: GPURequestAdapterOptions, features: GPUFeatureName[] = []): Promise<GPUDevice | null> {
  try {
    // Imported lazily so a machine where the native binding does not load skips instead of failing.
    const { create, globals } = await import('webgpu');
    // Simulation code refers to GPUBufferUsage & co. as globals, as it does in a browser.
    Object.assign(globalThis, globals);
    gpu ??= create([]);
    const adapter = await gpu.requestAdapter(options);
    if (!adapter) return null;
    return await adapter.requestDevice({
      requiredFeatures: features.filter((feature) => adapter.features.has(feature)),
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
  } catch {
    return null;
  }
}

// Null on machines without a usable GPU (CI runners): suites skip themselves.
export const device = await createDevice();

export async function readBuffer(dev: GPUDevice, buffer: GPUBuffer, byteLength: number): Promise<Uint32Array> {
  const staging = dev.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = dev.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
  dev.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const data = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return data;
}

export const idleInput: SimulationInput = {
  mousePos: { x: 0, y: 0 },
  prevMousePos: { x: 0, y: 0 },
  mouseActive: false,
  erasing: false,
  replacing: false,
  brushSize: 0,
  particleType: ELEMENT.SAND,
};

// A `kind` word.
export function cell(type: number, variant = 0): number {
  return (type | (variant << 8)) >>> 0;
}

export function cellType(c: number): number {
  return c & 0xff;
}

export function createSim(width: number, height: number, seed = 1, options: SimulationOptions = {}): Simulation {
  return new Simulation(device!, width, height, { seedSource: mulberry32(seed), ...options });
}

// Replaces the world with `kind` words (and `life` words, when given).
export function loadScene(sim: Simulation, kind: Uint32Array<ArrayBuffer>, life?: Uint32Array<ArrayBuffer>): void {
  sim.load({ kind, ...(life && { life }) });
}

// The `kind` word of every cell.
export function readCells(sim: Simulation): Promise<Uint32Array> {
  return sim.fields.read('kind');
}

// Records and submits one encoder; fails the test on any WebGPU validation error.
export async function run(sim: Simulation, supersteps: number, input: SimulationInput = idleInput): Promise<void> {
  const dev = device!;
  dev.pushErrorScope('validation');
  const encoder = dev.createCommandEncoder();
  sim.simulate(encoder, supersteps, input);
  dev.queue.submit([encoder.finish()]);
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
}

// Same as run(), split into encoders of at most MAX_SUPERSTEPS.
export async function runMany(sim: Simulation, supersteps: number): Promise<void> {
  for (let left = supersteps; left > 0; left -= MAX_SUPERSTEPS) {
    await run(sim, Math.min(left, MAX_SUPERSTEPS));
  }
}

export function countTypes(cells: Uint32Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of cells) {
    const t = cellType(c);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

// The bits of each air array, so that a -0 or a NaN counts as a difference.
export function airWords(air: AirData): Record<keyof AirData, Uint32Array> {
  const bits = (values: Float32Array): Uint32Array => new Uint32Array(values.buffer, values.byteOffset, values.length);
  return {
    pressure: bits(air.pressure),
    velocityX: bits(air.velocityX),
    velocityY: bits(air.velocityY),
    temperature: bits(air.temperature),
  };
}
