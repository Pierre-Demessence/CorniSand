---
post_title: "Hybrid CA + Pressure Diffusion Fluid Simulation"
author1: "CorniSand"
post_slug: "hybrid-fluid-simulation"
post_date: 2026-03-19
completed: 2026-07-14
summary: "Replaced discrete CA water with pressure-biased Margolus CA + lightweight Jacobi pressure diffusion. Sand-into-water splash impulses propagate as visible waves."
---

# Hybrid CA + Pressure Diffusion Fluid Simulation

## Status: COMPLETE

## Goal

Add pressure, velocity, and wave propagation to water/oil while preserving the
discrete "falling sand" feel of the Margolus CA for all particle types.

## What was built

### Approach: CA + Pressure Overlay

The original plan called for a full MAC-grid Euler solver (semi-Lagrangian
advection → Jacobi pressure solve → velocity projection). That approach was
**tried and abandoned** because semi-Lagrangian advection backtraces into empty
cells in a sparse CA grid, zeroing velocity — water wouldn't move.

Instead, a simpler and effective design was implemented:

1. **Margolus CA** (`solid-ca.wgsl.ts`) handles ALL particles — solids and
   fluids alike. Liquid flow is biased by pressure: cells with higher pressure
   flow preferentially toward neighbors with lower pressure.
2. **Pressure diffusion** (`pressure.wgsl.ts`) runs 2 Jacobi iterations per
   step, spreading pressure and velocity among neighboring liquid cells.
3. **Splash impulse**: When sand falls into liquid, a pressure + velocity
   impulse is written, creating visible waves.

### Pipeline (per step)

| Pass | Shader | Purpose |
|---|---|---|
| CA offset 0 | `solid-ca.wgsl.ts` | Margolus 2×2 block rules (even offset) |
| CA offset 1 | `solid-ca.wgsl.ts` | Margolus 2×2 block rules (odd offset) |
| Pressure ×2 | `pressure.wgsl.ts` | Jacobi diffusion of pressure + velocity |

### Key parameters

- `DIFFUSION_RATE`: 0.25
- `PRESSURE_DECAY`: 0.92
- `VELOCITY_DIFFUSION`: 0.1
- `VELOCITY_DECAY`: 0.96
- `PRESSURE_FROM_FALL`: 2.0
- `SPLASH_IMPULSE`: 3.0
- `VELOCITY_DAMPEN`: 0.95

## Requirements (EARS) — Final

- WHEN a user draws water, THE SYSTEM SHALL simulate it using pressure-biased
  CA flow with visible wave propagation. ✅
- WHEN sand falls into water, THE SYSTEM SHALL create a velocity impulse
  (splash) that propagates as pressure waves. ✅
- WHEN water fills a container, THE SYSTEM SHALL settle to a mostly flat surface
  that sloshes when disturbed. ✅ (approximate — CA blockiness shows through)
- THE SYSTEM SHALL maintain ≥60 FPS at 898×586 resolution. ✅ (75 FPS measured)
- THE SYSTEM SHALL keep the Margolus CA for all particles with identical solid
  behavior to the previous implementation. ✅

## Tasks — Final

### Phase 1: Data format migration ✅

- [x] **1.1** Create `src/cell-buffer.ts` — storage buffer ping-pong manager
- [x] **1.2** Update `src/particles.ts` — per-type physics properties
- [x] **1.3** Rewrite `src/shaders/display.wgsl.ts` — read from storage buffer
- [x] **1.4** Update `src/display.ts` — storage buffer bind groups
- [x] **1.5** Rewrite `src/shaders/simulation.wgsl.ts` — Cell struct
- [x] **1.6** Update `src/simulation.ts` — CellBuffer integration

### Phase 2: Full Margolus CA ✅

- [x] **2.1** Create `src/shaders/solid-ca.wgsl.ts` — unified CA for all
  particles, with pressure-biased liquid flow and splash impulses
- [x] **2.2** Refactor `src/simulation.ts` to dispatch CA + pressure passes

### Phase 3: Pressure diffusion ✅

- [x] **3.1** Create `src/shaders/pressure.wgsl.ts` — lightweight Jacobi
  diffusion for pressure and velocity among liquid neighbors

### Phase 4: Euler solver (ABANDONED)

- [x] ~~**4.1** `advection.wgsl.ts` — semi-Lagrangian advection~~ (deleted)
- [x] ~~**4.2** `projection.wgsl.ts` — velocity projection~~ (deleted)
- [x] ~~**4.3** `fluid-transport.wgsl.ts` — cell-based transport~~ (deleted)

**Reason abandoned**: Semi-Lagrangian advection backtraces into empty cells,
zeroing velocity. The sparse, discrete nature of CA grids is fundamentally
incompatible with continuous Eulerian fluid dynamics.

## Decisions

| Decision | Rationale |
|---|---|
| CA + pressure overlay instead of Euler solver | Euler fails on sparse CA grids; CA + pressure is simple and effective |
| 2 Jacobi iterations (not 20) | Sufficient for visible wave propagation; 10× faster than planned |
| Unified CA for all particles | Simpler than separate solid/fluid dispatches; easier interaction rules |
| Per-step command encoder submission | Avoids `writeBuffer` race condition (all writes to same buffer coalesce) |
| GPU-side `clearBuffer` for reset | Avoids JS allocation of 16 MB typed arrays |

## Files

| File | Role |
|---|---|
| `src/cell-buffer.ts` | Storage buffer ping-pong manager |
| `src/simulation.ts` | Orchestrates CA + pressure passes |
| `src/shaders/solid-ca.wgsl.ts` | Margolus CA (all particles) |
| `src/shaders/pressure.wgsl.ts` | Jacobi pressure/velocity diffusion |
| `src/shaders/display.wgsl.ts` | Render from storage buffer |
| `src/display.ts` | WebGPU render pipeline |
| `src/particles.ts` | Particle type definitions + physics |
