import { cellWGSL } from './shaders/cell.wgsl';
import { solidCaWGSL } from './shaders/solid-ca.wgsl';
import { CellBuffer } from './cell-buffer';
import { Fluid, type FluidSolver, fitParticleCapacity, particleCapacityFor } from './fluid';
import type { Vec2 } from './input';

export interface SimulationInput {
  mousePos: Vec2;
  prevMousePos: Vec2;
  mouseActive: boolean;
  erasing: boolean;
  replacing: boolean;
  brushSize: number;
  particleType: number;
}

export interface SimulationOptions {
  // One u32 per call; injectable so tests can replay a fixed sequence.
  seedSource?: () => number;
  // Overrides the particle store's capacity, for tests; see `Fluid`.
  particleCapacity?: number;
  // Overrides the pressure solver and the sweeps of the 'sor' one, for tests and the bench; see `Fluid`.
  solver?: FluidSolver;
  iterations?: number;
}

// A superstep is two CA dispatches (Margolus offset 0, then 1).
export const MAX_SUPERSTEPS = 32;
const MAX_DISPATCHES = MAX_SUPERSTEPS * 2;

const defaultSeedSource = (): number => crypto.getRandomValues(new Uint32Array(1))[0];

export class Simulation {
  private readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  private readonly seedSource: () => number;

  private readonly cells: CellBuffer;
  // The liquid particles, and the brush that edits them together with the cells.
  readonly fluid: Fluid;

  // -- CA pipeline: one uniform slot per dispatch, picked with a dynamic offset --
  private readonly slotWords: number;
  private readonly slotData: Uint32Array<ArrayBuffer>;
  private readonly stepUniformBuffer: GPUBuffer;
  private readonly caPipeline: GPUComputePipeline;
  private readonly caBindGroupAtoB: GPUBindGroup;
  private readonly caBindGroupBtoA: GPUBindGroup;

  // Particle counting
  private readonly counterBuffer: GPUBuffer;
  private readonly counterStagingBuffer: GPUBuffer;
  private readonly countPipeline: GPUComputePipeline;
  private readonly countBindGroupLayout: GPUBindGroupLayout;
  private pendingCount = false;
  private mapping = false;
  private lastCount = 0;

  constructor(device: GPUDevice, width: number, height: number, options: SimulationOptions = {}) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.seedSource = options.seedSource ?? defaultSeedSource;

    this.cells = new CellBuffer(device, width, height);

    this.fluid = new Fluid(device, this.cells, this.seedSource, {
      particleCapacity: options.particleCapacity,
      solver: options.solver,
      iterations: options.iterations,
    });

    // -- CA setup --
    this.slotWords = device.limits.minUniformBufferOffsetAlignment / 4;
    this.slotData = new Uint32Array(MAX_DISPATCHES * this.slotWords);
    this.stepUniformBuffer = device.createBuffer({
      size: this.slotData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const caLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    });
    this.caPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [caLayout] }),
      compute: { module: device.createShaderModule({ code: solidCaWGSL(width, height) }), entryPoint: 'main' },
    });
    const caBindGroup = (input: GPUBuffer, output: GPUBuffer): GPUBindGroup => device.createBindGroup({
      layout: caLayout,
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        // Step uniforms are { offset, seed }: two u32.
        { binding: 2, resource: { buffer: this.stepUniformBuffer, size: 8 } },
      ],
    });
    this.caBindGroupAtoB = caBindGroup(this.cells.bufferA, this.cells.bufferB);
    this.caBindGroupBtoA = caBindGroup(this.cells.bufferB, this.cells.bufferA);

    // -- Particle counter setup --
    this.counterBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.counterStagingBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const countShader = device.createShaderModule({
      code: /* wgsl */`
        ${cellWGSL}

        @group(0) @binding(0) var<storage, read> cells: array<u32>;
        @group(0) @binding(1) var<storage, read_write> counter: atomic<u32>;

        const W: u32 = ${width}u;
        const H: u32 = ${height}u;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3u) {
          if (gid.x >= W || gid.y >= H) { return; }
          let t = cellType(cells[gid.y * W + gid.x]);
          if (t != TYPE_EMPTY && t != TYPE_WALL) {
            atomicAdd(&counter, 1u);
          }
        }
      `,
    });

    this.countBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.countPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.countBindGroupLayout] }),
      compute: { module: countShader, entryPoint: 'main' },
    });
  }

  // Sizes the particle store against what the device can allocate, which only an async probe can tell, then builds.
  static async create(device: GPUDevice, width: number, height: number, options: SimulationOptions = {}): Promise<Simulation> {
    const wanted = options.particleCapacity ?? particleCapacityFor(device, width, height);
    const particleCapacity = options.particleCapacity ?? await fitParticleCapacity(device, wanted);
    return new Simulation(device, width, height, { ...options, particleCapacity });
  }

  // Replaces the world: `cells` (width x height packed cells) go into the current buffer and the liquid cells get
  // their particles.
  load(cells: Uint32Array): void {
    if (cells.length !== this.width * this.height) {
      throw new RangeError(`expected ${this.width * this.height} cells, got ${cells.length}`);
    }
    this.fluid.load(cells);
    this.device.queue.writeBuffer(this.cells.currentBuffer, 0, cells);
  }

  clear(): void {
    this.cells.clear();
    this.fluid.clear();
  }

  // Records the frame start (the brush while a button is down, and the particle compaction) and `supersteps`
  // supersteps (a fluid update, then the two CA dispatches) into the caller's encoder; submitting it is the caller's job.
  simulate(encoder: GPUCommandEncoder, supersteps: number, input: SimulationInput): void {
    if (supersteps < 0 || supersteps > MAX_SUPERSTEPS) {
      throw new RangeError(`supersteps must be 0..${MAX_SUPERSTEPS}, got ${supersteps}`);
    }
    const dispatches = supersteps * 2;

    for (let i = 0; i < dispatches; i++) {
      this.slotData[i * this.slotWords] = i % 2;
      this.slotData[i * this.slotWords + 1] = this.seedSource();
    }
    this.device.queue.writeBuffer(this.stepUniformBuffer, 0, this.slotData, 0, dispatches * this.slotWords);

    const pass = encoder.beginComputePass();

    this.fluid.recordFrameStart(pass, input.mouseActive ? input : null);

    for (let i = 0; i < dispatches; i++) {
      const offset = i % 2;
      if (offset === 0) this.fluid.recordStep(pass);
      pass.setPipeline(this.caPipeline);
      const blocksX = Math.ceil((this.width + offset) / 2);
      const blocksY = Math.ceil((this.height + offset) / 2);
      const bindGroup = this.cells.currentBuffer === this.cells.bufferA ? this.caBindGroupAtoB : this.caBindGroupBtoA;
      pass.setBindGroup(0, bindGroup, [i * this.slotWords * 4]);
      pass.dispatchWorkgroups(Math.ceil(blocksX / 8), Math.ceil(blocksY / 8));
      this.cells.swap();
    }
    pass.end();
  }

  get currentBuffer(): GPUBuffer {
    return this.cells.currentBuffer;
  }

  get bufferA(): GPUBuffer {
    return this.cells.bufferA;
  }

  get bufferB(): GPUBuffer {
    return this.cells.bufferB;
  }

  requestParticleCount(): void {
    if (this.pendingCount) return;

    const zeros = new Uint32Array([0]);
    this.device.queue.writeBuffer(this.counterBuffer, 0, zeros);

    const bindGroup = this.device.createBindGroup({
      layout: this.countBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cells.currentBuffer } },
        { binding: 1, resource: { buffer: this.counterBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();

    encoder.copyBufferToBuffer(this.counterBuffer, 0, this.counterStagingBuffer, 0, 4);
    this.device.queue.submit([encoder.finish()]);
    this.pendingCount = true;
  }

  async readParticleCount(): Promise<number> {
    if (!this.pendingCount || this.mapping) return this.lastCount;

    this.mapping = true;
    try {
      await this.counterStagingBuffer.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(this.counterStagingBuffer.getMappedRange());
      this.lastCount = data[0];
      this.counterStagingBuffer.unmap();
      this.pendingCount = false;
    } finally {
      this.mapping = false;
    }
    return this.lastCount;
  }
}
