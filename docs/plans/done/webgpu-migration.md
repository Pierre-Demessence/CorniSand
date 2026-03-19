# WebGPU Migration

## Goal

Replace the WebGL2 + Three.js rendering backend with native WebGPU compute shaders, unlocking float-precision physics (pressure, temperature, velocity) and removing the 8-bit RGBA encoding bottleneck.

## Requirements (EARS)

### Core migration

- THE SYSTEM SHALL render the sand simulation using WebGPU compute shaders instead of WebGL fragment shaders.
- THE SYSTEM SHALL maintain all existing particle types (Empty, Sand, Wall, Water, Smoke, Oil, Fire) with identical behavior.
- THE SYSTEM SHALL use the Margolus neighborhood cellular automaton for simulation.
- THE SYSTEM SHALL use ping-pong storage textures for the cellular automaton state.
- THE SYSTEM SHALL display the simulation result via a WebGPU render pipeline (vertex + fragment).

### Enhanced physics (post-migration)

- WHEN the migration is complete, THE SYSTEM SHALL store per-cell data in 32-bit channels (type, variant, lifetime, pressure, temperature, velocity).
- WHEN pressure simulation is enabled, THE SYSTEM SHALL diffuse pressure across neighbors via iterative Jacobi relaxation in a compute pass.
- WHEN temperature simulation is enabled, THE SYSTEM SHALL diffuse heat and drive phase transitions (e.g., water → steam, ice → water).
- WHEN velocity fields are enabled, THE SYSTEM SHALL advect particles using per-cell (vx, vy) vectors.

### Compatibility

- IF the browser does not support WebGPU, THEN THE SYSTEM SHALL display a clear error message (no WebGL fallback initially).
- THE SYSTEM SHALL work in Chrome 113+, Edge 113+, and Safari 18.2+.

## Analysis

### Current architecture (WebGL2 + Three.js)

| Component | Current | WebGPU equivalent |
|---|---|---|
| Renderer | `THREE.WebGLRenderer` | `GPUDevice` + `GPUCanvasContext` |
| Render targets | `THREE.WebGLRenderTarget` (RGBA8) | `GPUTexture` with `rgba8unorm` → later `rgba32float` |
| Simulation shaders | GLSL ES 1.0 fragment shaders (via Three.js on WebGL2) | WGSL compute shaders |
| Display shader | GLSL ES 1.0 fragment shader | WGSL vertex + fragment render pipeline |
| Vertex shader | Fullscreen quad (Three.js geometry) | Fullscreen triangle (3 vertices, no buffer) |
| Uniforms | `THREE.ShaderMaterial.uniforms` | `GPUBuffer` with uniform bind group |
| Ping-pong | Swap `WebGLRenderTarget` references | Swap `GPUTexture` references or bind group entries |
| Particle counting | `readRenderTargetPixels` → CPU loop | Compute shader with atomic counter → `mapAsync` readback |

### Cell encoding evolution

**Phase 1 (parity)** — RGBA8, identical to current:

| Channel | Bits | Content |
|---|---|---|
| R | 8 | Particle type (0–6) |
| G | 8 | Color variant (0–255) |
| B | 8 | Fire lifetime (0–200) |
| A | 8 | Reserved (1.0) |

**Phase 2 (enhanced)** — RGBA32Float or structured buffer:

| Channel / Field | Bits | Content |
|---|---|---|
| type | 32 | Particle type (0–255+, room for hundreds) |
| variant | 32 | Color variant |
| lifetime | 32 | Continuous float lifetime |
| pressure | 32 | Local pressure (Pa) |
| temperature | 32 | Local temperature (K) |
| velocity.x | 32 | Horizontal velocity |
| velocity.y | 32 | Vertical velocity |
| flags | 32 | Bitfield (on fire, wet, frozen, etc.) |

Phase 2 uses a `storage buffer` (struct array) instead of textures, allowing arbitrary per-cell data.

> **Phase 2 display note**: Switching to a storage buffer means the display shader can no longer use `textureSample()` with hardware filtering. Options: (a) copy relevant fields to a display texture each frame, or (b) read the storage buffer directly in the fragment shader with manual index calculation. Option (a) is simpler and preserves the render pipeline. Also note `rgba32float` storage texture format has broad but not universal GPU performance — benchmark on target hardware.

### Shader porting: GLSL → WGSL

Key syntax changes:

| GLSL | WGSL |
|---|---|
| `vec2`, `vec4` | `vec2f`, `vec4f` |
| `float x = 0.0;` | `var x: f32 = 0.0;` |
| `texture2D(sampler, uv)` | `textureLoad(tex, coords, 0)` |
| `gl_FragCoord` | `@builtin(global_invocation_id)` |
| `uniform float u_x;` | `struct Uniforms { x: f32 }; @group(0) @binding(0) var<uniform> u: Uniforms;` |
| `#define TYPE_SAND 1.0` | `const TYPE_SAND: f32 = 1.0;` (or `u32`) |
| `void main()` | `@compute @workgroup_size(8, 8) fn main(...)` |
| Out-of-bounds texture read returns 0 | Must check bounds explicitly |
| `gl_FragColor = result;` | `textureStore(outputTex, pos, result);` |
| `texture2D(s, (pos + 0.5) / res)` (normalized UV) | `textureLoad(tex, vec2i(pos), 0)` (integer coords, no normalization — removes off-by-half-pixel bugs) |

The simulation logic (gravity, density, reactions, Margolus blocks) is **identical** — only the API surface changes.

### Three.js removal

Three.js is used exclusively as a WebGL convenience layer:

- `WebGLRenderer` → replaced by `GPUDevice`
- `WebGLRenderTarget` → replaced by `GPUTexture`
- `ShaderMaterial` → replaced by `GPUComputePipeline` / `GPURenderPipeline`
- `OrthographicCamera` + `PlaneGeometry` → replaced by fullscreen triangle
- `Mesh`, `Scene` → not needed

Three.js and `physics.ts` can be fully removed.

## Design

### New file structure

```
src/
  main.ts              — Entry point (unchanged interface)
  input.ts             — Input handling (unchanged)
  particles.ts         — Particle type constants (unchanged)
  gpu.ts               — NEW: WebGPU device init, texture/buffer helpers
  simulation.ts        — Rewritten: uses GPUDevice instead of Three.js
  display.ts           — Rewritten: WebGPU render pipeline
  shaders/
    simulation.wgsl.ts — Margolus compute shader (includes common helpers)
    display.wgsl.ts    — Display vertex + fragment shader
```

### GPU initialization (`gpu.ts`)

```typescript
export async function initGPU(canvas: HTMLCanvasElement): Promise<{
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}>;
```

- Request adapter with `powerPreference: 'high-performance'`
- Request device with no special features (basic compute is sufficient)
- Configure canvas context with `navigator.gpu.getPreferredCanvasFormat()`
- Register `device.lost` handler: display user-friendly error and optionally attempt re-initialization
- Log shader compilation errors via `device.pushErrorScope('validation')` / `popErrorScope()`

### Simulation class (rewritten)

```typescript
export class Simulation {
  private device: GPUDevice;
  private texA: GPUTexture;       // Ping
  private texB: GPUTexture;       // Pong
  private current: GPUTexture;
  private next: GPUTexture;
  private uniformBuffer: GPUBuffer;
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;

  constructor(device: GPUDevice, width: number, height: number);
  simulate(stepsPerFrame: number, input: SimulationInput): void;
  clear(): void;
  get currentTexture(): GPUTexture;
}
```

Texture usage flags:

- Ping-pong textures: `GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST` (COPY_DST for `clear()`)
- Add `COPY_SRC` during development for debug readback

Each `step()` call:

1. Write uniforms to `uniformBuffer` via `device.queue.writeBuffer()`
2. Create bind group: `{ input: current (texture), output: next (storage_texture), uniforms }`
3. Dispatch compute: `ceil(width/8) × ceil(height/8)` workgroups
4. Swap `current` ↔ `next`

### Display class (rewritten)

```typescript
export class Display {
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;

  constructor(device: GPUDevice, format: GPUTextureFormat, width: number, height: number);
  render(encoder: GPUCommandEncoder, targetView: GPUTextureView, simTexture: GPUTexture, options: DisplayOptions): void;
}
```

Uses a fullscreen triangle (3 hardcoded vertices, no vertex buffer). Fragment shader reads the simulation texture via `textureSample()` and maps types to colors (same logic as current `display.frag.ts`).

### Uniform buffer layout

```wgsl
struct Uniforms {
  resolution: vec2f,
  offset: f32,
  seed: f32,
  mousePos: vec2f,
  prevMousePos: vec2f,
  brushSize: f32,
  particleType: f32,
  mouseActive: f32,
  erasing: f32,
  replacing: f32,
  _padding: vec3f,  // Align to 16 bytes
};
```

### Compute shader structure (Margolus)

```wgsl
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> u: Uniforms;

// ... shared functions (type checks, encoding, mouse input) ...

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pos = vec2i(gid.xy);
  if (pos.x >= i32(u.resolution.x) || pos.y >= i32(u.resolution.y)) { return; }

  // Same Margolus 2×2 block logic as current GLSL
  // Read 4 cells, apply 6 phases, write result
  let result = simulateCell(pos);
  textureStore(outputTex, pos, result);
}
```

### Particle counting (improved)

Instead of `readRenderTargetPixels` + CPU loop:

- Add an atomic `storage buffer` (single `u32`)
- Each compute invocation: if cell is non-empty, `atomicAdd(&counter, 1u)`
- Read back via `mapAsync` — no full-texture download needed
- Can run as part of the simulation pass or a separate lightweight compute dispatch

### Frame loop

```
1. input.ts collects events (unchanged)
2. simulation.simulate()
   - For each Margolus step (offset 0, then offset 1, repeated stepsPerFrame times):
     - writeBuffer(uniforms)
     - beginComputePass → dispatch → end
     - swap textures
3. display.render()
   - beginRenderPass(canvas texture view)
   - draw fullscreen triangle with sim texture
   - end
4. device.queue.submit([commandBuffer])
```

**Important: per-step submission pattern**: Each simulation step creates its own
`GPUCommandEncoder` and calls `device.queue.submit()` immediately. This is required
because multiple `queue.writeBuffer()` calls to the same uniform buffer at offset 0
all execute before a batched `submit()` — only the last write would survive, losing
per-step uniform values (e.g., `mouseActive` for the input step).

The display pass uses a separate encoder created in `main.ts` and submitted once.

**Future optimization**: Replace per-step submission with a **dynamic uniform buffer**
pattern — pre-write all step uniforms to aligned offsets in a single large buffer,
then dispatch all steps in one encoder using `setBindGroup(group, bg, [dynamicOffset])`.
This reduces to two submits per frame (simulation + display) while preserving correct
per-dispatch uniforms. See [single-submit optimization](../webgpu-single-submit-optimization.md) for details.

### Device lost handling

`gpu.ts` registers a `device.lost` handler on init. When triggered:

1. Cancel the animation frame loop.
2. Display a user-visible error overlay: "GPU connection lost. Reload the page to restart."
3. Optionally attempt re-initialization (call `initGPU()` again).

### Canvas resize strategy

Simulation resolution is **fixed at init time** (current behavior). On window resize:

1. Update the canvas CSS/physical size.
2. Reconfigure the `GPUCanvasContext` (updates swap chain).
3. The display shader already handles resolution mismatch via UV scaling.
4. Simulation textures are NOT recreated — the sim grid stays the same size.

`devicePixelRatio` is intentionally ignored (pixel-art CA simulation). The canvas is rendered at 1:1 pixel ratio.

### Particle counting (async)

`countParticles()` becomes async. Strategy: **fire-and-forget with stale display**.

1. Dispatch a lightweight compute shader that atomically counts non-empty cells into a `storage buffer`.
2. Copy the counter to a staging `MAP_READ` buffer.
3. Call `mapAsync()` — when resolved, update the displayed count.
4. Between async completions, the UI shows the previous count (stale but acceptable for a 2-second refresh interval).
5. Never blocks the animation frame.

## Tasks

### Phase 1: WebGPU parity (same features, same encoding)

Work on a `feat/webgpu` branch. Merge only after task 1.14 passes.

- [x] **1.1** Create `gpu.ts` — WebGPU device/context initialization, `device.lost` handler, error scope utilities
- [x] **1.2** Port `simulation.frag.ts` → `simulation.wgsl.ts` — Margolus compute shader (includes common helpers inline)
- [x] **1.3** Port `display.frag.ts` → `display.wgsl.ts` — display render pipeline (vertex + fragment)
- [x] **1.4** Rewrite `simulation.ts` — use `GPUDevice`, compute pipeline, storage textures, uniform buffer
- [x] **1.5** Rewrite `display.ts` — use `GPURenderPipeline`, fullscreen triangle, texture sampling
- [x] **1.6** Update `main.ts` — async init, `GPUCommandEncoder` per frame, canvas resize handling, async particle counting (fire-and-forget with stale display)
- [x] **1.7** Remove Three.js dependency, `physics.ts`, old GLSL shaders from `package.json` and `src/`
- [x] **1.8** Visual regression test — all 6 particle types verified (Sand gravity, Water pooling, Oil+Fire reaction, Smoke rising, Wall containment)
- [x] **1.9** Performance benchmark — 75 FPS at 898×586 (0.5M cells), 28 KB bundle, zero runtime dependencies
- [x] **1.10** Update project documentation (tech-stack.md, codebase.md, features.md)

### Phase 2: Enhanced cell encoding

- [ ] **2.1** Expand cell encoding to structured storage buffer (8× f32 per cell) or rgba32float textures
- [ ] **2.2** Update all shaders to use new encoding
- [ ] **2.3** Update display shader color mapping for new encoding

### Phase 3: Pressure simulation

- [ ] **3.1** Add pressure field (f32 per cell)
- [ ] **3.2** Implement Jacobi pressure solver as separate compute pass
- [ ] **3.3** Integrate pressure into particle movement (heavier particles sink under pressure, gas compresses)
- [ ] **3.4** Visualize pressure (optional debug overlay)

### Phase 4: Temperature & phase transitions

- [ ] **4.1** Add temperature field (f32 per cell)
- [ ] **4.2** Implement heat diffusion compute pass
- [ ] **4.3** Add phase transitions: water ↔ steam, water ↔ ice
- [ ] **4.4** Temperature-driven fire: fire heats neighbors, hot oil auto-ignites
- [ ] **4.5** Display: color tint based on temperature

### Phase 5: Velocity fields & advanced physics

- [ ] **5.1** Add per-cell velocity (vx, vy)
- [ ] **5.2** Implement advection (particles move along velocity field)
- [ ] **5.3** Wind: global or local velocity sources
- [ ] **5.4** Momentum transfer on collision
- [ ] **5.5** Expand particle types (metal, lava, acid, steam, etc.)

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Browser support gaps (Firefox behind flag, older Safari, Android varies) | Users on unsupported browsers can't use the app | Show clear error message with browser upgrade suggestion; no WebGL fallback |
| WGSL shader debugging is harder than GLSL | Slower development | Use `device.pushErrorScope`/`popErrorScope`, Chrome DevTools GPU panel, Dawn error messages, `--enable-dawn-features=disable_workgroup_init` flag |
| `storage_texture` write-only limitation | Can't read and write same texture in one dispatch | Keep ping-pong pattern (read texture A, write texture B) |
| Uniform buffer alignment (16-byte) | Subtle bugs from misaligned data | WGSL enforces alignment rules; ensure struct trailing padding rounds size to `structAlignment` multiple; test with validation layer enabled |
| Performance regression in Phase 1 | WebGPU overhead for simple CA might be higher | Benchmark early; compute dispatch overhead is lower than fragment shader for large grids |
| Phase 2+ scope creep | Enhanced physics is open-ended | Each phase is independently useful; stop at any phase |

## Decision record

**Decision**: Use compute shaders (not fragment shaders) for simulation in WebGPU.
**Rationale**: Compute shaders support `storage_texture` write, workgroup shared memory, and atomics — all required for Phase 2+ features. Fragment shaders in WebGPU would offer no advantage over the current WebGL approach.
**Impact**: Slightly more setup code, but unlocks all future physics features.

**Decision**: Remove Three.js entirely rather than using `THREE.WebGPURenderer`.
**Rationale**: Three.js's WebGPU support is experimental and abstracts away the compute shader API we need. Direct WebGPU usage gives full control with less code than fighting Three.js abstractions.
**Impact**: More boilerplate for init/display, but cleaner simulation code.

**Decision**: Keep RGBA8 encoding in Phase 1, expand in Phase 2.
**Rationale**: Ensures visual parity testing is straightforward. Changing encoding and shader logic simultaneously would make bugs harder to isolate.
**Impact**: Phase 1 won't have enhanced physics yet, but proves the port works.

**Decision**: Use `texture_2d` + `texture_storage_2d` ping-pong (not storage buffers) in Phase 1.
**Rationale**: Closest to current architecture, simplest port. Phase 2 can switch to storage buffers when richer per-cell data is needed.
**Impact**: Phase 1 is a more direct translation of existing code.
