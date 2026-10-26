import { mulberry32 } from '../random';
import { PROTO, scaledParams, type MovementModel } from './params';
import {
  ARGS_DISPATCH, ARGS_DRAW, ARGS_WORDS, FLYER_WORDS, STATE, STATE_WORDS, type ShaderConstants,
  blastWGSL, caWGSL, compactScanWGSL, compactScatterWGSL, displayWGSL, flightWGSL, flyerDisplayWGSL, landWGSL,
  launchGroups, launchScanWGSL, launchScatterWGSL, retryWGSL, sourceWGSL,
} from './shaders';

// M4.1 movement prototype (docs/plans/m4-element-engine.md): sand, wall and empty only, moved by the baseline rules,
// by model A (velocity-driven Margolus) or by model C (A plus free flyers). Not wired into the game.

export interface ProtoOptions {
  model: MovementModel;
  seed: number;
  // Overrides PROTO.maxFlyers, for the cap test.
  maxFlyers?: number;
  // Dispatches per unit of game time (T4): 4 runs four times as many steps with the physics scaled to match.
  timeScale?: number;
}

export interface ProtoFlyer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  cell: number;
  retries: number;
  status: number;
}

export type ProtoStats = Record<keyof typeof STATE, number>;

export interface SourceRect {
  x0: number;
  x1: number;
  y: number;
}

const MAX_SUPERSTEPS = 64;
const STEP_BYTES = 8;
const FRAME_BYTES = 32;
const BLAST_BYTES = 32;
const NO_CLAIM = 0xffffffff;

export class MovementProto {
  readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  readonly model: MovementModel;
  readonly timeScale: number;
  readonly maxFlyers: number;
  readonly cells: GPUBuffer;
  readonly motion: GPUBuffer;
  readonly state: GPUBuffer;
  private readonly constants: ShaderConstants;
  private readonly seedSource: () => number;

  private readonly slotWords: number;
  private readonly slotData: Uint32Array<ArrayBuffer>;
  private readonly stepUniforms: GPUBuffer;
  readonly frameUniforms: GPUBuffer;
  private readonly frameData = new ArrayBuffer(FRAME_BYTES);
  private readonly blastUniforms: GPUBuffer;
  private readonly caPipeline: GPUComputePipeline;
  private readonly caBindGroup: GPUBindGroup;
  private readonly blastPipeline: GPUComputePipeline;
  private readonly blastBindGroup: GPUBindGroup;
  private readonly sourcePipeline: GPUComputePipeline;
  private readonly sourceBindGroup: GPUBindGroup;
  private source: SourceRect | null = null;
  private wind: [number, number] = [0, 0];

  private readonly flyerPasses: FlyerPasses | null;
  private renderer: Renderer | null = null;

  constructor(device: GPUDevice, width: number, height: number, options: ProtoOptions) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.model = options.model;
    this.timeScale = options.timeScale ?? 1;
    this.maxFlyers = options.maxFlyers ?? PROTO.maxFlyers;
    // A claim key holds the slot in 18 bits (claimKey in shaders.ts).
    if (this.maxFlyers > 1 << 18) throw new RangeError('maxFlyers is at most 2^18');
    this.seedSource = mulberry32(options.seed);
    this.constants = { width, height, maxFlyers: this.maxFlyers, ...scaledParams(this.timeScale) };

    const n = width * height;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.cells = device.createBuffer({ size: n * 4, usage: storage });
    this.motion = device.createBuffer({ size: n * 16, usage: storage });
    this.state = device.createBuffer({ size: STATE_WORDS * 4, usage: storage });

    this.slotWords = device.limits.minUniformBufferOffsetAlignment / 4;
    this.slotData = new Uint32Array(2 * MAX_SUPERSTEPS * this.slotWords);
    this.stepUniforms = device.createBuffer({ size: this.slotData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameUniforms = device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blastUniforms = device.createBuffer({ size: BLAST_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const compute = GPUShaderStage.COMPUTE;
    const caLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: compute, buffer: { type: 'storage' } },
        { binding: 1, visibility: compute, buffer: { type: 'storage' } },
        { binding: 2, visibility: compute, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 3, visibility: compute, buffer: { type: 'uniform' } },
        ...(this.model === 'c' ? [{ binding: 4, visibility: compute, buffer: { type: 'storage' as const } }] : []),
      ],
    });
    this.caPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [caLayout] }),
      compute: { module: device.createShaderModule({ code: caWGSL(this.model, this.constants) }), entryPoint: 'main' },
    });

    this.flyerPasses = this.model === 'c' ? new FlyerPasses(this) : null;

    this.caBindGroup = device.createBindGroup({
      layout: caLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cells } },
        { binding: 1, resource: { buffer: this.motion } },
        { binding: 2, resource: { buffer: this.stepUniforms, size: STEP_BYTES } },
        { binding: 3, resource: { buffer: this.frameUniforms } },
        ...(this.flyerPasses ? [{ binding: 4, resource: { buffer: this.flyerPasses.launchCounts } }] : []),
      ],
    });

    this.blastPipeline = this.computePipeline(blastWGSL(this.constants));
    this.blastBindGroup = this.bindGroup(this.blastPipeline, [this.cells, this.motion, this.blastUniforms]);
    this.sourcePipeline = this.computePipeline(sourceWGSL(this.constants));
    this.sourceBindGroup = this.bindGroup(this.sourcePipeline, [this.cells, this.motion, this.state, this.frameUniforms]);
  }

  computePipeline(code: string): GPUComputePipeline {
    return this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  bindGroup(pipeline: GPUComputePipeline | GPURenderPipeline, buffers: GPUBuffer[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  get shaderConstants(): ShaderConstants {
    return this.constants;
  }

  // Replaces the world and drops every flyer; `motion` is 4 floats per cell (vx, vy, remainder x, remainder y).
  load(cells: Uint32Array<ArrayBuffer>, motion?: Float32Array<ArrayBuffer>): void {
    const n = this.width * this.height;
    if (cells.length !== n) throw new RangeError(`expected ${n} cells, got ${cells.length}`);
    if (motion && motion.length !== 4 * n) throw new RangeError(`expected ${4 * n} motion floats, got ${motion.length}`);
    const queue = this.device.queue;
    queue.writeBuffer(this.cells, 0, cells);
    if (motion) queue.writeBuffer(this.motion, 0, motion);
    else {
      const encoder = this.device.createCommandEncoder();
      encoder.clearBuffer(this.motion);
      queue.submit([encoder.finish()]);
    }
    queue.writeBuffer(this.state, 0, new Uint32Array(STATE_WORDS));
    this.flyerPasses?.reset();
  }

  setSource(source: SourceRect | null): void {
    this.source = source;
  }

  // Acceleration in cells per dispatch² of every grain with an empty cell above, and of every flyer.
  setWind(ax: number, ay: number): void {
    const k = this.timeScale ** 2;
    this.wind = [ax / k, ay / k];
  }

  // Every grain within `radius` of (x, y) gets an outward velocity, `speed` cells/dispatch at the center falling
  // linearly to 0 at the radius, and the blast mark. Submitted at once, so it applies before the next frame.
  blast(x: number, y: number, radius: number, speed: number): void {
    const x0 = Math.max(0, Math.floor(x - radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const x1 = Math.min(this.width, Math.ceil(x + radius));
    const y1 = Math.min(this.height, Math.ceil(y + radius));
    if (x1 <= x0 || y1 <= y0) return;
    const data = new ArrayBuffer(BLAST_BYTES);
    new Float32Array(data, 0, 4).set([x, y, radius, speed / this.timeScale]);
    new Int32Array(data, 16, 2).set([x0, y0]);
    this.device.queue.writeBuffer(this.blastUniforms, 0, data);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.blastPipeline);
    pass.setBindGroup(0, this.blastBindGroup);
    pass.dispatchWorkgroups(Math.ceil((x1 - x0) / 8), Math.ceil((y1 - y0) / 8));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  // Records `supersteps` supersteps into one compute pass: the source, CA offset 0, CA offset 1, and under C the
  // launch, flight, landing and compaction of the flyers.
  simulate(encoder: GPUCommandEncoder, supersteps: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (supersteps < 0 || supersteps > MAX_SUPERSTEPS) throw new RangeError(`supersteps must be 0..${MAX_SUPERSTEPS}`);
    const dispatches = supersteps * 2;
    for (let i = 0; i < dispatches; i++) {
      this.slotData[i * this.slotWords] = i % 2;
      this.slotData[i * this.slotWords + 1] = this.seedSource();
    }
    this.device.queue.writeBuffer(this.stepUniforms, 0, this.slotData, 0, Math.max(1, dispatches) * this.slotWords);
    new Float32Array(this.frameData, 0, 2).set(this.wind);
    const src = this.source;
    new Uint32Array(this.frameData, 8, 4).set(src ? [1, src.x0, src.x1, src.y] : [0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.frameUniforms, 0, this.frameData);

    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : {});
    for (let i = 0; i < dispatches; i++) {
      const offset = i % 2;
      if (offset === 0 && src) {
        pass.setPipeline(this.sourcePipeline);
        pass.setBindGroup(0, this.sourceBindGroup);
        pass.dispatchWorkgroups(Math.ceil((src.x1 - src.x0) / 64));
      }
      pass.setPipeline(this.caPipeline);
      pass.setBindGroup(0, this.caBindGroup, [i * this.slotWords * 4]);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil((this.width + offset) / 2) / 8), Math.ceil(Math.ceil((this.height + offset) / 2) / 8));
      if (offset === 1) this.flyerPasses?.record(pass);
    }
    pass.end();
  }

  // Draws the cells, then the flyers, into `view` (a texture of the grid's aspect ratio).
  render(encoder: GPUCommandEncoder, view: GPUTextureView, format: GPUTextureFormat): void {
    this.renderer ??= new Renderer(this, format);
    this.renderer.render(encoder, view);
  }

  get flyers(): FlyerPasses | null {
    return this.flyerPasses;
  }

  async readCells(): Promise<Uint32Array> {
    return readBuffer(this.device, this.cells, this.width * this.height * 4);
  }

  async readMotion(): Promise<Float32Array> {
    const words = await readBuffer(this.device, this.motion, this.width * this.height * 16);
    return new Float32Array(words.buffer);
  }

  async readStats(): Promise<ProtoStats> {
    const words = await readBuffer(this.device, this.state, STATE_WORDS * 4);
    return Object.fromEntries(Object.entries(STATE).map(([name, i]) => [name, words[i]])) as ProtoStats;
  }

  // The live flyers, in slot order.
  async readFlyers(): Promise<ProtoFlyer[]> {
    if (!this.flyerPasses) return [];
    const { live } = await this.readStats();
    if (live === 0) return [];
    const words = await readBuffer(this.device, this.flyerPasses.current, live * FLYER_WORDS * 4);
    const floats = new Float32Array(words.buffer);
    const flyers: ProtoFlyer[] = [];
    for (let i = 0; i < live; i++) {
      const at = i * FLYER_WORDS;
      flyers.push({
        x: floats[at], y: floats[at + 1], vx: floats[at + 2], vy: floats[at + 3],
        cell: words[at + 4], retries: words[at + 7], status: words[at + 8],
      });
    }
    return flyers;
  }

  // Every word of the state the model keeps (cells, motion, flyer counters, live flyers), for determinism checks.
  async snapshot(): Promise<Uint32Array> {
    const parts = [await this.readCells(), new Uint32Array((await this.readMotion()).buffer), await readBuffer(this.device, this.state, STATE_WORDS * 4)];
    if (this.flyerPasses) {
      const live = parts[2][STATE.live];
      if (live > 0) parts.push(await readBuffer(this.device, this.flyerPasses.current, live * FLYER_WORDS * 4));
    }
    const out = new Uint32Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

// The flyer list of model C and the passes that launch, fly, land and compact it, once per superstep.
class FlyerPasses {
  readonly launchCounts: GPUBuffer;
  private readonly proto: MovementProto;
  private readonly launchPrefix: GPUBuffer;
  readonly buffers: [GPUBuffer, GPUBuffer];
  private readonly claim: GPUBuffer;
  readonly args: GPUBuffer;
  private readonly survivorCounts: GPUBuffer;
  private readonly survivorPrefix: GPUBuffer;
  // Which of `buffers` holds the live flyers.
  parity = 0;

  private readonly launchScan: GPUComputePipeline;
  private readonly launchScanGroup: GPUBindGroup;
  private readonly launchScatter: GPUComputePipeline;
  private readonly launchScatterGroups: GPUBindGroup[];
  private readonly flight: GPUComputePipeline;
  private readonly flightGroups: GPUBindGroup[];
  private readonly lands: GPUComputePipeline[];
  private readonly landGroups: GPUBindGroup[][];
  private readonly retry: GPUComputePipeline;
  private readonly retryGroups: GPUBindGroup[];
  private readonly compactScan: GPUComputePipeline;
  private readonly compactScanGroup: GPUBindGroup;
  private readonly compactScatter: GPUComputePipeline;
  private readonly compactScatterGroups: GPUBindGroup[];
  private readonly groups: { x: number; y: number };

  constructor(proto: MovementProto) {
    this.proto = proto;
    const device = proto.device;
    const k = proto.shaderConstants;
    this.groups = launchGroups(proto.width, proto.height);
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const groupCount = this.groups.x * this.groups.y;
    // The last word holds the superstep's launch total.
    this.launchCounts = device.createBuffer({ size: (groupCount + 1) * 4, usage: storage });
    this.launchPrefix = device.createBuffer({ size: groupCount * 4, usage: storage });
    const flyerBytes = proto.maxFlyers * FLYER_WORDS * 4;
    this.buffers = [device.createBuffer({ size: flyerBytes, usage: storage }), device.createBuffer({ size: flyerBytes, usage: storage })];
    this.claim = device.createBuffer({ size: proto.width * proto.height * 4, usage: storage });
    this.args = device.createBuffer({ size: ARGS_WORDS * 4, usage: storage | GPUBufferUsage.INDIRECT });
    const flyerGroups = Math.ceil(proto.maxFlyers / 64);
    this.survivorCounts = device.createBuffer({ size: flyerGroups * 4, usage: storage });
    this.survivorPrefix = device.createBuffer({ size: flyerGroups * 4, usage: storage });

    const { cells, motion, state } = proto;
    const [a, b] = this.buffers;
    const both = (make: (current: GPUBuffer, other: GPUBuffer) => GPUBindGroup): GPUBindGroup[] => [make(a, b), make(b, a)];

    this.launchScan = proto.computePipeline(launchScanWGSL(k));
    this.launchScanGroup = proto.bindGroup(this.launchScan, [this.launchCounts, this.launchPrefix, state, this.args]);
    this.launchScatter = proto.computePipeline(launchScatterWGSL(k));
    this.launchScatterGroups = both((cur) => proto.bindGroup(this.launchScatter, [cells, motion, cur, this.launchCounts, this.launchPrefix, state]));
    this.flight = proto.computePipeline(flightWGSL(k));
    this.flightGroups = both((cur) => proto.bindGroup(this.flight, [cells, cur, this.claim, state, proto.frameUniforms]));
    this.retry = proto.computePipeline(retryWGSL(k));
    this.retryGroups = both((cur) => proto.bindGroup(this.retry, [cells, cur, this.claim, state]));
    this.lands = [landWGSL(k, 1), landWGSL(k, 2)].map((code) => proto.computePipeline(code));
    this.landGroups = this.lands.map((land) => both((cur) => proto.bindGroup(land, [cells, cur, this.claim, state, motion, this.survivorCounts])));
    this.compactScan = proto.computePipeline(compactScanWGSL(k));
    this.compactScanGroup = proto.bindGroup(this.compactScan, [this.survivorCounts, this.survivorPrefix, state, this.args]);
    this.compactScatter = proto.computePipeline(compactScatterWGSL(k));
    this.compactScatterGroups = both((cur, other) => proto.bindGroup(this.compactScatter, [cur, other, this.survivorPrefix, state]));

    this.reset();
  }

  get current(): GPUBuffer {
    return this.buffers[this.parity];
  }

  reset(): void {
    const queue = this.proto.device.queue;
    queue.writeBuffer(this.claim, 0, new Uint32Array(this.proto.width * this.proto.height).fill(NO_CLAIM));
    const args = new Uint32Array(ARGS_WORDS);
    args[ARGS_DRAW + 1] = 1;
    queue.writeBuffer(this.args, 0, args);
  }

  record(pass: GPUComputePassEncoder): void {
    const p = this.parity;
    pass.setPipeline(this.launchScan);
    pass.setBindGroup(0, this.launchScanGroup);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.launchScatter);
    pass.setBindGroup(0, this.launchScatterGroups[p]);
    pass.dispatchWorkgroups(this.groups.x, this.groups.y);
    pass.setPipeline(this.flight);
    pass.setBindGroup(0, this.flightGroups[p]);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
    for (let round = 0; round < 2; round++) {
      if (round === 1) {
        pass.setPipeline(this.retry);
        pass.setBindGroup(0, this.retryGroups[p]);
        pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
      }
      pass.setPipeline(this.lands[round]);
      pass.setBindGroup(0, this.landGroups[round][p]);
      pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
    }
    pass.setPipeline(this.compactScan);
    pass.setBindGroup(0, this.compactScanGroup);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.compactScatter);
    pass.setBindGroup(0, this.compactScatterGroups[p]);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
    this.parity = 1 - p;
  }
}

class Renderer {
  private readonly proto: MovementProto;
  private readonly cellsPipeline: GPURenderPipeline;
  private readonly cellsGroup: GPUBindGroup;
  private readonly flyerPipeline: GPURenderPipeline | null;
  private readonly flyerGroups: GPUBindGroup[];

  constructor(proto: MovementProto, format: GPUTextureFormat) {
    this.proto = proto;
    const device = proto.device;
    const k = proto.shaderConstants;
    const cellsModule = device.createShaderModule({ code: displayWGSL(k) });
    this.cellsPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: cellsModule, entryPoint: 'vsCells' },
      fragment: { module: cellsModule, entryPoint: 'fsCells', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.cellsGroup = proto.bindGroup(this.cellsPipeline, [proto.cells]);
    const flyers = proto.flyers;
    if (flyers) {
      const module = device.createShaderModule({ code: flyerDisplayWGSL(k) });
      this.flyerPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vsFlyers' },
        fragment: { module, entryPoint: 'fsFlyers', targets: [{ format }] },
        primitive: { topology: 'point-list' },
      });
      this.flyerGroups = flyers.buffers.map((buffer) => proto.bindGroup(this.flyerPipeline!, [buffer]));
    } else {
      this.flyerPipeline = null;
      this.flyerGroups = [];
    }
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.cellsPipeline);
    pass.setBindGroup(0, this.cellsGroup);
    pass.draw(3);
    const flyers = this.proto.flyers;
    if (this.flyerPipeline && flyers) {
      pass.setPipeline(this.flyerPipeline);
      pass.setBindGroup(0, this.flyerGroups[flyers.parity]);
      pass.drawIndirect(flyers.args, ARGS_DRAW * 4);
    }
    pass.end();
  }
}

async function readBuffer(device: GPUDevice, buffer: GPUBuffer, byteLength: number): Promise<Uint32Array> {
  const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const data = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return data;
}
