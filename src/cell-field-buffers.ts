import { CELL_FIELDS, FIELD_BYTES, type CellData, type CellFieldName } from './cell-fields';

// The cell state: one storage buffer per field, updated in place (no ping-pong). A CA rule reads and writes only the
// cells of its own 2x2 block, so the threads of a dispatch never touch the same cell.
export class CellFields {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly buffers: Record<CellFieldName, GPUBuffer>;

  // Group 1 of every pass that touches cells; binding = field index. The read-only layout is for the counter and the
  // display (fragment stage), the read-write one for the CA and the brush.
  readonly readLayout: GPUBindGroupLayout;
  readonly writeLayout: GPUBindGroupLayout;
  readonly readBindGroup: GPUBindGroup;
  readonly writeBindGroup: GPUBindGroup;

  private readonly device: GPUDevice;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.cellCount = width * height;

    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buffers: Partial<Record<CellFieldName, GPUBuffer>> = {};
    for (const { name } of CELL_FIELDS) {
      buffers[name] = device.createBuffer({ label: `cell field ${name}`, size: this.cellCount * FIELD_BYTES, usage });
    }
    this.buffers = buffers as Record<CellFieldName, GPUBuffer>;

    const layout = (type: GPUBufferBindingType, visibility: number): GPUBindGroupLayout => device.createBindGroupLayout({
      entries: CELL_FIELDS.map((_, binding) => ({ binding, visibility, buffer: { type } })),
    });
    this.readLayout = layout('read-only-storage', GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT);
    this.writeLayout = layout('storage', GPUShaderStage.COMPUTE);

    const bindGroup = (groupLayout: GPUBindGroupLayout): GPUBindGroup => device.createBindGroup({
      layout: groupLayout,
      entries: CELL_FIELDS.map(({ name }, binding) => ({ binding, resource: { buffer: this.buffers[name] } })),
    });
    this.readBindGroup = bindGroup(this.readLayout);
    this.writeBindGroup = bindGroup(this.writeLayout);
  }

  // Replaces the world: a field missing from `data` is zero.
  load(data: Partial<CellData>): void {
    const encoder = this.device.createCommandEncoder();
    for (const { name } of CELL_FIELDS) {
      const words = data[name];
      if (!words) {
        encoder.clearBuffer(this.buffers[name]);
        continue;
      }
      if (words.length !== this.cellCount) {
        throw new RangeError(`field ${name}: expected ${this.cellCount} cells, got ${words.length}`);
      }
      this.device.queue.writeBuffer(this.buffers[name], 0, words);
    }
    this.device.queue.submit([encoder.finish()]);
  }

  clear(): void {
    const encoder = this.device.createCommandEncoder();
    for (const { name } of CELL_FIELDS) encoder.clearBuffer(this.buffers[name]);
    this.device.queue.submit([encoder.finish()]);
  }

  // One field's words, for tests.
  async read(name: CellFieldName): Promise<Uint32Array> {
    const size = this.cellCount * FIELD_BYTES;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.buffers[name], 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return words;
  }
}
