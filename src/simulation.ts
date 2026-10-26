import { cellWGSL } from './shaders/cell.wgsl';
import { BRUSH_UNIFORM_WORDS, brushWGSL } from './shaders/brush.wgsl';
import { caWGSL } from './shaders/ca.wgsl';
import { CellBuffer } from './cell-buffer';
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

  // -- Brush pipeline: edits the current cell buffer in place --
  private readonly brushUniformData = new ArrayBuffer(BRUSH_UNIFORM_WORDS * 4);
  private readonly brushFloats = new Float32Array(this.brushUniformData);
  private readonly brushWords = new Uint32Array(this.brushUniformData);
  private readonly brushUniformBuffer: GPUBuffer;
  private readonly brushPipeline: GPUComputePipeline;
  private readonly brushBindGroupA: GPUBindGroup;
  private readonly brushBindGroupB: GPUBindGroup;

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

    // -- Brush setup --
    this.brushUniformBuffer = device.createBuffer({
      size: this.brushUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const brushLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.brushPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [brushLayout] }),
      compute: { module: device.createShaderModule({ code: brushWGSL(width, height) }), entryPoint: 'main' },
    });
    const brushBindGroup = (cells: GPUBuffer): GPUBindGroup => device.createBindGroup({
      layout: brushLayout,
      entries: [
        { binding: 0, resource: { buffer: cells } },
        { binding: 1, resource: { buffer: this.brushUniformBuffer } },
      ],
    });
    this.brushBindGroupA = brushBindGroup(this.cells.bufferA);
    this.brushBindGroupB = brushBindGroup(this.cells.bufferB);

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
      compute: { module: device.createShaderModule({ code: caWGSL(width, height) }), entryPoint: 'main' },
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

  // Replaces the world: `cells` (width x height packed cells) go into the current buffer.
  load(cells: Uint32Array): void {
    if (cells.length !== this.width * this.height) {
      throw new RangeError(`expected ${this.width * this.height} cells, got ${cells.length}`);
    }
    this.device.queue.writeBuffer(this.cells.currentBuffer, 0, cells);
  }

  clear(): void {
    this.cells.clear();
  }

  // Records the brush (while a button is down) and `supersteps` supersteps (two CA dispatches each) into the caller's
  // encoder; submitting it is the caller's job.
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

    if (input.mouseActive) this.recordBrush(pass, input);

    for (let i = 0; i < dispatches; i++) {
      const offset = i % 2;
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

  private recordBrush(pass: GPUComputePassEncoder, input: SimulationInput): void {
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

    pass.setPipeline(this.brushPipeline);
    pass.setBindGroup(0, this.cells.currentBuffer === this.cells.bufferA ? this.brushBindGroupA : this.brushBindGroupB);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
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
