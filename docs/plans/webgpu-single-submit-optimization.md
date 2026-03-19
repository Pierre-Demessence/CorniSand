# WebGPU Single-Submit Optimization

## Problem

The current simulation uses **per-step submission**: each of the `2 × stepsPerFrame`
compute steps creates its own `GPUCommandEncoder` and calls `device.queue.submit()`.
At max speed (32×), this means **64 submits per frame** (~4,800/s at 75 FPS).

This works correctly and performance is acceptable, but each `submit()` incurs
JavaScript → driver marshalling overhead. Batching all dispatches into a single
encoder + submit would eliminate this overhead.

## Why a single encoder doesn't work today

All steps share one `GPUBuffer` for uniforms. When using a single encoder:

```
queue.writeBuffer(uniformBuf, 0, step0Data)  // mouseActive = 1.0
queue.writeBuffer(uniformBuf, 0, step1Data)  // mouseActive = 0.0
...
queue.writeBuffer(uniformBuf, 0, step7Data)  // mouseActive = 0.0
queue.submit([encoder])                      // all 8 dispatches see step7's data
```

`writeBuffer` operations execute in FIFO order on the GPU queue **before** the
submitted command buffer. Since all writes target the same buffer at offset 0,
only the last write is visible to every dispatch.

## Solution: dynamic uniform buffer offsets

### Concept

Pre-write each step's uniform data to a **different offset** in a single large
buffer, then use WebGPU **dynamic offsets** to point each dispatch at the right
slice.

### Implementation

**Step 1: Allocate a ring buffer**

```typescript
const ALIGNMENT = device.limits.minUniformBufferOffsetAlignment; // typically 256
const ALIGNED_SLOT = Math.ceil(UNIFORM_SIZE / ALIGNMENT) * ALIGNMENT;
const MAX_SLOTS = 64; // 32 stepsPerFrame × 2 offsets
const ringBuffer = device.createBuffer({
  size: ALIGNED_SLOT * MAX_SLOTS,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
```

Total memory: 256 × 64 = 16 KB (negligible).

**Step 2: Create bind group layout with dynamic offsets**

```typescript
const layout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
  ],
});
```

**Step 3: Pre-create two bind groups (A→B and B→A)**

Bind groups reference the full ring buffer at offset 0 with size `UNIFORM_SIZE`.
The actual offset is supplied at dispatch time.

```typescript
const bg = device.createBindGroup({
  layout,
  entries: [
    { binding: 0, resource: texAView },
    { binding: 1, resource: texBView },
    { binding: 2, resource: { buffer: ringBuffer, offset: 0, size: UNIFORM_SIZE } },
  ],
});
```

**Step 4: Write all uniforms upfront, record all dispatches in one encoder**

```typescript
simulate(stepsPerFrame: number, input: SimulationInput): GPUCommandBuffer {
  const encoder = device.createCommandEncoder();
  let slot = 0;

  for (let i = 0; i < stepsPerFrame; i++) {
    for (const offset of [0, 1]) {
      const applyInput = i === 0 && offset === 0 && input.mouseActive;
      fillUniforms(this.uniformData, offset, applyInput, input);

      const bufferOffset = slot * ALIGNED_SLOT;
      device.queue.writeBuffer(ringBuffer, bufferOffset, this.uniformData);

      const bg = this.current === this.texA ? this.bgAtoB : this.bgBtoA;
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bg, [bufferOffset]); // dynamic offset
      pass.dispatchWorkgroups(ceil(w/8), ceil(h/8));
      pass.end();

      this.swap();
      slot++;
    }
  }

  return encoder.finish();
}
```

Each `writeBuffer` targets a **unique offset** in the ring buffer, so no
overwrites occur. The single `submit()` in `main.ts` executes all dispatches
with their correct per-step uniforms.

**Step 5: Submit once in main.ts**

```typescript
const simCmd = simulation.simulate(stepsPerFrame, input);
// ... particle counting ...
const encoder = device.createCommandEncoder();
display.render(encoder, ...);
device.queue.submit([simCmd, encoder.finish()]);
```

### Compute pass ordering

WebGPU does **not** guarantee memory ordering between dispatches within the
same compute pass. Since each step reads from `inputTex` (what the previous
step wrote to `outputTex`), separate `beginComputePass()` / `end()` calls are
required for each step. This is already shown in the code above.

### Performance expectations

| Metric | Current (per-step submit) | Optimized (single submit) |
|---|---|---|
| Submits per frame (speed 1×) | 8 | 1–2 |
| Submits per frame (speed 8×) | 64 | 1–2 |
| JS→driver calls | O(stepsPerFrame) | O(1) |
| Uniform memory | 64 bytes | ~16 KB ring buffer |
| Bind groups | 2 static | 2 static (same) |

The optimization matters most at high speed settings where submit count is
highest. At normal speed it's unlikely to be measurable.

### When to implement

This is a **nice-to-have** optimization. Implement when:

- Profiling shows `submit()` overhead is a measurable fraction of frame time
- Scaling to larger grids where more steps per frame are needed
- Adding additional compute passes (pressure, temperature) that multiply the submit count
