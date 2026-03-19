import { simulationWGSL } from './shaders/simulation.wgsl';
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

// Uniform buffer: 14 f32 values, padded to 16-byte alignment (64 bytes total)
const UNIFORM_FLOATS = 16;
const UNIFORM_SIZE = UNIFORM_FLOATS * 4;

export class Simulation {
  private readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  private stepCount = 0;

  private texA: GPUTexture;
  private texB: GPUTexture;
  private current: GPUTexture;
  private next: GPUTexture;

  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData: Float32Array<ArrayBuffer>;
  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  // Pre-created bind groups for ping-pong (avoids per-frame allocation)
  private readonly viewA: GPUTextureView;
  private readonly viewB: GPUTextureView;
  private bindGroupAtoB: GPUBindGroup; // read A, write B
  private bindGroupBtoA: GPUBindGroup; // read B, write A

  // Particle counting
  private readonly counterBuffer: GPUBuffer;
  private readonly counterStagingBuffer: GPUBuffer;
  private readonly countPipeline: GPUComputePipeline;
  private readonly countBindGroupLayout: GPUBindGroupLayout;
  private pendingCount = false;
  private lastCount = 0;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;

    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST;

    const texDesc: GPUTextureDescriptor = {
      size: { width, height },
      format: 'rgba8unorm',
      usage: texUsage,
    };

    this.texA = device.createTexture(texDesc);
    this.texB = device.createTexture(texDesc);
    this.current = this.texA;
    this.next = this.texB;

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformData = new Float32Array(UNIFORM_FLOATS);

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const simModule = device.createShaderModule({ code: simulationWGSL });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: { module: simModule, entryPoint: 'main' },
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

    // Count non-empty, non-wall particles using atomic counter
    const countShader = device.createShaderModule({
      code: /* wgsl */`
        @group(0) @binding(0) var inputTex: texture_2d<f32>;
        @group(0) @binding(1) var<storage, read_write> counter: atomic<u32>;

        const TYPE_WALL: f32 = 2.0;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3u) {
          let dims = textureDimensions(inputTex);
          if (gid.x >= dims.x || gid.y >= dims.y) { return; }
          let cell = textureLoad(inputTex, vec2i(gid.xy), 0);
          let pType = floor(cell.r * 255.0 + 0.5);
          if (pType > 0.5 && abs(pType - TYPE_WALL) > 0.5) {
            atomicAdd(&counter, 1u);
          }
        }
      `,
    });

    this.countBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.countPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.countBindGroupLayout] }),
      compute: { module: countShader, entryPoint: 'main' },
    });

    // Pre-create texture views and bind groups for simulation ping-pong
    this.viewA = this.texA.createView();
    this.viewB = this.texB.createView();
    this.bindGroupAtoB = this.createSimBindGroup(this.viewA, this.viewB);
    this.bindGroupBtoA = this.createSimBindGroup(this.viewB, this.viewA);
  }

  private createSimBindGroup(input: GPUTextureView, output: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: input },
        { binding: 1, resource: output },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  clear(): void {
    const zeros = new Uint8Array(this.width * this.height * 4);
    this.device.queue.writeTexture(
      { texture: this.texA },
      zeros,
      { bytesPerRow: this.width * 4, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
    this.device.queue.writeTexture(
      { texture: this.texB },
      zeros,
      { bytesPerRow: this.width * 4, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
    this.stepCount = 0;
  }

  private swap(): void {
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
  }

  // Each step gets its own encoder+submit because all writeBuffer calls to the
  // same uniform buffer execute before a batched submit, so only the last write
  // would be visible to every dispatch. Per-step submit guarantees ordering.
  simulate(stepsPerFrame: number, input: SimulationInput): void {
    for (let i = 0; i < stepsPerFrame; i++) {
      this.step(0, i === 0 && input.mouseActive, input);
      this.step(1, false, input);
    }
  }

  private step(offset: number, applyInput: boolean, input: SimulationInput): void {
    const d = this.uniformData;
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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const bindGroup = this.current === this.texA ? this.bindGroupAtoB : this.bindGroupBtoA;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.swap();
    this.stepCount++;
  }

  get currentTexture(): GPUTexture {
    return this.current;
  }

  requestParticleCount(): void {
    if (this.pendingCount) return;

    const zeros = new Uint32Array([0]);
    this.device.queue.writeBuffer(this.counterBuffer, 0, zeros);

    const bindGroup = this.device.createBindGroup({
      layout: this.countBindGroupLayout,
      entries: [
        { binding: 0, resource: this.current === this.texA ? this.viewA : this.viewB },
        { binding: 1, resource: { buffer: this.counterBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();

    encoder.copyBufferToBuffer(this.counterBuffer, 0, this.counterStagingBuffer, 0, 4);
    this.device.queue.submit([encoder.finish()]);
    this.pendingCount = true;
  }

  async readParticleCount(): Promise<number> {
    if (!this.pendingCount) return this.lastCount;

    await this.counterStagingBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(this.counterStagingBuffer.getMappedRange());
    this.lastCount = data[0];
    this.counterStagingBuffer.unmap();
    this.pendingCount = false;
    return this.lastCount;
  }

  dispose(): void {
    this.texA.destroy();
    this.texB.destroy();
    this.uniformBuffer.destroy();
    this.counterBuffer.destroy();
    this.counterStagingBuffer.destroy();
  }
}
