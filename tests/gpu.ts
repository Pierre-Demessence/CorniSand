import { PARTICLE_TYPES } from '../src/particles';
import { MAX_SUPERSTEPS, Simulation, type SimulationInput } from '../src/simulation';

// Dawn crashes the process if the GPU instance is garbage-collected while its device is in use.
let gpu: GPU | undefined;

async function createDevice(): Promise<GPUDevice | null> {
  try {
    // Imported lazily so a machine where the native binding does not load skips instead of failing.
    const { create, globals } = await import('webgpu');
    // Simulation code refers to GPUBufferUsage & co. as globals, as it does in a browser.
    Object.assign(globalThis, globals);
    gpu = create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice({
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
  particleType: PARTICLE_TYPES.SAND,
};

// Deterministic 32-bit PRNG so a failing GPU test can be replayed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function cell(type: number, variant = 0, life = 0): number {
  return (type | (variant << 8) | (life << 16)) >>> 0;
}

export function cellType(c: number): number {
  return c & 0xff;
}

export function createSim(width: number, height: number, seed = 1): Simulation {
  return new Simulation(device!, width, height, { seedSource: mulberry32(seed) });
}

export function loadCells(sim: Simulation, cells: Uint32Array<ArrayBuffer>): void {
  device!.queue.writeBuffer(sim.currentBuffer, 0, cells);
}

export function readCells(sim: Simulation): Promise<Uint32Array> {
  return readBuffer(device!, sim.currentBuffer, sim.width * sim.height * 4);
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
