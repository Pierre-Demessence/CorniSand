import { MAX_PARTICLES, spawnParticles } from './fluid-params';
import type { CellBuffer } from './cell-buffer';
import type { SimulationInput } from './simulation';
import { BRUSH_UNIFORM_WORDS, brushWGSL } from './shaders/brush.wgsl';
import { GRID_WORKGROUP, PARTICLE_BYTES, PARTICLE_WORKGROUP, STATE_WORDS } from './shaders/fluid-common.wgsl';
import { fluidParticlesWGSL, PARTICLE_BINDINGS } from './shaders/fluid-particles.wgsl';
import { mulberry32 } from './random';

export interface FluidOptions {
  // Overrides the capacity computed from the grid and the device limits, for tests.
  particleCapacity?: number;
}

// Functions, not constants: tests install the WebGPU globals only after this module is imported.
const bufferUsage = (): number => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const argsUsage = (): number => GPUBufferUsage.INDIRECT | bufferUsage();

/** Particle slots the device can hold in one storage binding, up to four per grid cell. */
export function particleCapacityFor(device: GPUDevice, width: number, height: number): number {
  const { maxStorageBufferBindingSize, maxBufferSize } = device.limits;
  const byDevice = Math.floor(Math.min(maxStorageBufferBindingSize, maxBufferSize) / PARTICLE_BYTES);
  return Math.max(1, Math.min(4 * width * height, MAX_PARTICLES, byDevice));
}

/**
 * Halves the capacity until both particle buffers can be allocated. Allocation failure surfaces only as an
 * asynchronous `out-of-memory` error, so this probes with throwaway buffers before the synchronous constructors run.
 */
export async function fitParticleCapacity(device: GPUDevice, capacity: number): Promise<number> {
  for (let fit = capacity; fit > 1; fit = Math.floor(fit / 2)) {
    device.pushErrorScope('out-of-memory');
    const probes = [0, 1].map(() => device.createBuffer({ size: fit * PARTICLE_BYTES, usage: bufferUsage() }));
    const error = await device.popErrorScope();
    for (const probe of probes) probe.destroy();
    if (!error) return fit;
  }
  return 1;
}

const storageEntry = (binding: number, type: GPUBufferBindingType = 'storage'): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.COMPUTE,
  buffer: { type },
});

/**
 * Particle store of the liquids: two particle buffers that swap every frame, the counters and the indirect
 * arguments. A frame starts with `recordFrameStart`, which applies the brush to the particles and compacts them.
 */
export class Fluid {
  readonly capacity: number;
  /** { count, spawnCursor, compactCursor, water, oil } as u32; `count` is the live total after the last frame start. */
  readonly particleState: GPUBuffer;
  /** Indirect dispatch arguments: one thread per live particle. */
  readonly particleArgs: GPUBuffer;
  /** Indirect dispatch arguments: the cell and face grid, or nothing while no particle is alive. */
  readonly gridArgs: GPUBuffer;

  private readonly device: GPUDevice;
  private readonly cells: CellBuffer;
  private readonly seedSource: () => number;
  private readonly particleBuffers: [GPUBuffer, GPUBuffer];
  // Index of the buffer holding the live particles: the one the next frame start compacts from.
  private current: 0 | 1 = 0;

  private readonly brushUniformBuffer: GPUBuffer;
  private readonly brushUniformData = new ArrayBuffer(BRUSH_UNIFORM_WORDS * 4);
  private readonly brushFloats = new Float32Array(this.brushUniformData);
  private readonly brushWords = new Uint32Array(this.brushUniformData);

  private readonly killPipeline: GPUComputePipeline;
  private readonly brushPipeline: GPUComputePipeline;
  private readonly compactArgsPipeline: GPUComputePipeline;
  private readonly compactPipeline: GPUComputePipeline;
  private readonly finalizePipeline: GPUComputePipeline;
  // [cell buffer A or B][particle buffer A or B]
  private readonly killGroups: GPUBindGroup[][];
  private readonly brushGroups: GPUBindGroup[][];
  // [source particle buffer]
  private readonly compactGroups: GPUBindGroup[];
  private readonly compactArgsGroup: GPUBindGroup;
  private readonly finalizeGroup: GPUBindGroup;

  constructor(device: GPUDevice, cells: CellBuffer, seedSource: () => number, options: FluidOptions = {}) {
    this.device = device;
    this.cells = cells;
    this.seedSource = seedSource;
    const { width, height } = cells;
    this.capacity = options.particleCapacity ?? particleCapacityFor(device, width, height);
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > MAX_PARTICLES) {
      throw new RangeError(`particleCapacity must be an integer in 1..${MAX_PARTICLES}, got ${this.capacity}`);
    }

    const particleBuffer = (): GPUBuffer => device.createBuffer({ size: this.capacity * PARTICLE_BYTES, usage: bufferUsage() });
    this.particleBuffers = [particleBuffer(), particleBuffer()];
    this.particleState = device.createBuffer({ size: STATE_WORDS * 4, usage: bufferUsage() });
    this.particleArgs = device.createBuffer({ size: 12, usage: argsUsage() });
    this.gridArgs = device.createBuffer({ size: 12, usage: argsUsage() });
    this.brushUniformBuffer = device.createBuffer({
      size: this.brushUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const b = PARTICLE_BINDINGS;
    const particlesModule = device.createShaderModule({ code: fluidParticlesWGSL(width, height, this.capacity) });
    const pipeline = (entryPoint: string, entries: GPUBindGroupLayoutEntry[]): [GPUComputePipeline, GPUBindGroupLayout] => {
      const layout = device.createBindGroupLayout({ entries });
      const compute = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: particlesModule, entryPoint },
      });
      return [compute, layout];
    };
    const [killPipeline, killLayout] = pipeline('kill', [
      storageEntry(b.state),
      storageEntry(b.particles),
      storageEntry(b.cells, 'read-only-storage'),
      storageEntry(b.brush, 'uniform'),
    ]);
    const [compactArgsPipeline, compactArgsLayout] = pipeline('compactArgs', [
      storageEntry(b.state),
      storageEntry(b.particleArgs),
    ]);
    const [compactPipeline, compactLayout] = pipeline('compact', [
      storageEntry(b.state),
      storageEntry(b.particles),
      storageEntry(b.compacted),
    ]);
    const [finalizePipeline, finalizeLayout] = pipeline('finalize', [
      storageEntry(b.state),
      storageEntry(b.particleArgs),
      storageEntry(b.gridArgs),
    ]);
    this.killPipeline = killPipeline;
    this.compactArgsPipeline = compactArgsPipeline;
    this.compactPipeline = compactPipeline;
    this.finalizePipeline = finalizePipeline;

    const brushLayout = device.createBindGroupLayout({
      entries: [storageEntry(0), storageEntry(1, 'uniform'), storageEntry(2), storageEntry(3)],
    });
    this.brushPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [brushLayout] }),
      compute: {
        module: device.createShaderModule({ code: brushWGSL(width, height, this.capacity) }),
        entryPoint: 'main',
      },
    });

    const cellBuffers = [cells.bufferA, cells.bufferB];
    const buffer = (resource: GPUBuffer): GPUBindingResource => ({ buffer: resource });
    this.killGroups = cellBuffers.map((cellBuffer) => this.particleBuffers.map((particles) => device.createBindGroup({
      layout: killLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particles, resource: buffer(particles) },
        { binding: b.cells, resource: buffer(cellBuffer) },
        { binding: b.brush, resource: buffer(this.brushUniformBuffer) },
      ],
    })));
    this.brushGroups = cellBuffers.map((cellBuffer) => this.particleBuffers.map((particles) => device.createBindGroup({
      layout: brushLayout,
      entries: [
        { binding: 0, resource: buffer(cellBuffer) },
        { binding: 1, resource: buffer(this.brushUniformBuffer) },
        { binding: 2, resource: buffer(particles) },
        { binding: 3, resource: buffer(this.particleState) },
      ],
    })));
    this.compactGroups = [0, 1].map((source) => device.createBindGroup({
      layout: compactLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particles, resource: buffer(this.particleBuffers[source]) },
        { binding: b.compacted, resource: buffer(this.particleBuffers[1 - source]) },
      ],
    }));
    this.compactArgsGroup = device.createBindGroup({
      layout: compactArgsLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particleArgs, resource: buffer(this.particleArgs) },
      ],
    });
    this.finalizeGroup = device.createBindGroup({
      layout: finalizeLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particleArgs, resource: buffer(this.particleArgs) },
        { binding: b.gridArgs, resource: buffer(this.gridArgs) },
      ],
    });
    this.clear();
  }

  /** The buffer holding the live particles, `Particle { px, py, vx, vy: f32, kind: u32 }` records of 20 bytes. */
  get particleBuffer(): GPUBuffer {
    return this.particleBuffers[this.current];
  }

  /** Replaces the particles with `FLUID.perCell` at rest in every water and oil cell of `cells`. */
  load(cells: Uint32Array): void {
    const { width, height } = this.cells;
    const spawned = spawnParticles(cells, width, height);
    if (spawned.count > this.capacity) {
      throw new RangeError(`the scene needs ${spawned.count} particles, the store holds ${this.capacity}`);
    }
    if (spawned.count > 0) this.device.queue.writeBuffer(this.particleBuffer, 0, spawned.floats);
    this.setState(spawned.count, spawned.water, spawned.oil);
  }

  /** Removes every particle. */
  clear(): void {
    this.setState(0, 0, 0);
  }

  /**
   * Gives the live particles random velocities in [-0.5, 0.5) per component, drawn in the order of the CPU
   * reference's `FlipModel.seedVelocities`. Only meaningful right after `load`, while the buffer is still in
   * load order and no frame has been recorded.
   */
  async seedVelocities(seed: number): Promise<void> {
    const state = await this.read(this.particleState, STATE_WORDS * 4);
    const count = new Uint32Array(state)[0];
    if (count === 0) return;
    const records = new Float32Array(await this.read(this.particleBuffer, count * PARTICLE_BYTES));
    const rand = mulberry32(seed);
    const stride = PARTICLE_BYTES / 4;
    for (let p = 0; p < count; p++) {
      records[p * stride + 2] = rand() / 2 ** 32 - 0.5;
      records[p * stride + 3] = rand() / 2 ** 32 - 0.5;
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, records);
  }

  /**
   * Records the start of a frame into the caller's compute pass: the brush's effect on the particles, then the
   * compaction. The brush appends to the current buffer, after its `count` live particles, and compaction copies
   * everything live (old and new) into the other buffer, which becomes the current one.
   */
  recordFrameStart(pass: GPUComputePassEncoder, brush: SimulationInput | null): void {
    const cellsIndex = this.cells.currentBuffer === this.cells.bufferA ? 0 : 1;
    const source = this.current;

    if (brush) {
      this.writeBrushUniforms(brush);
      // Kills first, so they see the old cell types; spawning then appends behind the live particles.
      pass.setPipeline(this.killPipeline);
      pass.setBindGroup(0, this.killGroups[cellsIndex][source]);
      pass.dispatchWorkgroupsIndirect(this.particleArgs, 0);

      pass.setPipeline(this.brushPipeline);
      pass.setBindGroup(0, this.brushGroups[cellsIndex][source]);
      pass.dispatchWorkgroups(Math.ceil(this.cells.width / GRID_WORKGROUP), Math.ceil(this.cells.height / GRID_WORKGROUP));
    }

    pass.setPipeline(this.compactArgsPipeline);
    pass.setBindGroup(0, this.compactArgsGroup);
    pass.dispatchWorkgroups(1);

    pass.setPipeline(this.compactPipeline);
    pass.setBindGroup(0, this.compactGroups[source]);
    pass.dispatchWorkgroupsIndirect(this.particleArgs, 0);

    pass.setPipeline(this.finalizePipeline);
    pass.setBindGroup(0, this.finalizeGroup);
    pass.dispatchWorkgroups(1);

    this.current = source === 0 ? 1 : 0;
  }

  private setState(count: number, water: number, oil: number): void {
    const { width, height } = this.cells;
    const state = new Uint32Array(STATE_WORDS);
    state[0] = count;
    state[1] = count;
    state[3] = water;
    state[4] = oil;
    this.device.queue.writeBuffer(this.particleState, 0, state);
    const live = count > 0;
    this.device.queue.writeBuffer(this.particleArgs, 0, new Uint32Array([Math.ceil(count / PARTICLE_WORKGROUP), 1, 1]));
    this.device.queue.writeBuffer(this.gridArgs, 0, new Uint32Array(live
      ? [Math.ceil((width + 1) / GRID_WORKGROUP), Math.ceil((height + 1) / GRID_WORKGROUP), 1]
      : [0, 0, 0]));
  }

  private writeBrushUniforms(input: SimulationInput): void {
    const f = this.brushFloats;
    const w = this.brushWords;
    f[0] = input.prevMousePos.x;
    f[1] = input.prevMousePos.y;
    f[2] = input.mousePos.x;
    f[3] = input.mousePos.y;
    f[4] = input.brushSize;
    w[5] = input.particleType;
    w[6] = input.erasing ? 1 : 0;
    w[7] = input.replacing ? 1 : 0;
    w[8] = this.seedSource();
    this.device.queue.writeBuffer(this.brushUniformBuffer, 0, this.brushUniformData);
  }

  private async read(buffer: GPUBuffer, byteLength: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return data;
  }
}
