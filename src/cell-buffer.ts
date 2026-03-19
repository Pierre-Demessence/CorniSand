// 32 bytes per cell, aligned for GPU storage buffers
export const CELL_STRIDE = 8; // 8 × f32 = 32 bytes
export const CELL_BYTES = CELL_STRIDE * 4;

// Field offsets within a cell (in f32 units)
export const CELL_TYPE = 0;
export const CELL_VARIANT = 1;
export const CELL_LIFETIME = 2;
export const CELL_PRESSURE = 3;
export const CELL_VELOCITY_X = 4;
export const CELL_VELOCITY_Y = 5;

export class CellBuffer {
  private readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly bufferSize: number;

  private bufA: GPUBuffer;
  private bufB: GPUBuffer;
  private current: GPUBuffer;
  private next: GPUBuffer;

  constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.bufferSize = this.cellCount * CELL_BYTES;

    const usage =
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC;

    this.bufA = device.createBuffer({ size: this.bufferSize, usage });
    this.bufB = device.createBuffer({ size: this.bufferSize, usage });
    this.current = this.bufA;
    this.next = this.bufB;
  }

  get currentBuffer(): GPUBuffer {
    return this.current;
  }

  get nextBuffer(): GPUBuffer {
    return this.next;
  }

  get bufferA(): GPUBuffer {
    return this.bufA;
  }

  get bufferB(): GPUBuffer {
    return this.bufB;
  }

  swap(): void {
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
  }

  clear(): void {
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.bufA);
    encoder.clearBuffer(this.bufB);
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.bufA.destroy();
    this.bufB.destroy();
  }
}
