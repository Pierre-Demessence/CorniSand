import type { DisplayTable } from './display-table';
import { COVER_CELLS, COVER_FORMAT, coverageWGSL, EMISSION_CELLS, GAS_FORMAT, GLOW_FORMAT, glowChainWGSL } from './shaders/glow.wgsl';
import type { CellFields } from './cell-field-buffers';
import type { FlyerOverlay } from './flyers';
import type { ElementTable } from './element-table';
import type { PassTimer } from './passes';

const WORKGROUP = 8;

/** The size of each level of the chain: the emission texture (`EMISSION_CELLS` cells per texel), then half the size of the one before, at least 1 texel. */
export function glowLevelSizes(width: number, height: number, levels: number): { width: number; height: number }[] {
  const sizes = [{ width: Math.ceil(width / EMISSION_CELLS), height: Math.ceil(height / EMISSION_CELLS) }];
  for (let level = 1; level <= levels; level++) {
    const previous = sizes[level - 1];
    sizes.push({ width: Math.max(1, Math.ceil(previous.width / 2)), height: Math.max(1, Math.ceil(previous.height / 2)) });
  }
  return sizes;
}

/** The size of the cover texture: one texel per `COVER_CELLS` cells along each axis. */
export function coverSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.ceil(width / COVER_CELLS), height: Math.ceil(height / COVER_CELLS) };
}

/**
 * The coverage pass and the halo of the hot cells (M11.3). One thread of the coverage pass covers `COVER_CELLS` cells per
 * axis and writes the light they radiate into a half-resolution HDR texture, the cover texture (quarter resolution: the
 * opacity the shadow pass reads, the liquid share the depth of liquids is summed from) and the gas texture (the gas cells'
 * color, same resolution). A chain of downsamples and tent upsamples then blurs the light: after `recordChain`, `view`
 * holds it (linear, world orientation: texture row = the world's row) for the composite to add around the cells that
 * radiate. The sizes follow the grid, fixed at load, not the canvas.
 */
export class Glow {
  /** The finest level, after the chain has run: the halo, before its strength. */
  readonly view: GPUTextureView;
  /** What the coverage pass writes at a quarter of the cells' resolution: opacity in red, the liquid fraction in green (world orientation). */
  readonly cover: GPUTextureView;
  /** The gas cells as a cloud, at the cover's resolution: premultiplied linear color, their share in alpha (world orientation). */
  readonly gas: GPUTextureView;

  private readonly textures: GPUTexture[] = [];
  private readonly coverTexture: GPUTexture;
  private readonly gasTexture: GPUTexture;
  private readonly views: GPUTextureView[] = [];
  private readonly coverage: GPUComputePipeline;
  private readonly coverageTable: GPUBindGroup;
  private readonly first: GPURenderPipeline;
  private readonly down: GPURenderPipeline;
  private readonly up: GPURenderPipeline;
  // Binding the level before (down) or after (up) a pass renders into: downs[k - 1] reads level k - 1, ups[k] reads level k + 1.
  private readonly downs: GPUBindGroup[] = [];
  private readonly ups: GPUBindGroup[] = [];
  private readonly levels: number;
  private readonly cells: CellFields;
  private readonly elements: ElementTable;
  private readonly flyers: FlyerOverlay;
  private readonly groups: { x: number; y: number };

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    cells: CellFields,
    elements: ElementTable,
    flyers: FlyerOverlay,
    table: DisplayTable,
    graphics: Readonly<Record<string, string>>,
    levels: number,
  ) {
    this.levels = levels;
    this.cells = cells;
    this.elements = elements;
    this.flyers = flyers;

    const sizes = glowLevelSizes(width, height, levels);
    sizes.forEach((size, level) => {
      const texture = device.createTexture({
        label: `glow ${level}`,
        size: [size.width, size.height],
        format: GLOW_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | (level === 0 ? GPUTextureUsage.STORAGE_BINDING : 0),
      });
      this.textures.push(texture);
      this.views.push(texture.createView());
    });
    this.view = this.views[0];
    const cover = coverSize(width, height);
    this.coverTexture = device.createTexture({
      label: 'cover',
      size: [cover.width, cover.height],
      format: COVER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.cover = this.coverTexture.createView();
    this.gasTexture = device.createTexture({
      label: 'gas',
      size: [cover.width, cover.height],
      format: GAS_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.gas = this.gasTexture.createView();
    this.groups = {
      x: Math.ceil(width / (COVER_CELLS * WORKGROUP)),
      y: Math.ceil(height / (COVER_CELLS * WORKGROUP)),
    };

    // The coverage pass.
    const coverageLayout = device.createBindGroupLayout({
      entries: [
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: GLOW_FORMAT } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: COVER_FORMAT } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: GAS_FORMAT } },
      ],
    });
    this.coverageTable = device.createBindGroup({
      layout: coverageLayout,
      entries: [
        { binding: 2, resource: { buffer: table.buffer } },
        { binding: 3, resource: this.views[0] },
        { binding: 4, resource: this.cover },
        { binding: 5, resource: this.gas },
      ],
    });
    this.coverage = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [coverageLayout, cells.readLayout, elements.layout, flyers.layout] }),
      compute: {
        module: device.createShaderModule({ code: coverageWGSL(elements.elements, graphics, width, height) }),
        entryPoint: 'main',
      },
    });

    // The chain.
    const chainLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const module = device.createShaderModule({ code: glowChainWGSL });
    const pipeline = (entryPoint: string, additive: boolean): GPURenderPipeline => device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [chainLayout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint,
        targets: [{
          format: GLOW_FORMAT,
          ...(additive && {
            blend: {
              color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
            },
          }),
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.first = pipeline('fs_first', false);
    this.down = pipeline('fs_down', false);
    this.up = pipeline('fs_up', true);
    const bind = (view: GPUTextureView): GPUBindGroup => device.createBindGroup({
      layout: chainLayout,
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }],
    });
    for (let level = 1; level <= levels; level++) this.downs.push(bind(this.views[level - 1]));
    for (let level = 0; level < levels; level++) this.ups.push(bind(this.views[level + 1]));
  }

  /** Records the coverage pass (the emission and cover textures) into the caller's encoder; timed as `render:coverage` when the bench gives a timer. */
  recordCoverage(encoder: GPUCommandEncoder, timer?: PassTimer): void {
    const compute = encoder.beginComputePass(timer ? { timestampWrites: timer.stamp('render:coverage') } : {});
    compute.setPipeline(this.coverage);
    compute.setBindGroup(0, this.coverageTable);
    compute.setBindGroup(1, this.cells.readBindGroup);
    compute.setBindGroup(2, this.elements.bindGroup);
    compute.setBindGroup(3, this.flyers.bindGroup);
    compute.dispatchWorkgroups(this.groups.x, this.groups.y);
    compute.end();
  }

  /** Records the chain that blurs the emission texture into `view`; each pass is timed as `render:glow` when the bench gives a timer. */
  recordChain(encoder: GPUCommandEncoder, timer?: PassTimer): void {
    // Down the chain: each level is drawn over in full.
    for (let level = 1; level <= this.levels; level++) {
      this.draw(encoder, level === 1 ? this.first : this.down, this.downs[level - 1], this.views[level], 'clear', timer);
    }
    // Back up: the tent-filtered coarser level is added to each finer one.
    for (let level = this.levels - 1; level >= 0; level--) {
      this.draw(encoder, this.up, this.ups[level], this.views[level], 'load', timer);
    }
  }

  private draw(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    source: GPUBindGroup,
    target: GPUTextureView,
    loadOp: GPULoadOp,
    timer?: PassTimer,
  ): void {
    const pass = encoder.beginRenderPass({
      ...(timer && { timestampWrites: timer.stamp('render:glow') }),
      colorAttachments: [{ view: target, loadOp, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, source);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const texture of this.textures) texture.destroy();
    this.coverTexture.destroy();
    this.gasTexture.destroy();
  }
}
