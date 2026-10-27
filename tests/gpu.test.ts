import { describe, expect, it } from 'vitest';
import { ELEMENTS } from '../src/elements';
import { cellBindingsWGSL } from '../src/shaders/cell.wgsl';
import { flightWGSL, landWGSL, retryWGSL } from '../src/shaders/flyers.wgsl';
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

// Counts the storage buffers a shader declares in group 1 (the cell fields).
const fieldBindings = (wgsl: string): string[] => [...wgsl.matchAll(/@group\(1\) @binding\((\d+)\) var<storage, (\w+)> field_(\w+)/g)].map((m) => m[3]);

describe('field-subset bindings', () => {
  it('M6 AC1: the flight and retry passes bind only the kind field, the landings bind every field', () => {
    expect(fieldBindings(flightWGSL(ELEMENTS, 64, 64, 256))).toEqual(['kind']);
    expect(fieldBindings(retryWGSL(ELEMENTS, 64, 64, 256))).toEqual(['kind']);
    expect(fieldBindings(landWGSL(ELEMENTS, 64, 64, 256, 1)).length).toBeGreaterThan(1);
  });

  it('M6 AC1: a subset keeps the field index as the binding and leaves out the whole-cell accessors', () => {
    const wgsl = cellBindingsWGSL('read', ['kind']);
    expect(wgsl).toContain('@binding(0) var<storage, read> field_kind');
    expect(wgsl).toContain('fn loadKind');
    expect(wgsl).not.toContain('fn loadCell');
    expect(cellBindingsWGSL('read_write')).toContain('fn storeChanged');
  });
});
