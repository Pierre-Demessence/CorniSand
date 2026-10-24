import { CELL_BYTES } from './shaders/cell.wgsl';

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
}
