import { describe, expect, it } from 'vitest';
import { device, readBuffer } from './gpu';

describe.skipIf(!device)('GPU test harness', () => {
  it('round-trips a buffer through the device', async () => {
    const dev = device!;
    const data = new Uint32Array([1, 2, 3, 0xdeadbeef]);
    const buffer = dev.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    dev.queue.writeBuffer(buffer, 0, data);
    expect(Array.from(await readBuffer(dev, buffer, data.byteLength))).toEqual(Array.from(data));
    buffer.destroy();
  });
});
