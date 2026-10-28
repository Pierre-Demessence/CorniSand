import { coverSize } from './glow';
import { SHADOW_FORMAT, shadowWGSL } from './shaders/shadow.wgsl';
import type { LookSettings } from './look';
import type { PassTimer } from './passes';

/**
 * The shadows of the matter on the wall (M11.4): a render pass at the cover texture's resolution that marches toward the
 * light through the cover's opacity. After `record`, `view` holds how shaded each texel is, 0 to 1, in world orientation;
 * the composite darkens empty space and gas by it, sampled bilinearly. The size follows the grid, fixed at load.
 */
export class Shadow {
  /** The shade of each texel, before the darkness setting. */
  readonly view: GPUTextureView;

  private readonly texture: GPUTexture;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;

  constructor(device: GPUDevice, width: number, height: number, cover: GPUTextureView, settings: LookSettings) {
    const size = coverSize(width, height);
    this.texture = device.createTexture({
      label: 'shadow',
      size: [size.width, size.height],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView();

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const module = device.createShaderModule({ code: shadowWGSL(settings.shadowLength, settings.lightDirection) });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SHADOW_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: cover }, { binding: 1, resource: sampler }],
    });
  }

  /** Records the pass into the caller's encoder, timed as `render:shadow` when the bench gives a timer. */
  record(encoder: GPUCommandEncoder, timer?: PassTimer): void {
    const pass = encoder.beginRenderPass({
      ...(timer && { timestampWrites: timer.stamp('render:shadow') }),
      colorAttachments: [{ view: this.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.texture.destroy();
  }
}
