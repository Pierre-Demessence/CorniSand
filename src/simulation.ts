import { solidCaWGSL } from './shaders/solid-ca.wgsl';
import { pressureWGSL } from './shaders/pressure.wgsl';
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

// CA uniform: 14 f32 values padded to 16 (64 bytes)
const CA_UNIFORM_FLOATS = 16;
const CA_UNIFORM_SIZE = CA_UNIFORM_FLOATS * 4;

// Pressure uniform: resolution (2f) + dt (1f) + pad (1f) = 16 bytes
const PRESSURE_UNIFORM_FLOATS = 4;
const PRESSURE_UNIFORM_SIZE = PRESSURE_UNIFORM_FLOATS * 4;

const PRESSURE_DIFFUSION_ITERS = 2;

export class Simulation {
  private readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  private readonly wgX: number;
  private readonly wgY: number;

  private readonly cells: CellBuffer;

  // -- CA pipeline --
  private readonly caUniformBuffer: GPUBuffer;
  private readonly caUniformData: Float32Array<ArrayBuffer>;
  private readonly caPipeline: GPUComputePipeline;
  private readonly caBindGroupLayout: GPUBindGroupLayout;
  private readonly caBindGroupAtoB: GPUBindGroup;
  private readonly caBindGroupBtoA: GPUBindGroup;

  // -- Pressure diffusion pipeline --
  private readonly pressureUniformBuffer: GPUBuffer;
  private readonly pressureUniformData: Float32Array<ArrayBuffer>;
  private readonly pressurePipeline: GPUComputePipeline;
  private readonly pressureBindGroupLayout: GPUBindGroupLayout;
  private readonly pressureBindGroupAtoB: GPUBindGroup;
  private readonly pressureBindGroupBtoA: GPUBindGroup;

  // Particle counting
  private readonly counterBuffer: GPUBuffer;
  private readonly counterStagingBuffer: GPUBuffer;
  private readonly countPipeline: GPUComputePipeline;
  private readonly countBindGroupLayout: GPUBindGroupLayout;
  private pendingCount = false;
  private mapping = false;
  private lastCount = 0;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.wgX = Math.ceil(width / 8);
    this.wgY = Math.ceil(height / 8);

    this.cells = new CellBuffer(device, width, height);

    // -- CA setup --
    this.caUniformBuffer = device.createBuffer({
      size: CA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.caUniformData = new Float32Array(CA_UNIFORM_FLOATS);

    this.caBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.caPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.caBindGroupLayout] }),
      compute: { module: device.createShaderModule({ code: solidCaWGSL }), entryPoint: 'main' },
    });

    // -- Pressure diffusion setup --
    this.pressureUniformBuffer = device.createBuffer({
      size: PRESSURE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pressureUniformData = new Float32Array(PRESSURE_UNIFORM_FLOATS);

    this.pressureBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.pressurePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.pressureBindGroupLayout] }),
      compute: { module: device.createShaderModule({ code: pressureWGSL }), entryPoint: 'main' },
    });

    // Particle counter setup
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
        struct Cell {
          pType: u32, variant: f32, lifetime: f32, pressure: f32,
          velocityX: f32, velocityY: f32, _pad0: f32, _pad1: f32,
        };
        @group(0) @binding(0) var<storage, read> cells: array<Cell>;
        @group(0) @binding(1) var<storage, read_write> counter: atomic<u32>;

        const W: u32 = ${width}u;
        const H: u32 = ${height}u;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3u) {
          if (gid.x >= W || gid.y >= H) { return; }
          let idx = gid.y * W + gid.x;
          let cell = cells[idx];
          if (cell.pType != 0u && cell.pType != 2u) {
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

    // Pre-create bind groups for ping-pong
    this.caBindGroupAtoB = this.createBindGroup(this.caBindGroupLayout, this.cells.bufferA, this.cells.bufferB, this.caUniformBuffer);
    this.caBindGroupBtoA = this.createBindGroup(this.caBindGroupLayout, this.cells.bufferB, this.cells.bufferA, this.caUniformBuffer);
    this.pressureBindGroupAtoB = this.createBindGroup(this.pressureBindGroupLayout, this.cells.bufferA, this.cells.bufferB, this.pressureUniformBuffer);
    this.pressureBindGroupBtoA = this.createBindGroup(this.pressureBindGroupLayout, this.cells.bufferB, this.cells.bufferA, this.pressureUniformBuffer);

    // Pressure uniforms are constant — write once
    this.pressureUniformData[0] = width;
    this.pressureUniformData[1] = height;
    this.pressureUniformData[2] = 1.0;
    this.pressureUniformData[3] = 0;
    device.queue.writeBuffer(this.pressureUniformBuffer, 0, this.pressureUniformData);
  }

  private createBindGroup(layout: GPUBindGroupLayout, input: GPUBuffer, output: GPUBuffer, uniform: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
  }

  private getCaBindGroup(): GPUBindGroup {
    return this.cells.currentBuffer === this.cells.bufferA
      ? this.caBindGroupAtoB : this.caBindGroupBtoA;
  }

  private getPressureBindGroup(): GPUBindGroup {
    return this.cells.currentBuffer === this.cells.bufferA
      ? this.pressureBindGroupAtoB : this.pressureBindGroupBtoA;
  }

  clear(): void {
    this.cells.clear();
  }

  // Pipeline: CA (offset 0+1) → pressure diffusion (N×)
  simulate(stepsPerFrame: number, input: SimulationInput): void {
    for (let i = 0; i < stepsPerFrame; i++) {
      // Margolus CA: two sub-steps (offset 0 and 1)
      this.caStep(0, i === 0 && input.mouseActive, input);
      this.caStep(1, false, input);

      for (let j = 0; j < PRESSURE_DIFFUSION_ITERS; j++) {
        this.pressurePass();
      }
    }
  }

  private caStep(offset: number, applyInput: boolean, input: SimulationInput): void {
    const d = this.caUniformData;
    d[0] = this.width;
    d[1] = this.height;
    d[2] = offset;
    d[3] = Math.random() * 10000;
    d[4] = input.mousePos.x;
    d[5] = input.mousePos.y;
    d[6] = input.prevMousePos.x;
    d[7] = input.prevMousePos.y;
    d[8] = input.brushSize;
    d[9] = input.particleType;
    d[10] = applyInput ? 1.0 : 0.0;
    d[11] = input.erasing ? 1.0 : 0.0;
    d[12] = input.replacing ? 1.0 : 0.0;
    d[13] = 0;

    this.device.queue.writeBuffer(this.caUniformBuffer, 0, this.caUniformData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.caPipeline);
    pass.setBindGroup(0, this.getCaBindGroup());
    pass.dispatchWorkgroups(this.wgX, this.wgY);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.cells.swap();
  }

  private pressurePass(): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pressurePipeline);
    pass.setBindGroup(0, this.getPressureBindGroup());
    pass.dispatchWorkgroups(this.wgX, this.wgY);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.cells.swap();
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
    pass.dispatchWorkgroups(this.wgX, this.wgY);
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

  dispose(): void {
    this.cells.dispose();
    this.caUniformBuffer.destroy();
    this.pressureUniformBuffer.destroy();
    this.counterBuffer.destroy();
    this.counterStagingBuffer.destroy();
  }
}
