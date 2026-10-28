import { AIR_CELL_SIZES, DEFAULT_AIR_CELL_SIZE, airSubsteps, type AirCellSize, type AirShape } from './air';
import type { CellFields } from './cell-field-buffers';
import type { ElementTable } from './element-table';
import { ROOM_TEMP } from './heat';
import type { PassRecorder } from './passes';
import {
  WIND_UNIFORM_WORDS, airAdvectWGSL, airDiffuseWGSL, airExchangeWGSL, airMaskWGSL, airPressureWGSL, airVelocityWGSL, airWindWGSL,
} from './shaders/air.wgsl';

/**
 * The air, per air cell (`cellSize` x `cellSize` grid cells, `columns` x `rows` of them), as arrays of `columns * rows`
 * values, row by row from the bottom. The speeds are those of the air through the cell's right and top faces, in grid
 * cells per dispatch; the pressure is dimensionless, 0 ambient; the temperature is in °C.
 */
export interface AirData {
  pressure: Float32Array;
  velocityX: Float32Array;
  velocityY: Float32Array;
  temperature: Float32Array;
}

export interface AirOptions {
  // False: nothing is allocated and no pass is recorded.
  enabled: boolean;
  cellSize: AirCellSize;
}

export const defaultAirOptions: AirOptions = { enabled: true, cellSize: DEFAULT_AIR_CELL_SIZE };

const WORKGROUP = 8;

/** A stroke of the Wind tool for one frame: the segment the pointer moved along, the brush radius and the air speed it gives, in grid cells and cells per dispatch. */
export interface WindStroke {
  prev: { x: number; y: number };
  cur: { x: number; y: number };
  radius: number;
  velocity: { x: number; y: number };
}

interface AirPass {
  pipeline: GPUComputePipeline;
  label: string;
}

// The air grid: its buffers, the passes that step it and the readback for tests (`src/shaders/air.wgsl.ts` has the
// layout and the passes). The state is stepped in place, so it is in the same buffer at the end of every air step.
export class AirGrid {
  readonly enabled: boolean;
  readonly cellSize: AirCellSize;
  /** Air cells across and up. */
  readonly columns: number;
  readonly rows: number;
  /** Air steps per superstep. */
  readonly substeps: number;
  /** What a shader that reads the air needs to know of its shape; absent without air. */
  readonly shape?: AirShape;

  private readonly device: GPUDevice;
  // Array columns and rows: one more than the air cells, for the ghost column and row (see the shader).
  private readonly arrayWidth: number;
  private readonly arrayHeight: number;
  /** The air state, one vec4f per array position (speed through the right face, through the top face, pressure, temperature); what the CA and the flight pass bind read-only. Absent without air. */
  readonly state?: GPUBuffer;
  /** Pressure the CA released this superstep, per array position, in fixed point (`AIR.burstScale`); the pressure pass moves it into the pressure. What the CA binds read-write. Absent without air. */
  readonly burst?: GPUBuffer;
  private readonly bindGroup?: GPUBindGroup;
  private readonly kindBindGroup?: GPUBindGroup;
  private readonly elementBindGroup?: GPUBindGroup;
  private readonly maskPass?: AirPass;
  private readonly windPass?: AirPass;
  private readonly windBindGroup?: GPUBindGroup;
  private readonly windUniform?: GPUBuffer;
  private readonly windData = new Float32Array(WIND_UNIFORM_WORDS);
  private readonly exchangePass?: AirPass;
  private readonly exchangeBindGroup?: GPUBindGroup;
  private readonly exchangeUniform?: GPUBuffer;
  private readonly heatBindGroup?: GPUBindGroup;
  private readonly exchangeData = new Float32Array(1);
  private readonly stepPasses: AirPass[] = [];
  private readonly mask?: GPUBuffer;
  private readonly rest?: Float32Array<ArrayBuffer>;

  constructor(device: GPUDevice, width: number, height: number, options: AirOptions, fields: CellFields, elements: ElementTable) {
    this.device = device;
    this.enabled = options.enabled;
    this.cellSize = options.cellSize;
    if (!AIR_CELL_SIZES.includes(options.cellSize)) {
      throw new RangeError(`airCellSize must be one of ${AIR_CELL_SIZES.join(', ')}, got ${options.cellSize}`);
    }
    this.columns = Math.ceil(width / this.cellSize);
    this.rows = Math.ceil(height / this.cellSize);
    this.arrayWidth = this.columns + 1;
    this.arrayHeight = this.rows + 1;
    this.substeps = airSubsteps(this.cellSize);
    if (!this.enabled) return;
    this.shape = { cellSize: this.cellSize, columns: this.columns, rows: this.rows };

    const count = this.arrayWidth * this.arrayHeight;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.state = device.createBuffer({ label: 'air state', size: count * 16, usage: storage });
    const scratch = device.createBuffer({ label: 'air scratch', size: count * 16, usage: storage });
    this.mask = device.createBuffer({ label: 'air mask', size: count * 16, usage: storage });
    this.burst = device.createBuffer({ label: 'air burst', size: count * 4, usage: storage });

    // Every pass binds the same four buffers (a pass leaves out the ones it does not use in its shader).
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [this.state, scratch, this.mask, this.burst].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });

    const kind = fields.subset(['kind']);
    const heat = fields.subset(['kind', 'velocity', 'temp'], 'read_write');
    this.kindBindGroup = kind.bindGroup;
    this.elementBindGroup = elements.bindGroup;
    const pipeline = (code: string, layouts: GPUBindGroupLayout[]): GPUComputePipeline => device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const shape = [width, height, this.cellSize, this.substeps, this.columns, this.rows] as const;
    this.maskPass = {
      label: 'air mask',
      pipeline: pipeline(airMaskWGSL(elements.elements, ...shape), [layout, kind.layout, elements.layout]),
    };
    // The Wind tool's uniform: written once per frame that has a stroke, before the pass that reads it is recorded.
    const windLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    this.windUniform = device.createBuffer({ label: 'air wind', size: WIND_UNIFORM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.windBindGroup = device.createBindGroup({ layout: windLayout, entries: [{ binding: 0, resource: { buffer: this.windUniform } }] });
    this.windPass = { label: 'air wind', pipeline: pipeline(airWindWGSL(...shape), [layout, windLayout]) };
    // The heat exchange's uniform, the supersteps it folds in: written once per call that records it.
    const exchangeLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    this.exchangeUniform = device.createBuffer({ label: 'air exchange', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.exchangeBindGroup = device.createBindGroup({ layout: exchangeLayout, entries: [{ binding: 0, resource: { buffer: this.exchangeUniform } }] });
    this.heatBindGroup = heat.bindGroup;
    this.exchangePass = {
      label: 'air exchange',
      pipeline: pipeline(airExchangeWGSL(elements.elements, ...shape), [layout, heat.layout, elements.layout, exchangeLayout]),
    };
    this.stepPasses = [
      { label: 'air velocity', pipeline: pipeline(airVelocityWGSL(...shape), [layout]) },
      { label: 'air pressure', pipeline: pipeline(airPressureWGSL(...shape), [layout]) },
      { label: 'air advect', pipeline: pipeline(airAdvectWGSL(...shape), [layout]) },
      { label: 'air diffuse', pipeline: pipeline(airDiffuseWGSL(...shape), [layout]) },
    ];

    // Everything at rest: no pressure, no wind, room temperature.
    this.rest = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) this.rest[i * 4 + 3] = ROOM_TEMP;
    this.reset();
  }

  /** Records the mask pass: once per frame, after the brush, for the solid cells as they are then. */
  recordMask(passes: PassRecorder): void {
    if (!this.maskPass) return;
    const pass = passes.pass(this.maskPass.label);
    pass.setPipeline(this.maskPass.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.kindBindGroup);
    pass.setBindGroup(2, this.elementBindGroup);
    this.dispatch(pass);
  }

  /**
   * Records the heat exchange between the cells and the air: once per call, before the CA, for the `supersteps` the call
   * records. It stands for the exchange of each of them (see `airExchangeWGSL`). Writes its uniform first, so
   * call it at most once per frame.
   */
  recordExchange(passes: PassRecorder, supersteps: number): void {
    if (!this.exchangePass) return;
    this.exchangeData[0] = supersteps;
    this.device.queue.writeBuffer(this.exchangeUniform!, 0, this.exchangeData);
    const pass = passes.pass(this.exchangePass.label);
    pass.setPipeline(this.exchangePass.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.heatBindGroup);
    pass.setBindGroup(2, this.elementBindGroup);
    pass.setBindGroup(3, this.exchangeBindGroup);
    this.dispatch(pass);
  }

  /**
   * Records the Wind tool's pass: once per frame, after the mask pass (the closed faces) and before the CA. Writes the
   * stroke into the pass's uniform first, so call it at most once per frame. A stroke that gives the air no speed records
   * nothing.
   */
  recordWind(passes: PassRecorder, stroke: WindStroke): void {
    if (!this.windPass || (stroke.velocity.x === 0 && stroke.velocity.y === 0)) return;
    const w = this.windData;
    w[0] = stroke.prev.x;
    w[1] = stroke.prev.y;
    w[2] = stroke.cur.x;
    w[3] = stroke.cur.y;
    w[4] = stroke.velocity.x;
    w[5] = stroke.velocity.y;
    // A stroke thinner than an air cell would reach no face: the pass reaches at least one air cell around its line.
    w[6] = Math.max(stroke.radius, this.cellSize);
    this.device.queue.writeBuffer(this.windUniform!, 0, w);
    const pass = passes.pass(this.windPass.label);
    pass.setPipeline(this.windPass.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.windBindGroup);
    this.dispatch(pass);
  }

  /** Records the air steps of one superstep. */
  recordSuperstep(passes: PassRecorder): void {
    if (!this.enabled) return;
    for (let step = 0; step < this.substeps; step++) {
      for (const { pipeline, label } of this.stepPasses) {
        const pass = passes.pass(label);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.bindGroup);
        this.dispatch(pass);
      }
    }
  }

  private dispatch(pass: GPUComputePassEncoder): void {
    pass.dispatchWorkgroups(Math.ceil(this.arrayWidth / WORKGROUP), Math.ceil(this.arrayHeight / WORKGROUP));
  }

  // Everything at rest.
  private reset(): void {
    this.device.queue.writeBuffer(this.state!, 0, this.rest!);
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.burst!);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Sets the air to rest, then sets each array of `data` that is given (`columns * rows` values). A no-op without air. */
  load(data: Partial<AirData> = {}): void {
    if (!this.enabled) return;
    const words = this.rest!.slice();
    const check = (name: string, values: Float32Array | undefined): Float32Array | undefined => {
      if (values && values.length !== this.columns * this.rows) {
        throw new RangeError(`air ${name}: expected ${this.columns * this.rows} cells, got ${values.length}`);
      }
      return values;
    };
    const pressure = check('pressure', data.pressure);
    const velocityX = check('velocityX', data.velocityX);
    const velocityY = check('velocityY', data.velocityY);
    const temperature = check('temperature', data.temperature);
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.columns; i++) {
        const from = j * this.columns + i;
        const to = ((j + 1) * this.arrayWidth + i + 1) * 4;
        if (velocityX) words[to] = velocityX[from];
        if (velocityY) words[to + 1] = velocityY[from];
        if (pressure) words[to + 2] = pressure[from];
        if (temperature) words[to + 3] = temperature[from];
      }
    }
    this.device.queue.writeBuffer(this.state!, 0, words);
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.burst!);
    this.device.queue.submit([encoder.finish()]);
  }

  /** The byte offset in `state` of the pressure and temperature words (two f32 in a row) of the air cell that holds grid cell (cx, cy); the cell must be inside the grid. */
  probeOffset(cx: number, cy: number): number {
    const a = Math.floor(cx / this.cellSize) + 1;
    const b = Math.floor(cy / this.cellSize) + 1;
    return (b * this.arrayWidth + a) * 16 + 8;
  }

  /** Everything at rest. */
  clear(): void {
    if (this.enabled) this.reset();
  }

  /** The air of every air cell, for tests. */
  async read(): Promise<AirData> {
    return this.unpack(await this.readBuffer(this.state, 16));
  }

  /** The mask pass's result per air cell, for tests: openness of the right and top faces, share of powder and liquid, count of cells that hold heat. */
  async readMask(): Promise<{ openX: Float32Array; openY: Float32Array; matter: Float32Array; heat: Float32Array }> {
    const words = await this.readBuffer(this.mask, 16);
    const unpacked = this.unpack(words);
    return { openX: unpacked.velocityX, openY: unpacked.velocityY, matter: unpacked.pressure, heat: unpacked.temperature };
  }

  // The words of a buffer of `stride` bytes per array position.
  private async readBuffer(buffer: GPUBuffer | undefined, stride: number): Promise<Float32Array> {
    if (!buffer) throw new Error('the air is off (option air: false)');
    const size = this.arrayWidth * this.arrayHeight * stride;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return words;
  }

  // The air cells of an array of vec4f, without the ghost column and row.
  private unpack(words: Float32Array): AirData {
    const count = this.columns * this.rows;
    const data: AirData = {
      pressure: new Float32Array(count),
      velocityX: new Float32Array(count),
      velocityY: new Float32Array(count),
      temperature: new Float32Array(count),
    };
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.columns; i++) {
        const to = j * this.columns + i;
        const from = ((j + 1) * this.arrayWidth + i + 1) * 4;
        data.velocityX[to] = words[from];
        data.velocityY[to] = words[from + 1];
        data.pressure[to] = words[from + 2];
        data.temperature[to] = words[from + 3];
      }
    }
    return data;
  }
}
