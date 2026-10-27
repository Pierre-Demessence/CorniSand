import { displayWGSL } from './shaders/display.wgsl';
import { GRAPHICS } from './shaders/graphics.wgsl';
import type { AirGrid } from './air-grid';
import type { CellFields } from './cell-field-buffers';
import type { FlyerOverlay } from './flyers';
import type { ElementTable } from './element-table';
import type { Vec2 } from './input';

export interface DisplayOptions {
  mousePos: Vec2;
  brushSize: number;
  showBrush: boolean;
  erasing: boolean;
  replacing: boolean;
  /** Draw each cell that holds heat in its temperature's color instead of its own. */
  heatView?: boolean;
  /** Draw the air: its pressure under the materials, faded, and its wind as arrows. Takes the place of the heat view. */
  airView?: boolean;
}

// Uniform: 12 f32 = 48 bytes
const UNIFORM_FLOATS = 12;
const UNIFORM_SIZE = UNIFORM_FLOATS * 4;

export class Display {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData: Float32Array<ArrayBuffer>;
  private readonly uniformBindGroup: GPUBindGroup;
  private readonly cells: CellFields;
  private readonly elements: ElementTable;
  private readonly flyers: FlyerOverlay;
  private readonly simWidth: number;
  private readonly simHeight: number;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    simWidth: number,
    simHeight: number,
    cells: CellFields,
    elements: ElementTable,
    flyers: FlyerOverlay,
    air?: AirGrid,
  ) {
    this.device = device;
    this.simWidth = simWidth;
    this.simHeight = simHeight;
    this.cells = cells;
    this.elements = elements;
    this.flyers = flyers;

    const shaderModule = device.createShaderModule({ code: displayWGSL(elements.elements, GRAPHICS, air?.shape) });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformData = new Float32Array(UNIFORM_FLOATS);

    const uniformLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // The air state, when there is air: binding 1 of group 0, as the generated shader declares it.
        ...(air?.state ? [{ binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' as const } }] : []),
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, cells.readLayout, elements.layout, flyers.layout] }),
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

    this.uniformBindGroup = device.createBindGroup({
      layout: uniformLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        ...(air?.state ? [{ binding: 1, resource: { buffer: air.state } }] : []),
      ],
    });
  }

  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
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
    d[10] = opts.heatView ? 1.0 : 0.0; // heatView
    d[11] = opts.airView ? 1.0 : 0.0; // airView

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformBindGroup);
    pass.setBindGroup(1, this.cells.readBindGroup);
    pass.setBindGroup(2, this.elements.bindGroup);
    pass.setBindGroup(3, this.flyers.bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }
}
