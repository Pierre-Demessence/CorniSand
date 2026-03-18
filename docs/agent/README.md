---
last-updated: 2026-03-19
applicable: ['src/**', 'index.html']
owner: agent
---

## Agent Operational Reference

### Purpose

GPU-accelerated falling sand simulation. All physics run in GLSL fragment shaders using Margolus neighborhood CA.

### Key Commands

```bash
npm run dev      # Start Vite dev server
npm run build    # Production build → dist/
npm run preview  # Preview production build
```

### Important Paths

- `src/shaders/simulation.frag.js` - Core physics rules
- `src/shaders/display.frag.js` - Rendering / color mapping
- `src/simulation.js` - Render target management, step loop
- `src/particles.js` - Particle type registry

### Invariants

- Particle type encoded in R channel, variant in G channel (RGBA8 texture)
- `readCell()` returns `TYPE_WALL` for out-of-bounds → acts as boundary
- Margolus offset alternates 0/1 per step; superstep = offset 0 + offset 1
- Mouse input only applied on first step of each frame to avoid over-painting
- `prevMousePos`/`mousePos` tracked at frame level for gap-free line interpolation
