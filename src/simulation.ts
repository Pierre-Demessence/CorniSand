import { AirGrid, defaultAirOptions } from './air-grid';
import { windVelocity, type AirCellSize } from './air';
import { cellWGSL } from './shaders/cell.wgsl';
import { BRUSH_UNIFORM_WORDS, brushWGSL } from './shaders/brush.wgsl';
import { caWGSL } from './shaders/ca.wgsl';
import { RULES } from './shaders/rules';
import { ElementTable } from './element-table';
import { ELEMENTS, MAX_ELEMENTS, elementTemperature, type ElementDef } from './elements';
import { CellFields } from './cell-field-buffers';
import { FIELD_BYTES, tempView, type CellData } from './cell-fields';
import { Flyers } from './flyers';
import type { Vec2 } from './input';
import { MOVEMENT } from './movement';
import { PassRecorder, type PassTimer } from './passes';

export interface SimulationInput {
  mousePos: Vec2;
  prevMousePos: Vec2;
  mouseActive: boolean;
  erasing: boolean;
  replacing: boolean;
  brushSize: number;
  particleType: number;
  /** °C added to every cell that holds heat inside the stroke per frame, negative to cool; absent or 0 when painting. */
  heating?: number;
  /** The Wind tool: the stroke blows the air under the brush along the pointer's movement and paints nothing; the right button still erases. */
  wind?: boolean;
}

/**
 * What `Simulation.readProbe` returns for the cell under the probe: its element ID and stored temperature (°C), and,
 * when the simulation has air, the pressure (0 ambient) and temperature (°C) of the air cell that holds the cell.
 */
export interface CellProbe {
  type: number;
  temp: number;
  pressure?: number;
  airTemp?: number;
}

export interface SimulationOptions {
  // One u32 per call; injectable so tests can replay a fixed sequence.
  seedSource?: () => number;
  // The element table the world runs on; the game's own by default. A test passes a table with extra rows.
  elements?: readonly ElementDef[];
  // WGSL of the element rules by name, added to the built-in ones.
  rules?: Readonly<Record<string, string>>;
  // The most flyers in the air at once (default `MOVEMENT.maxFlyers`); launches past it stay in the grid.
  maxFlyers?: number;
  // The air (pressure, wind, air temperature; default true). False records no air pass and allocates no air buffer.
  air?: boolean;
  // Grid cells per air cell along each axis (default 4).
  airCellSize?: AirCellSize;
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

  readonly fields: CellFields;
  readonly elements: ElementTable;
  readonly flyers: Flyers;
  readonly air: AirGrid;

  // -- Brush pipeline: edits the cell fields in place --
  private readonly brushUniformData = new ArrayBuffer(BRUSH_UNIFORM_WORDS * 4);
  private readonly brushFloats = new Float32Array(this.brushUniformData);
  private readonly brushWords = new Uint32Array(this.brushUniformData);
  private readonly brushUniformBuffer: GPUBuffer;
  private readonly brushPipeline: GPUComputePipeline;
  private readonly brushBindGroup: GPUBindGroup;

  // -- CA pipeline: one uniform slot per dispatch, picked with a dynamic offset --
  private readonly slotWords: number;
  private readonly slotData: Uint32Array<ArrayBuffer>;
  private readonly stepUniformBuffer: GPUBuffer;
  private readonly caPipeline: GPUComputePipeline;
  private readonly caBindGroup: GPUBindGroup;

  // Particle counting
  private readonly counterBuffer: GPUBuffer;
  private readonly counterStagingBuffer: GPUBuffer;
  private readonly countPipeline: GPUComputePipeline;
  private readonly countBindGroup: GPUBindGroup;
  private pendingCount = false;
  private mapping = false;
  private lastCount = 0;

  // Probe: the `kind` and `temp` words of one cell and the pressure and temperature words of its air cell, copied at
  // the end of the frame's encoder
  private readonly probeStaging: GPUBuffer;
  private probePending = false;

  constructor(device: GPUDevice, width: number, height: number, options: SimulationOptions = {}) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.seedSource = options.seedSource ?? defaultSeedSource;

    this.fields = new CellFields(device, width, height);
    this.elements = new ElementTable(device, options.elements ?? ELEMENTS);
    const table = this.elements.elements;

    // -- Brush setup --
    this.brushUniformBuffer = device.createBuffer({
      size: this.brushUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const brushLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    this.brushPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [brushLayout, this.fields.writeLayout, this.elements.layout] }),
      compute: { module: device.createShaderModule({ code: brushWGSL(width, height, table) }), entryPoint: 'main' },
    });
    this.brushBindGroup = device.createBindGroup({
      layout: brushLayout,
      entries: [{ binding: 0, resource: { buffer: this.brushUniformBuffer } }],
    });

    this.air = new AirGrid(
      device,
      width,
      height,
      { enabled: options.air ?? defaultAirOptions.enabled, cellSize: options.airCellSize ?? defaultAirOptions.cellSize },
      this.fields,
      this.elements,
    );

    this.flyers = new Flyers(device, width, height, this.fields, this.elements, this.brushUniformBuffer, options.maxFlyers ?? MOVEMENT.maxFlyers, this.air.state && this.air.burst && this.air.shape ? { state: this.air.state, burst: this.air.burst, shape: this.air.shape } : undefined);

    // -- CA setup --
    this.slotWords = device.limits.minUniformBufferOffsetAlignment / 4;
    this.slotData = new Uint32Array(MAX_DISPATCHES * this.slotWords);
    this.stepUniformBuffer = device.createBuffer({
      size: this.slotData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const caLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    });
    this.caPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [caLayout, this.fields.writeLayout, this.elements.layout, this.flyers.launchLayout] }),
      compute: {
        module: device.createShaderModule({ code: caWGSL(width, height, table, { ...RULES, ...options.rules }, this.flyers.maxFlyers, this.air.shape) }),
        entryPoint: 'main',
      },
    });
    this.caBindGroup = device.createBindGroup({
      layout: caLayout,
      // Step uniforms are { offset, seed }: two u32.
      entries: [{ binding: 0, resource: { buffer: this.stepUniformBuffer, size: 8 } }],
    });

    // -- Particle counter setup --
    // Word 0: the cells in the grid, counted by the shader; word 1: the flyers in the air.
    this.counterBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.counterStagingBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const countShader = device.createShaderModule({
      code: /* wgsl */`
        ${cellWGSL('read', table)}

        @group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;

        const W: u32 = ${width}u;
        const H: u32 = ${height}u;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3u) {
          if (gid.x >= W || gid.y >= H) { return; }
          let t = cellType(loadCell(gid.y * W + gid.x));
          if (t != EL_EMPTY && t != EL_WALL) {
            atomicAdd(&counter, 1u);
          }
        }
      `,
    });

    const countLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
    });
    this.countBindGroup = device.createBindGroup({
      layout: countLayout,
      entries: [{ binding: 0, resource: { buffer: this.counterBuffer } }],
    });

    this.countPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [countLayout, this.fields.readLayout] }),
      compute: { module: countShader, entryPoint: 'main' },
    });

    this.probeStaging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  // Replaces the world: each field of `data` (width x height words) goes into its buffer; a missing field is zero,
  // except `temp`, which then starts every cell at its element's temperature.
  load(data: Partial<CellData>): void {
    this.fields.load(data.temp ? data : { ...data, temp: this.startTemps(data.kind) });
    this.flyers.clear();
    this.air.clear();
  }

  // The `temp` words of cells of these kinds (all empty when absent), each at its element's temperature.
  private startTemps(kind = new Uint32Array(this.fields.cellCount)): Uint32Array<ArrayBuffer> {
    const byId = new Float32Array(MAX_ELEMENTS);
    for (const e of this.elements.elements) byId[e.id] = elementTemperature(e);
    const data = { temp: new Uint32Array(kind.length) };
    const temps = tempView(data);
    for (let i = 0; i < kind.length; i++) temps[i] = byId[kind[i] & 0xff];
    return data.temp;
  }

  clear(): void {
    this.fields.clear();
    this.flyers.clear();
    this.air.clear();
  }

  // Records the brush (while a button is down) and `supersteps` supersteps (two CA dispatches each) into the caller's
  // encoder; submitting it is the caller's job. `timer` is for the bench.
  simulate(encoder: GPUCommandEncoder, supersteps: number, input: SimulationInput, timer?: PassTimer): void {
    if (supersteps < 0 || supersteps > MAX_SUPERSTEPS) {
      throw new RangeError(`supersteps must be 0..${MAX_SUPERSTEPS}, got ${supersteps}`);
    }
    const dispatches = supersteps * 2;

    for (let i = 0; i < dispatches; i++) {
      this.slotData[i * this.slotWords] = i % 2;
      this.slotData[i * this.slotWords + 1] = this.seedSource();
    }
    this.device.queue.writeBuffer(this.stepUniformBuffer, 0, this.slotData, 0, dispatches * this.slotWords);

    const passes = new PassRecorder(encoder, timer);

    // A wind stroke paints nothing; the right button erases as with any tool.
    const blowing = input.mouseActive && input.wind === true && !input.erasing;
    if (input.mouseActive && !blowing) this.recordBrush(passes, input);
    if (dispatches > 0) this.air.recordMask(passes);
    if (blowing && dispatches > 0) {
      this.air.recordWind(passes, {
        prev: input.prevMousePos,
        cur: input.mousePos,
        radius: input.brushSize,
        velocity: windVelocity(input.prevMousePos, input.mousePos, dispatches),
      });
    }

    for (let i = 0; i < dispatches; i++) {
      const offset = i % 2;
      const pass = passes.pass(`ca${offset}`);
      pass.setPipeline(this.caPipeline);
      const blocksX = Math.ceil((this.width + offset) / 2);
      const blocksY = Math.ceil((this.height + offset) / 2);
      pass.setBindGroup(0, this.caBindGroup, [i * this.slotWords * 4]);
      pass.setBindGroup(1, this.fields.writeBindGroup);
      pass.setBindGroup(2, this.elements.bindGroup);
      pass.setBindGroup(3, this.flyers.launchBindGroup);
      pass.dispatchWorkgroups(Math.ceil(blocksX / 8), Math.ceil(blocksY / 8));
      // The offset-1 dispatch counted the cells that launch: they fly, and land, before the next superstep.
      if (offset === 1) {
        this.flyers.recordSuperstep(passes);
        this.air.recordSuperstep(passes);
      }
    }
    passes.end();
  }

  // Draws the flyers into the overlay the display reads; records into the caller's encoder after `simulate`.
  recordOverlay(encoder: GPUCommandEncoder): void {
    this.flyers.recordOverlay(encoder);
  }

  private recordBrush(passes: PassRecorder, input: SimulationInput): void {
    const f = this.brushFloats;
    const w = this.brushWords;
    f[0] = input.prevMousePos.x;
    f[1] = input.prevMousePos.y;
    f[2] = input.mousePos.x;
    f[3] = input.mousePos.y;
    f[4] = input.brushSize;
    w[5] = input.particleType;
    w[6] = input.erasing ? 1 : 0;
    const heating = input.heating ?? 0;
    // A heating stroke never replaces: the flyer brush would remove the flyers it passes over.
    w[7] = input.replacing && heating === 0 ? 1 : 0;
    w[8] = this.seedSource();
    f[9] = heating;
    this.device.queue.writeBuffer(this.brushUniformBuffer, 0, this.brushUniformData);

    const pass = passes.pass('brush');
    pass.setPipeline(this.brushPipeline);
    pass.setBindGroup(0, this.brushBindGroup);
    pass.setBindGroup(1, this.fields.writeBindGroup);
    pass.setBindGroup(2, this.elements.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    this.flyers.recordBrush(passes);
  }

  requestParticleCount(): void {
    if (this.pendingCount) return;

    this.device.queue.writeBuffer(this.counterBuffer, 0, new Uint32Array([0]));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countBindGroup);
    pass.setBindGroup(1, this.fields.readBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();

    this.flyers.copyLiveCount(encoder, this.counterBuffer, 4);
    encoder.copyBufferToBuffer(this.counterBuffer, 0, this.counterStagingBuffer, 0, 8);
    this.device.queue.submit([encoder.finish()]);
    this.pendingCount = true;
  }

  async readParticleCount(): Promise<number> {
    if (!this.pendingCount || this.mapping) return this.lastCount;

    this.mapping = true;
    try {
      await this.counterStagingBuffer.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(this.counterStagingBuffer.getMappedRange());
      this.lastCount = data[0] + data[1];
      this.counterStagingBuffer.unmap();
      this.pendingCount = false;
    } finally {
      this.mapping = false;
    }
    return this.lastCount;
  }

  // Appends copies of the `kind` and `temp` words of the grid cell at (x, y), and the pressure and temperature words of
  // its air cell, to the caller's encoder, so a probe needs no submit of its own. False when it recorded nothing: one probe is in flight until `readProbe` returns, or the
  // point is outside the grid. A flyer in the air over the cell is not seen.
  probe(encoder: GPUCommandEncoder, x: number, y: number): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (this.probePending || !(cx >= 0 && cx < this.width && cy >= 0 && cy < this.height)) return false;
    const offset = (cy * this.width + cx) * FIELD_BYTES;
    encoder.copyBufferToBuffer(this.fields.buffers.kind, offset, this.probeStaging, 0, FIELD_BYTES);
    encoder.copyBufferToBuffer(this.fields.buffers.temp, offset, this.probeStaging, FIELD_BYTES, FIELD_BYTES);
    if (this.air.state) {
      encoder.copyBufferToBuffer(this.air.state, this.air.probeOffset(cx, cy), this.probeStaging, 2 * FIELD_BYTES, 2 * FIELD_BYTES);
    }
    this.probePending = true;
    return true;
  }

  // The cell a successful `probe` copied; call it after the encoder holding the copies is submitted.
  async readProbe(): Promise<CellProbe | undefined> {
    if (!this.probePending) return undefined;
    try {
      await this.probeStaging.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(this.probeStaging.getMappedRange().slice(0));
      const probe: CellProbe = { type: words[0] & 0xff, temp: tempView({ temp: words.subarray(1, 2) })[0] };
      if (this.air.enabled) {
        const air = new Float32Array(words.buffer, 2 * FIELD_BYTES, 2);
        probe.pressure = air[0];
        probe.airTemp = air[1];
      }
      return probe;
    } finally {
      if (this.probeStaging.mapState === 'mapped') this.probeStaging.unmap();
      this.probePending = false;
    }
  }
}
