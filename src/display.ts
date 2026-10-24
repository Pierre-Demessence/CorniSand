import { displayWGSL } from './shaders/display.wgsl';
import type { Vec2 } from './input';

export interface DisplayOptions {
  mousePos: Vec2;
  brushSize: number;
  showBrush: boolean;
  erasing: boolean;
  replacing: boolean;
}

// Uniform: 10 f32 + 2 padding = 12 f32 = 48 bytes
const UNIFORM_FLOATS = 12;
const UNIFORM_SIZE = UNIFORM_FLOATS * 4;

export class Display {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData: Float32Array<ArrayBuffer>;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly bindGroupA: GPUBindGroup;
  private readonly bindGroupB: GPUBindGroup;
  private readonly simBufferA: GPUBuffer;
  private readonly simWidth: number;
  private readonly simHeight: number;

  constructor(device: GPUDevice, format: GPUTextureFormat, simWidth: number, simHeight: number, simBufferA: GPUBuffer, simBufferB: GPUBuffer) {
    this.device = device;
    this.simWidth = simWidth;
    this.simHeight = simHeight;
    this.simBufferA = simBufferA;

    const shaderModule = device.createShaderModule({ code: displayWGSL });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformData = new Float32Array(UNIFORM_FLOATS);

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.bindGroupA = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: simBufferA } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
      ],
    });
    this.bindGroupB = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: simBufferB } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    simBuffer: GPUBuffer,
    screenWidth: number,
    screenHeight: number,
    opts: DisplayOptions,
  ): void {
    const d = this.uniformData;
    d[0] = this.simWidth;   // simResolution.x
    d[1] = this.simHeight;  // simResolution.y
    d[2] = screenWidth;     // screenResolution.x
    d[3] = screenHeight;    // screenResolution.y
    d[4] = opts.mousePos.x; // mousePos.x
    d[5] = opts.mousePos.y; // mousePos.y
    d[6] = opts.brushSize;  // brushSize
    d[7] = opts.showBrush ? 1.0 : 0.0; // showBrush
    d[8] = opts.erasing ? 1.0 : 0.0;   // erasing
    d[9] = opts.replacing ? 1.0 : 0.0; // replacing
    d[10] = 0; // _pad.x
    d[11] = 0; // _pad.y

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const bindGroup = simBuffer === this.simBufferA ? this.bindGroupA : this.bindGroupB;

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }
}
