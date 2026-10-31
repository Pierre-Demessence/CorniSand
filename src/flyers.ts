import type { AirShape } from './air';
import { CELL_FIELDS, OVERLAY_BYTES } from './cell-fields';
import type { CellFields } from './cell-field-buffers';
import type { ElementTable } from './element-table';
import { MAX_FLYER_SLOTS, launchGroups } from './movement';
import type { PassRecorder } from './passes';
import {
  ARGS_DISPATCH, ARGS_WORDS, FLYER_OFFSET, FLYER_STATE, FLYER_STATE_WORDS, FLYER_WORDS,
  compactScanWGSL, compactScatterWGSL, flightWGSL, flyerBrushWGSL, landWGSL, launchScanWGSL, launchScatterWGSL,
  overlayWGSL, retryWGSL, FLIGHT_FIELDS,
} from './shaders/flyers.wgsl';

// The flyer list: cells fast enough to leave the grid, and the passes that launch, fly, land and compact them once per
// superstep (`src/shaders/flyers.wgsl.ts`). The live flyers sit in one of two buffers; compaction writes the survivors
// to the other, so the roles swap every superstep.

export type FlyerStats = Record<keyof typeof FLYER_STATE, number>;

/** A flyer read back: its position and velocity in cells, the fields of the cell it carries, and its landing state. */
export interface FlyerSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  cell: Record<(typeof CELL_FIELDS)[number]['name'], number>;
  retries: number;
  status: number;
}

/** What the display and the coverage pass read: two words per cell, the kind word and the temperature's bits of the flyer in it, cleared and scattered every frame. */
export interface FlyerOverlay {
  layout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
}

type BufferType = 'uniform' | 'storage' | 'read-only-storage';

interface ComputePass {
  pipeline: GPUComputePipeline;
  // One bind group per parity: the flyer buffer holding the live flyers is the first or the second.
  groups: GPUBindGroup[];
}

export class Flyers {
  readonly maxFlyers: number;
  /** Group 3 of the CA: the launch counts it writes and, with air, the air state it reads and the burst buffer it adds to. */
  readonly launchLayout: GPUBindGroupLayout;
  readonly launchBindGroup: GPUBindGroup;
  readonly overlay: FlyerOverlay;

  private readonly device: GPUDevice;
  private readonly hasAir: boolean;
  private readonly fields: CellFields;
  private readonly elementTable: ElementTable;
  private readonly flightFields: ReturnType<CellFields['subset']>;
  private readonly launchGroupCount: { x: number; y: number };
  private readonly launch: GPUBuffer;
  private readonly buffers: [GPUBuffer, GPUBuffer];
  private readonly state: GPUBuffer;
  private readonly overlayBuffer: GPUBuffer;
  private readonly args: GPUBuffer;
  // Which of `buffers` holds the live flyers.
  private parity = 0;

  private readonly launchScan: ComputePass;
  private readonly launchScatter: ComputePass;
  private readonly flight: ComputePass;
  private readonly retry: ComputePass;
  private readonly lands: [ComputePass, ComputePass];
  private readonly compactScan: ComputePass;
  private readonly compactScatter: ComputePass;
  private readonly brush: ComputePass;
  private readonly overlayScatter: ComputePass;

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    fields: CellFields,
    elements: ElementTable,
    brushUniforms: GPUBuffer,
    // The edges word (`edgesWord`) in its first word: which sides of the world are open.
    edgesUniform: GPUBuffer,
    maxFlyers: number,
    air?: { state: GPUBuffer; burst: GPUBuffer; shape: AirShape },
  ) {
    if (!Number.isInteger(maxFlyers) || maxFlyers < 1 || maxFlyers > MAX_FLYER_SLOTS) {
      throw new RangeError(`maxFlyers must be an integer in 1..${MAX_FLYER_SLOTS}, got ${maxFlyers}`);
    }
    this.device = device;
    this.hasAir = air !== undefined;
    this.maxFlyers = maxFlyers;
    this.launchGroupCount = launchGroups(width, height);

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const groupCount = this.launchGroupCount.x * this.launchGroupCount.y;
    // One buffer, so the launch scatter stays within 8 storage buffers: words [0, G) the launch count of each of the G
    // workgroups, word G the superstep's total, words [G + 1, 2G + 1) the prefix of the counts.
    this.launch = device.createBuffer({ label: 'launch', size: (2 * groupCount + 1) * 4, usage: storage });
    const flyerBytes = maxFlyers * FLYER_WORDS * 4;
    this.buffers = [
      device.createBuffer({ label: 'flyers 0', size: flyerBytes, usage: storage }),
      device.createBuffer({ label: 'flyers 1', size: flyerBytes, usage: storage }),
    ];
    const claim = device.createBuffer({ label: 'flyer claims', size: width * height * 4, usage: storage });
    // The header counters, then one survivor count per workgroup of 64 flyers.
    const survivorGroups = Math.ceil(maxFlyers / 64);
    this.state = device.createBuffer({ label: 'flyer state', size: (FLYER_STATE_WORDS + survivorGroups) * 4, usage: storage });
    const survivorPrefix = device.createBuffer({ label: 'survivor prefix', size: survivorGroups * 4, usage: storage });
    this.args = device.createBuffer({ label: 'flyer args', size: ARGS_WORDS * 4, usage: storage | GPUBufferUsage.INDIRECT });
    this.overlayBuffer = device.createBuffer({ label: 'flyer overlay', size: width * height * OVERLAY_BYTES, usage: storage });
    device.queue.writeBuffer(claim, 0, new Uint32Array(width * height).fill(0xffffffff));

    const compute = GPUShaderStage.COMPUTE;
    const layoutOf = (types: BufferType[], visibility = compute): GPUBindGroupLayout => device.createBindGroupLayout({
      entries: types.map((type, binding) => ({ binding, visibility, buffer: { type } })),
    });

    // Binding 0 is the launch counts the CA writes; with air, binding 1 is the air state the CA and the flight pass read and
    // binding 2 the burst buffer the CA adds to.
    this.launchLayout = layoutOf(air ? ['storage', 'read-only-storage', 'storage'] : ['storage']);
    this.launchBindGroup = device.createBindGroup({
      layout: this.launchLayout,
      entries: [
        { binding: 0, resource: { buffer: this.launch } },
        ...(air ? [{ binding: 1, resource: { buffer: air.state } }, { binding: 2, resource: { buffer: air.burst } }] : []),
      ],
    });
    const overlayLayout = layoutOf(['read-only-storage'], GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE);
    this.overlay = {
      layout: overlayLayout,
      bindGroup: device.createBindGroup({ layout: overlayLayout, entries: [{ binding: 0, resource: { buffer: this.overlayBuffer } }] }),
    };

    const table = elements.elements;
    const [a, b] = this.buffers;
    // One compute pass: group 0 holds `types` buffers (`resources(live, other)` for the parity), then optionally the
    // cell fields (group 1) and the element table (group 2).
    const makePass = (
      code: string,
      types: BufferType[],
      resources: (live: GPUBuffer, other: GPUBuffer) => GPUBuffer[],
      extra: GPUBindGroupLayout[] = [],
    ): ComputePass => {
      const layout = layoutOf(types);
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout, ...extra] }),
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      });
      const group = (live: GPUBuffer, other: GPUBuffer): GPUBindGroup => device.createBindGroup({
        layout,
        entries: resources(live, other).map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      return { pipeline, groups: [group(a, b), group(b, a)] };
    };

    this.launchScan = makePass(
      launchScanWGSL(width, height, maxFlyers),
      ['storage', 'storage', 'storage'],
      () => [this.launch, this.state, this.args],
    );
    this.launchScatter = makePass(
      launchScatterWGSL(table, width, height, maxFlyers),
      ['storage', 'read-only-storage', 'read-only-storage'],
      (live) => [live, this.launch, this.state],
      [fields.writeLayout],
    );
    this.flightFields = fields.subset(FLIGHT_FIELDS);
    this.flight = makePass(
      flightWGSL(table, width, height, maxFlyers, air?.shape),
      ['storage', 'storage', 'storage', 'uniform'],
      (live) => [live, claim, this.state, edgesUniform],
      [this.flightFields.layout, elements.layout, ...(air ? [this.launchLayout] : [])],
    );
    this.retry = makePass(
      retryWGSL(table, width, height, maxFlyers),
      ['storage', 'storage', 'storage'],
      (live) => [live, claim, this.state],
      [this.flightFields.layout],
    );
    this.lands = [1, 2].map((round) => makePass(
      landWGSL(table, width, height, maxFlyers, round as 1 | 2),
      ['storage', 'storage', 'storage'],
      (live) => [live, claim, this.state],
      [fields.writeLayout],
    )) as [ComputePass, ComputePass];
    this.compactScan = makePass(
      compactScanWGSL(),
      ['storage', 'storage'],
      () => [survivorPrefix, this.state],
    );
    this.compactScatter = makePass(
      compactScatterWGSL(table, width, height, maxFlyers),
      ['read-only-storage', 'storage', 'read-only-storage', 'read-only-storage'],
      (live, other) => [live, other, survivorPrefix, this.state],
    );
    this.brush = makePass(
      flyerBrushWGSL(table, width, height, maxFlyers),
      ['uniform', 'storage', 'read-only-storage'],
      (live) => [brushUniforms, live, this.state],
    );
    this.overlayScatter = makePass(
      overlayWGSL(table, width, height, maxFlyers),
      ['read-only-storage', 'read-only-storage', 'storage'],
      (live) => [live, this.state, this.overlayBuffer],
    );
    this.fields = fields;
    this.elementTable = elements;
  }

  /** Drops every flyer. */
  clear(): void {
    this.device.queue.writeBuffer(this.state, 0, new Uint32Array(FLYER_STATE_WORDS));
  }

  /** Removes the flyers inside the stroke whose uniform the brush pass has just been given. */
  recordBrush(passes: PassRecorder): void {
    this.dispatchOver(passes.pass('flyer brush'), this.brush);
  }

  /** The passes that follow a superstep's offset-1 CA dispatch. */
  recordSuperstep(passes: PassRecorder): void {
    const p = this.parity;
    let pass = passes.pass('launch scan');
    pass.setPipeline(this.launchScan.pipeline);
    pass.setBindGroup(0, this.launchScan.groups[p]);
    pass.dispatchWorkgroups(1);

    pass = passes.pass('launch scatter');
    pass.setPipeline(this.launchScatter.pipeline);
    pass.setBindGroup(0, this.launchScatter.groups[p]);
    pass.setBindGroup(1, this.fields.writeBindGroup);
    pass.dispatchWorkgroups(this.launchGroupCount.x, this.launchGroupCount.y);

    pass = passes.pass('flight');
    pass.setPipeline(this.flight.pipeline);
    pass.setBindGroup(0, this.flight.groups[p]);
    pass.setBindGroup(1, this.flightFields.bindGroup);
    pass.setBindGroup(2, this.elementTable.bindGroup);
    if (this.hasAir) pass.setBindGroup(3, this.launchBindGroup);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);

    this.dispatchLand(passes.pass('land 1'), this.lands[0], p);
    pass = passes.pass('retry');
    pass.setPipeline(this.retry.pipeline);
    pass.setBindGroup(0, this.retry.groups[p]);
    pass.setBindGroup(1, this.flightFields.bindGroup);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
    this.dispatchLand(passes.pass('land 2'), this.lands[1], p);

    pass = passes.pass('compact scan');
    pass.setPipeline(this.compactScan.pipeline);
    pass.setBindGroup(0, this.compactScan.groups[p]);
    pass.dispatchWorkgroups(1);
    pass = passes.pass('compact scatter');
    pass.setPipeline(this.compactScatter.pipeline);
    pass.setBindGroup(0, this.compactScatter.groups[p]);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
    this.parity = 1 - p;
  }

  /** Clears the overlay and scatters the live flyers into it, as two passes of the caller's encoder. */
  recordOverlay(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.overlayBuffer);
    const pass = encoder.beginComputePass();
    this.dispatchOver(pass, this.overlayScatter);
    pass.end();
  }

  /** Copies the live flyer count (as of the last compaction) into `target` at `offset`. */
  copyLiveCount(encoder: GPUCommandEncoder, target: GPUBuffer, offset: number): void {
    encoder.copyBufferToBuffer(this.state, FLYER_STATE.live * 4, target, offset, 4);
  }

  private dispatchLand(pass: GPUComputePassEncoder, land: ComputePass, parity: number): void {
    pass.setPipeline(land.pipeline);
    pass.setBindGroup(0, land.groups[parity]);
    pass.setBindGroup(1, this.fields.writeBindGroup);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
  }

  private dispatchOver(pass: GPUComputePassEncoder, over: ComputePass): void {
    pass.setPipeline(over.pipeline);
    pass.setBindGroup(0, over.groups[this.parity]);
    pass.dispatchWorkgroupsIndirect(this.args, ARGS_DISPATCH * 4);
  }

  private async readWords(buffer: GPUBuffer, byteOffset: number, words: number): Promise<Uint32Array> {
    const staging = this.device.createBuffer({ size: words * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, byteOffset, staging, 0, words * 4);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return data;
  }

  /** The counters of the flyer list; for tests and the particle counter. */
  async readStats(): Promise<FlyerStats> {
    const words = await this.readWords(this.state, 0, FLYER_STATE_WORDS);
    return Object.fromEntries(Object.entries(FLYER_STATE).map(([name, i]) => [name, words[i]])) as FlyerStats;
  }

  /** The live flyers, in slot order. */
  async read(): Promise<FlyerSnapshot[]> {
    const { live } = await this.readStats();
    if (live === 0) return [];
    const words = await this.readWords(this.buffers[this.parity], 0, live * FLYER_WORDS);
    const floats = new Float32Array(words.buffer);
    const flyers: FlyerSnapshot[] = [];
    for (let i = 0; i < live; i++) {
      const at = i * FLYER_WORDS;
      flyers.push({
        x: floats[at + FLYER_OFFSET.pos],
        y: floats[at + FLYER_OFFSET.pos + 1],
        vx: floats[at + FLYER_OFFSET.vel],
        vy: floats[at + FLYER_OFFSET.vel + 1],
        cell: Object.fromEntries(CELL_FIELDS.map(({ name }, f) => [name, words[at + FLYER_OFFSET.cell + f]])) as FlyerSnapshot['cell'],
        retries: words[at + FLYER_OFFSET.retries],
        status: words[at + FLYER_OFFSET.status],
      });
    }
    return flyers;
  }

  /** Every word of the flyer state (counters and live flyers), for determinism checks. */
  async snapshot(): Promise<Uint32Array> {
    const header = await this.readWords(this.state, 0, FLYER_STATE_WORDS);
    const live = header[FLYER_STATE.live];
    const flyers = live > 0 ? await this.readWords(this.buffers[this.parity], 0, live * FLYER_WORDS) : new Uint32Array(0);
    const out = new Uint32Array(header.length + flyers.length);
    out.set(header);
    out.set(flyers, header.length);
    return out;
  }
}
