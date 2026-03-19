---
last-updated: 2026-07-08
applicable: ['src/**', 'index.html']
owner: agent
---

## Agent Operational Reference

### Purpose

GPU-accelerated falling sand simulation. Physics run in WGSL compute shaders using Margolus neighborhood CA on storage buffers.

### Key Commands

```bash
npm run dev      # Start Vite dev server
npm run build    # Production build → dist/
npm run preview  # Preview production build
```

### Important Paths

- `src/shaders/simulation.wgsl.ts` — Core physics rules (Margolus CA)
- `src/shaders/display.wgsl.ts` — Rendering / color mapping
- `src/simulation.ts` — Compute pipeline orchestration, per-step submit
- `src/cell-buffer.ts` — Storage buffer ping-pong (32 bytes/cell)
- `src/particles.ts` — Particle type constants + physics properties
- `src/display.ts` — Render pipeline, storage buffer binding

### Invariants

- Cell data is a 32-byte struct in storage buffers (not textures)
- `readCell()` returns `TYPE_WALL` for out-of-bounds → acts as boundary
- Each simulation step gets its own `GPUCommandEncoder` + `submit()` (avoids uniform buffer race condition)
- Pre-created bind groups for A→B and B→A ping-pong
- Margolus offset alternates 0/1 per step; superstep = offset 0 + offset 1
- Mouse input only applied on first step of each frame to avoid over-painting
- `prevMousePos`/`mousePos` tracked at frame level for gap-free line interpolation
- Particle type constants must stay in sync between `particles.ts` and WGSL shaders
