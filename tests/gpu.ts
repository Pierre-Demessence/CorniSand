import type { FluidStage } from '../src/fluid';
import { PARTICLE_KIND, PARTICLE_STRIDE, type SpawnedParticles } from '../src/fluid-params';
import { SELECT_FIELDS, SELECT_WORDS, type SelectField } from '../src/shaders/fluid-raster.wgsl';
import { PARTICLE_TYPES } from '../src/particles';
import { MAX_SUPERSTEPS, Simulation, type SimulationInput, type SimulationOptions } from '../src/simulation';
import { mulberry32 } from '../src/random';

export { mulberry32 };

// Dawn crashes the process if the GPU instance is garbage-collected while its device is in use. One instance
// serves every device, so a device made with other adapter options cannot outlive the instance holding it.
let gpu: GPU | undefined;

export async function createDevice(options?: GPURequestAdapterOptions): Promise<GPUDevice | null> {
  try {
    // Imported lazily so a machine where the native binding does not load skips instead of failing.
    const { create, globals } = await import('webgpu');
    // Simulation code refers to GPUBufferUsage & co. as globals, as it does in a browser.
    Object.assign(globalThis, globals);
    gpu ??= create([]);
    const adapter = await gpu.requestAdapter(options);
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

export function cell(type: number, variant = 0, life = 0): number {
  return (type | (variant << 8) | (life << 16)) >>> 0;
}

export function cellType(c: number): number {
  return c & 0xff;
}

export function createSim(width: number, height: number, seed = 1, options: SimulationOptions = {}): Simulation {
  return new Simulation(device!, width, height, { seedSource: mulberry32(seed), ...options });
}

// Replaces the world with `cells`: the cell buffer and the particles of its liquid cells.
export function loadScene(sim: Simulation, cells: Uint32Array): void {
  sim.load(cells);
}

export function readCells(sim: Simulation): Promise<Uint32Array> {
  return readBuffer(device!, sim.currentBuffer, sim.width * sim.height * 4);
}

export type ParticleRecords = Pick<SpawnedParticles, 'count' | 'floats' | 'words'>;

// The live particles in buffer order (compaction does not keep one), as the 5-word records of `spawnParticles`:
// float index `PARTICLE_STRIDE * i + 0..3` is px, py, vx, vy and word `PARTICLE_STRIDE * i + 4` the kind.
// Dead particles are left out. Valid between frames, when the store holds exactly the compacted particles.
export async function readParticles(sim: Simulation): Promise<ParticleRecords> {
  const { count } = await readFluidState(sim);
  const raw = count > 0 ? await readBuffer(device!, sim.fluid.particleBuffer, count * PARTICLE_STRIDE * 4) : new Uint32Array(0);
  const words = new Uint32Array(count * PARTICLE_STRIDE);
  let live = 0;
  for (let i = 0; i < count; i++) {
    if (raw[i * PARTICLE_STRIDE + 4] === PARTICLE_KIND.DEAD) continue;
    words.set(raw.subarray(i * PARTICLE_STRIDE, (i + 1) * PARTICLE_STRIDE), live * PARTICLE_STRIDE);
    live++;
  }
  const trimmed = words.slice(0, live * PARTICLE_STRIDE);
  return { count: live, floats: new Float32Array(trimmed.buffer), words: trimmed };
}

// The counters of the particle store.
export async function readFluidState(sim: Simulation): Promise<{
  count: number;
  spawnCursor: number;
  compactCursor: number;
  water: number;
  oil: number;
}> {
  const [count, spawnCursor, compactCursor, water, oil] = await readBuffer(device!, sim.fluid.particleState, 20);
  return { count, spawnCursor, compactCursor, water, oil };
}

// The words of the radix-select state, by name (`SELECT_FIELDS` order).
export async function readSelectState(sim: Simulation): Promise<Record<SelectField, number>> {
  const words = await readBuffer(device!, sim.fluid.raster.select, SELECT_WORDS * 4);
  return Object.fromEntries(SELECT_FIELDS.map((name, i) => [name, words[i]])) as Record<SelectField, number>;
}

// Overwrites the named words of the radix-select state; the others keep their value.
export async function writeSelectState(sim: Simulation, values: Partial<Record<SelectField, number>>): Promise<void> {
  const words = await readBuffer(device!, sim.fluid.raster.select, SELECT_WORDS * 4);
  for (const [name, value] of Object.entries(values)) words[SELECT_FIELDS.indexOf(name as SelectField)] = value;
  device!.queue.writeBuffer(sim.fluid.raster.select, 0, words);
}

// One row [px, py, vx, vy, kind] per particle, sorted, to compare particle sets whose order differs.
export function particleRows(particles: ParticleRecords): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < particles.count; i++) {
    const at = i * PARTICLE_STRIDE;
    rows.push([...particles.floats.subarray(at, at + 4), particles.words[at + 4]]);
  }
  return rows.sort((a, b) => {
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k]) return a[k] - b[k];
    }
    return 0;
  });
}

export async function readFloats(buffer: GPUBuffer, count: number): Promise<Float32Array> {
  const words = await readBuffer(device!, buffer, count * 4);
  return new Float32Array(words.buffer);
}

// Records `steps` fluid updates in one compute pass, after a frame start unless `frameStart` is false; `stage` 'grid'
// stops each after passes 1-13, so the cells and the particles stay as they are; fails the test on any WebGPU
// validation error. No CA runs: use run() for whole supersteps.
export async function runFluid(sim: Simulation, steps: number, frameStart = true, stage: FluidStage = 'full'): Promise<void> {
  const dev = device!;
  dev.pushErrorScope('validation');
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginComputePass();
  if (frameStart) sim.fluid.recordFrameStart(pass, null);
  for (let s = 0; s < steps; s++) sim.fluid.recordStep(pass, stage);
  pass.end();
  dev.queue.submit([encoder.finish()]);
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
}

// The largest remaining residual of the pressure solve for the current pressure, weights and divergence.
export async function readResidual(sim: Simulation): Promise<number> {
  const dev = device!;
  dev.queue.writeBuffer(sim.fluid.grid.residual, 0, new Uint32Array([0]));
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginComputePass();
  sim.fluid.recordResidual(pass);
  pass.end();
  dev.queue.submit([encoder.finish()]);
  return (await readFloats(sim.fluid.grid.residual, 1))[0];
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
