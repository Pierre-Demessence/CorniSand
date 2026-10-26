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

  // The game requests the same limits (`src/gpu.ts`), so every pipeline the GPU tests create fits the default limit of
  // storage buffers per stage, which some adapters do not exceed.
  it('M5 AC2: runs at the default limit of 8 storage buffers per shader stage', () => {
    expect(device!.limits.maxStorageBuffersPerShaderStage).toBe(8);
  });
});
