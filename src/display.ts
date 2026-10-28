import { DisplayTable } from './display-table';
import { Glow } from './glow';
import { lookSettings, type Look, type LookSettings } from './look';
import { Shadow } from './shadow';
import { displayWGSL } from './shaders/display.wgsl';
import { GRAPHICS } from './shaders/graphics.wgsl';
import type { AirGrid } from './air-grid';
import type { CellFields } from './cell-field-buffers';
import type { FlyerOverlay } from './flyers';
import type { ElementTable } from './element-table';
import type { Vec2 } from './input';
import type { PassTimer } from './passes';

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
  /** `finished` (the default) or `cells`: each cell as itself, with its grain and the wall, and no halo. The heat and air views look the same in both. */
  look?: Look;
}

/** What a `Display` takes beyond the simulation's buffers. */
export interface DisplayExtras {
  /** The air, when the simulation has one: the heat and air views draw it. */
  air?: AirGrid;
  /** Overrides of `LOOK`, the defaults of the look. */
  settings?: Partial<LookSettings>;
}

// Uniform: 17 f32 used, padded to 20 f32 = 80 bytes
const UNIFORM_FLOATS = 20;
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
  private readonly settings: LookSettings;
  private readonly glow: Glow;
  private readonly shadow: Shadow;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    simWidth: number,
    simHeight: number,
    cells: CellFields,
    elements: ElementTable,
    flyers: FlyerOverlay,
    { air, settings }: DisplayExtras = {},
  ) {
    this.device = device;
    this.settings = lookSettings(settings);
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
    const table = new DisplayTable(device, elements.elements, this.settings);
    this.glow = new Glow(device, simWidth, simHeight, cells, elements, flyers, table, GRAPHICS, this.settings.glowLevels);
    this.shadow = new Shadow(device, simWidth, simHeight, this.glow.cover, this.settings);
    const glowSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const uniformLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // The halo of the glow chain and the sampler that reads it.
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // The shadow texture, read with the same sampler.
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // The cloud of gas cells, read with the same sampler.
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
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
        { binding: 2, resource: { buffer: table.buffer } },
        { binding: 3, resource: this.glow.view },
        { binding: 4, resource: glowSampler },
        { binding: 5, resource: this.shadow.view },
        { binding: 6, resource: this.glow.gas },
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
    timer?: PassTimer,
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
    d[12] = opts.look === 'cells' ? 1.0 : 0.0; // cellsLook
    d[13] = this.settings.wall; // wall
    d[14] = this.settings.glowStrength; // glow
    d[15] = this.settings.shadowDarkness; // shadow
    d[16] = this.settings.gasOpacity; // gas

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // The halo, the shadows and the cloud of gas are only read by the finished look; the cells look and the views record the
    // composite alone. The coverage pass serves all three, so it runs when any is on.
    if (opts.look !== 'cells' && !opts.heatView && !opts.airView) {
      const glowing = this.settings.glowStrength > 0;
      const shadowed = this.settings.shadowDarkness > 0;
      const clouded = this.settings.gasOpacity > 0;
      if (glowing || shadowed || clouded) this.glow.recordCoverage(encoder, timer);
      if (glowing) this.glow.recordChain(encoder, timer);
      if (shadowed) this.shadow.record(encoder, timer);
    }

    const pass = encoder.beginRenderPass({
      // Bench only: every render pass is timed under its own label, whatever the timer's `perPass`.
      ...(timer && { timestampWrites: timer.stamp('render:composite') }),
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
