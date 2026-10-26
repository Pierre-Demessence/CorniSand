import { describe, expect, it } from 'vitest';
import { commonWGSL } from '../src/shaders/cell.wgsl';
import { device, readBuffer } from './gpu';

const W = 1280;
const H = 696;

async function blockHashes(seed: number): Promise<Uint32Array> {
  const dev = device!;
  const module = dev.createShaderModule({
    code: /* wgsl */`
      ${commonWGSL}
      @group(0) @binding(0) var<storage, read_write> out: array<u32>;
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) g: vec3u) {
        if (g.x >= ${W}u || g.y >= ${H}u) { return; }
        out[g.y * ${W}u + g.x] = hash2(g.x, g.y, ${seed}u);
      }
    `,
  });
  const pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const size = W * H * 4;
  const buffer = dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bindGroup = dev.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });
  const encoder = dev.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
  pass.end();
  dev.queue.submit([encoder.finish()]);
  const result = await readBuffer(dev, buffer, size);
  buffer.destroy();
  return result;
}

describe.skipIf(!device)('B4: block hash', () => {
  it.each([0, 1, 12345, 0xdeadbeef, 0xffffffff])('is well distributed over 1280x696 blocks for seed %i', async (seed) => {
    const values = await blockHashes(seed);
    const distinct = new Set(values).size / values.length;
    let above = 0;
    for (const v of values) if (v / 2 ** 32 > 0.5) above++;

    expect(distinct).toBeGreaterThanOrEqual(0.999);
    expect(Math.abs(above / values.length - 0.5)).toBeLessThanOrEqual(0.003);
  });
});
