import {
  FLUID,
  type LevelGeometry,
  MAX_PARTICLES,
  multigridCells,
  multigridLevels,
  multigridTailStart,
  spawnParticles,
} from './fluid-params';
import type { CellBuffer } from './cell-buffer';
import type { SimulationInput } from './simulation';
import { BRUSH_UNIFORM_WORDS, brushWGSL } from './shaders/brush.wgsl';
import { GRID_WORKGROUP, PARTICLE_BYTES, PARTICLE_WORKGROUP, STATE_WORDS } from './shaders/fluid-common.wgsl';
import { fluidGridWGSL, GRID_BINDINGS } from './shaders/fluid-grid.wgsl';
import { fluidMultigridWGSL, MG_BINDINGS, SCALAR_WORDS } from './shaders/fluid-multigrid.wgsl';
import { fluidParticlesWGSL, PARTICLE_BINDINGS } from './shaders/fluid-particles.wgsl';
import { fluidRasterWGSL, RASTER_BINDINGS, SELECT_WORDS } from './shaders/fluid-raster.wgsl';
import { mulberry32 } from './random';

export type FluidSolver = 'multigrid' | 'sor';

export interface FluidOptions {
  // Overrides the capacity computed from the grid and the device limits, for tests.
  particleCapacity?: number;
  // Overrides `FLUID.solver`: the pressure solve is multigrid-preconditioned conjugate gradients or red-black sweeps.
  solver?: FluidSolver;
  // Red-black sweep pairs per projection of the 'sor' solver; overrides `FLUID.iterations`, for tests and the bench.
  iterations?: number;
}

/** The face-velocity, pressure and classification buffers of the last step, for tests to read and seed. */
export interface FluidGridBuffers {
  /** f32 per vertical face, (width + 1) x height: `u[y * (width + 1) + x]` is the face left of cell (x, y). */
  readonly u: GPUBuffer;
  /** f32 per horizontal face, width x (height + 1): `v[y * width + x]` is the face below cell (x, y). */
  readonly v: GPUBuffer;
  /** `u` and `v` as they were before gravity, for the FLIP difference. */
  readonly uPrev: GPUBuffer;
  readonly vPrev: GPUBuffer;
  /** u32 per cell: 0 air, 1 liquid, 2 solid. */
  readonly flags: GPUBuffer;
  /** f32 per cell: mean density of the liquid, 0 outside liquid. */
  readonly density: GPUBuffer;
  /** f32 pressure per cell; the warm start of the next solve. */
  readonly p: GPUBuffer;
  /**
   * vec4f face weights (left, right, bottom, top) of every multigrid level, from each level's offset: level 0 holds
   * the liquid cells' weights of the pressure problem (a liquid-air weight is the surface weight), a coarser level
   * the summed liquid-liquid couplings.
   */
  readonly weights: GPUBuffer;
  /** vec2f per cell and level: the diagonal (0 where there is no liquid), and a working vector of the solve. */
  readonly diagDiv: GPUBuffer;
  /** The multigrid levels in the buffers above; a single level for the 'sor' solver. */
  readonly levels: readonly LevelGeometry[];
  /** One u32: the bits of the largest residual written by `recordResidual`. */
  readonly residual: GPUBuffer;
}

/** The buffers of the rasterization, for tests to read and fill. */
export interface FluidRasterBuffers {
  /** u32 per cell: particles of any kind in it after the move. */
  readonly counts: GPUBuffer;
  /** u32 per cell: oil particles in it. */
  readonly oilCounts: GPUBuffer;
  /** u32 per cell: the rasterization key, 0 for a cell that cannot take liquid. */
  readonly keys: GPUBuffer;
  /** u32 per cell: the oil key of a chosen cell, 0 elsewhere. */
  readonly oilKeys: GPUBuffer;
  /** u32 bins of the radix select; all zero between selections. */
  readonly histogram: GPUBuffer;
  /** u32 words in the order of `SELECT_FIELDS`. */
  readonly select: GPUBuffer;
}

/** `grid` runs passes 1-13 of a step (the grid solve), `full` all of them: the particles move and are rasterized. */
export type FluidStage = 'grid' | 'full';

// Functions, not constants: tests install the WebGPU globals only after this module is imported.
const bufferUsage = (): number => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const argsUsage = (): number => GPUBufferUsage.INDIRECT | bufferUsage();

/** Particle slots the device can hold in one storage binding, up to four per grid cell. */
export function particleCapacityFor(device: GPUDevice, width: number, height: number): number {
  const { maxStorageBufferBindingSize, maxBufferSize } = device.limits;
  const byDevice = Math.floor(Math.min(maxStorageBufferBindingSize, maxBufferSize) / PARTICLE_BYTES);
  return Math.max(1, Math.min(4 * width * height, MAX_PARTICLES, byDevice));
}

/**
 * Halves the capacity until both particle buffers can be allocated. Allocation failure surfaces only as an
 * asynchronous `out-of-memory` error, so this probes with throwaway buffers before the synchronous constructors run.
 */
export async function fitParticleCapacity(device: GPUDevice, capacity: number): Promise<number> {
  for (let fit = capacity; fit > 1; fit = Math.floor(fit / 2)) {
    device.pushErrorScope('out-of-memory');
    const probes = [0, 1].map(() => device.createBuffer({ size: fit * PARTICLE_BYTES, usage: bufferUsage() }));
    const error = await device.popErrorScope();
    for (const probe of probes) probe.destroy();
    if (!error) return fit;
  }
  return 1;
}

// A binding of a pass, with the buffer it takes: the cell and particle buffers vary per frame, so they are picked per variant.
interface Binding {
  binding: number;
  type?: GPUBufferBindingType;
  buffer: (cells: GPUBuffer, particles: GPUBuffer) => GPUBuffer;
}

// One compute pass of a step: bind groups per [cell buffer A or B][particle buffer A or B], and the indirect
// arguments (one thread per particle, or the whole grid) that size it.
interface Step {
  pipeline: GPUComputePipeline;
  groups: GPUBindGroup[][];
  // Null for a direct dispatch of `groups` workgroups.
  indirect: GPUBuffer | null;
  workgroups: [number, number];
  // The entry point, with its override constants when it has any: how `recordStepTimed` names the pass.
  label: string;
}

const storageEntry = (binding: number, type: GPUBufferBindingType = 'storage'): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.COMPUTE,
  buffer: { type },
});

/**
 * The liquids: a particle store (two buffers that swap every frame, the counters and the indirect arguments) and
 * the grid passes of a step. A frame starts with `recordFrameStart`, which applies the brush to the particles and
 * compacts them; `recordStep` then records one fluid update: particles to the grid, gravity, the pressure
 * projection and the extrapolation of the velocities (`FlipModel.stepGrid` in tests/cpu/flip.ts, pass by pass),
 * then the particles move (`stepParticles`) and the liquid is written into the cell grid (`stepRaster`).
 */
export class Fluid {
  readonly capacity: number;
  /** { count, spawnCursor, compactCursor, water, oil } as u32; `count` is the live total after the last frame start. */
  readonly particleState: GPUBuffer;
  /** Indirect dispatch arguments: one thread per live particle. */
  readonly particleArgs: GPUBuffer;
  /** Indirect dispatch arguments: the cell and face grid, or nothing while no particle is alive. */
  readonly gridArgs: GPUBuffer;
  readonly grid: FluidGridBuffers;
  readonly raster: FluidRasterBuffers;

  private readonly device: GPUDevice;
  private readonly cells: CellBuffer;
  private readonly seedSource: () => number;
  private readonly particleBuffers: [GPUBuffer, GPUBuffer];
  // Index of the buffer holding the live particles: the one the next frame start compacts from.
  private current: 0 | 1 = 0;

  private readonly brushUniformBuffer: GPUBuffer;
  private readonly brushUniformData = new ArrayBuffer(BRUSH_UNIFORM_WORDS * 4);
  private readonly brushFloats = new Float32Array(this.brushUniformData);
  private readonly brushWords = new Uint32Array(this.brushUniformData);

  private readonly killPipeline: GPUComputePipeline;
  private readonly brushPipeline: GPUComputePipeline;
  private readonly compactArgsPipeline: GPUComputePipeline;
  private readonly compactPipeline: GPUComputePipeline;
  private readonly finalizePipeline: GPUComputePipeline;
  // [cell buffer A or B][particle buffer A or B]
  private readonly killGroups: GPUBindGroup[][];
  private readonly brushGroups: GPUBindGroup[][];
  // [source particle buffer]
  private readonly compactGroups: GPUBindGroup[];
  private readonly compactArgsGroup: GPUBindGroup;
  private readonly finalizeGroup: GPUBindGroup;

  private readonly solver: FluidSolver;
  private readonly iterations: number;
  // Passes 1-9 of a step (clear to prepare), pass 10 (the pressure solve, each pass with the name of its group),
  // passes 11-13 (gradient to the last ring).
  private readonly beforeSolve: Step[];
  private readonly solve: { step: Step; group: string }[] = [];
  private readonly afterSolve: Step[];
  private readonly residualStep: Step;
  // Passes 14-15 (move the particles, count them in their new cells), then the rasterization chain of passes 16-19.
  private readonly moveParticles: Step[];
  private readonly padKeys: Step[];
  private readonly selectCells: Step[];
  private readonly oilKeyStep: Step;
  private readonly selectOil: Step[];
  private readonly writeStep: Step;

  constructor(device: GPUDevice, cells: CellBuffer, seedSource: () => number, options: FluidOptions = {}) {
    this.device = device;
    this.cells = cells;
    this.seedSource = seedSource;
    const { width, height } = cells;
    this.capacity = options.particleCapacity ?? particleCapacityFor(device, width, height);
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > MAX_PARTICLES) {
      throw new RangeError(`particleCapacity must be an integer in 1..${MAX_PARTICLES}, got ${this.capacity}`);
    }

    this.solver = options.solver ?? FLUID.solver;
    this.iterations = options.iterations ?? FLUID.iterations;
    if (!Number.isInteger(this.iterations) || this.iterations < 0) {
      throw new RangeError(`iterations must be a non-negative integer, got ${this.iterations}`);
    }

    const particleBuffer = (): GPUBuffer => device.createBuffer({ size: this.capacity * PARTICLE_BYTES, usage: bufferUsage() });
    this.particleBuffers = [particleBuffer(), particleBuffer()];
    this.particleState = device.createBuffer({ size: STATE_WORDS * 4, usage: bufferUsage() });
    this.particleArgs = device.createBuffer({ size: 12, usage: argsUsage() });
    this.gridArgs = device.createBuffer({ size: 12, usage: argsUsage() });
    this.brushUniformBuffer = device.createBuffer({
      size: this.brushUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Buffers of the grid passes (the layouts are described in docs/plans/physics-foundation.md, "Buffers").
    const cellCount = width * height;
    const uCount = (width + 1) * height;
    const vCount = width * (height + 1);
    const words = (n: number): GPUBuffer => device.createBuffer({ size: n * 4, usage: bufferUsage() });
    const u = words(uCount);
    const v = words(vCount);
    const uPrev = words(uCount);
    const vPrev = words(vCount);
    const flags = words(cellCount);
    const density = words(cellCount);
    const p = words(cellCount);
    const residual = words(1);
    const multigrid = this.solver === 'multigrid';
    const levels = multigrid ? multigridLevels(width, height) : [{ width, height, offset: 0 }];
    const levelCells = multigridCells(levels);
    const weights = words(4 * levelCells);
    const diagDiv = words(2 * levelCells);
    this.grid = { u, v, uPrev, vPrev, flags, density, p, weights, diagDiv, levels, residual };
    const counts = words(cellCount);
    const oilCounts = words(cellCount);
    const keys = words(cellCount);
    const oilKeys = words(cellCount);
    const histogram = words(256);
    const select = words(SELECT_WORDS);
    this.raster = { counts, oilCounts, keys, oilKeys, histogram, select };
    const uAcc = words(2 * uCount);
    const vAcc = words(2 * vCount);
    // Both validity copies of the extrapolation in one buffer, to stay within the binding limit of a pass.
    const uValid = words(2 * uCount);
    const vValid = words(2 * vCount);
    const divergence = words(cellCount);

    const b = PARTICLE_BINDINGS;
    const particlesModule = device.createShaderModule({ code: fluidParticlesWGSL(width, height, this.capacity) });
    const pipeline = (entryPoint: string, entries: GPUBindGroupLayoutEntry[]): [GPUComputePipeline, GPUBindGroupLayout] => {
      const layout = device.createBindGroupLayout({ entries });
      const compute = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: particlesModule, entryPoint },
      });
      return [compute, layout];
    };
    const [killPipeline, killLayout] = pipeline('kill', [
      storageEntry(b.state),
      storageEntry(b.particles),
      storageEntry(b.cells, 'read-only-storage'),
      storageEntry(b.brush, 'uniform'),
    ]);
    const [compactArgsPipeline, compactArgsLayout] = pipeline('compactArgs', [
      storageEntry(b.state),
      storageEntry(b.particleArgs),
    ]);
    const [compactPipeline, compactLayout] = pipeline('compact', [
      storageEntry(b.state),
      storageEntry(b.particles),
      storageEntry(b.compacted),
    ]);
    const [finalizePipeline, finalizeLayout] = pipeline('finalize', [
      storageEntry(b.state),
      storageEntry(b.particleArgs),
      storageEntry(b.gridArgs),
    ]);
    this.killPipeline = killPipeline;
    this.compactArgsPipeline = compactArgsPipeline;
    this.compactPipeline = compactPipeline;
    this.finalizePipeline = finalizePipeline;

    const brushLayout = device.createBindGroupLayout({
      entries: [storageEntry(0), storageEntry(1, 'uniform'), storageEntry(2), storageEntry(3)],
    });
    this.brushPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [brushLayout] }),
      compute: {
        module: device.createShaderModule({ code: brushWGSL(width, height, this.capacity) }),
        entryPoint: 'main',
      },
    });

    const cellBuffers = [cells.bufferA, cells.bufferB];
    const buffer = (resource: GPUBuffer): GPUBindingResource => ({ buffer: resource });
    this.killGroups = cellBuffers.map((cellBuffer) => this.particleBuffers.map((particles) => device.createBindGroup({
      layout: killLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particles, resource: buffer(particles) },
        { binding: b.cells, resource: buffer(cellBuffer) },
        { binding: b.brush, resource: buffer(this.brushUniformBuffer) },
      ],
    })));
    this.brushGroups = cellBuffers.map((cellBuffer) => this.particleBuffers.map((particles) => device.createBindGroup({
      layout: brushLayout,
      entries: [
        { binding: 0, resource: buffer(cellBuffer) },
        { binding: 1, resource: buffer(this.brushUniformBuffer) },
        { binding: 2, resource: buffer(particles) },
        { binding: 3, resource: buffer(this.particleState) },
      ],
    })));
    this.compactGroups = [0, 1].map((source) => device.createBindGroup({
      layout: compactLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particles, resource: buffer(this.particleBuffers[source]) },
        { binding: b.compacted, resource: buffer(this.particleBuffers[1 - source]) },
      ],
    }));
    this.compactArgsGroup = device.createBindGroup({
      layout: compactArgsLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particleArgs, resource: buffer(this.particleArgs) },
      ],
    });
    this.finalizeGroup = device.createBindGroup({
      layout: finalizeLayout,
      entries: [
        { binding: b.state, resource: buffer(this.particleState) },
        { binding: b.particleArgs, resource: buffer(this.particleArgs) },
        { binding: b.gridArgs, resource: buffer(this.gridArgs) },
      ],
    });

    const step = (
      module: GPUShaderModule,
      entryPoint: string,
      indirect: GPUBuffer | null,
      bindings: Binding[],
      constants?: Record<string, number>,
      workgroups: [number, number] = [1, 1],
    ): Step => {
      const layout = device.createBindGroupLayout({ entries: bindings.map((x) => storageEntry(x.binding, x.type)) });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint, constants },
      });
      const groups = cellBuffers.map((cellBuffer) => this.particleBuffers.map((particles) => device.createBindGroup({
        layout,
        entries: bindings.map((x) => ({ binding: x.binding, resource: buffer(x.buffer(cellBuffer, particles)) })),
      })));
      const overrides = constants ? `[${Object.entries(constants).map(([k, x]) => `${k}=${x}`).join(',')}]` : '';
      return { pipeline, groups, indirect, workgroups, label: `${entryPoint}${overrides}` };
    };
    const fixed = (binding: number, resource: GPUBuffer, type?: GPUBufferBindingType): Binding => ({ binding, type, buffer: () => resource });
    const readOnly = (binding: number, resource: GPUBuffer): Binding => fixed(binding, resource, 'read-only-storage');

    const g = GRID_BINDINGS;
    const gridModule = device.createShaderModule({ code: fluidGridWGSL(width, height, this.capacity) });
    const gridStep = (entryPoint: string, bindings: Binding[], constants?: Record<string, number>): Step =>
      step(gridModule, entryPoint, this.gridArgs, bindings, constants);
    const gridCells: Binding = { binding: g.cells, type: 'read-only-storage', buffer: (c) => c };
    const flagsB = fixed(g.flags, flags);
    const uB = fixed(g.u, u);
    const vB = fixed(g.v, v);
    const countsB = fixed(g.counts, counts);
    const oilCountsB = fixed(g.oilCounts, oilCounts);
    const accB = [fixed(g.uAcc, uAcc), fixed(g.vAcc, vAcc)];
    const validB = [fixed(g.uValid, uValid), fixed(g.vValid, vValid)];
    const pB = fixed(g.p, p);
    const solverB = [fixed(g.weights, weights), fixed(g.diagDiv, diagDiv)];
    const divergenceB = fixed(g.divergence, divergence);
    const extrapolation = [flagsB, uB, vB, ...validB];

    const particleModuleStep = (entryPoint: string, bindings: Binding[]): Step =>
      step(particlesModule, entryPoint, this.particleArgs, bindings);
    const state: Binding = fixed(b.state, this.particleState);
    const liveParticles: Binding = { binding: b.particles, buffer: (_, particles) => particles };
    const particleCells: Binding = { binding: b.cells, type: 'read-only-storage', buffer: (c) => c };

    const ring = (read: 0 | 1): Step => gridStep('extrapolate', extrapolation, { READ: read });
    this.beforeSolve = [
      gridStep('clearGrid', [countsB, oilCountsB, ...accB]),
      particleModuleStep('resolve', [state, liveParticles, particleCells]),
      particleModuleStep('countParticles', [
        state, liveParticles, fixed(b.counts, counts), fixed(b.oilCounts, oilCounts),
      ]),
      gridStep('classify', [gridCells, countsB, oilCountsB, flagsB, fixed(g.density, density), pB]),
      particleModuleStep('particlesToGrid', [
        state, liveParticles, fixed(b.uAcc, uAcc), fixed(b.vAcc, vAcc),
      ]),
      gridStep('normalizeFaces', [...accB, flagsB, uB, vB, ...validB]),
      ring(0),
      ring(1),
      gridStep('applyGravity', [flagsB, uB, vB, fixed(g.uPrev, uPrev), fixed(g.vPrev, vPrev)]),
      gridStep('prepare', [flagsB, fixed(g.density, density), countsB, uB, vB, ...solverB, divergenceB]),
    ];
    const film: boolean = FLUID.film;
    this.afterSolve = [
      gridStep('gradient', [flagsB, pB, ...solverB, uB, vB]),
      ...(film ? [gridStep('pinFilms', [flagsB, uB])] : []),
      gridStep('extrapolateInit', extrapolation),
      ring(0),
      ring(1),
    ];
    this.residualStep = gridStep('measureResidual', [pB, ...solverB, divergenceB, fixed(g.residualMax, residual)]);

    if (multigrid) {
      const m = MG_BINDINGS;
      const levelP = words(levelCells);
      const cgD = words(cellCount);
      const cgQ = words(cellCount);
      const partials = words(Math.ceil((width + 1) / GRID_WORKGROUP) * Math.ceil((height + 1) / GRID_WORKGROUP));
      const scalars = words(SCALAR_WORDS);
      const tailStart = multigridTailStart(levels);
      const mgModule = device.createShaderModule({
        code: fluidMultigridWGSL(width, height, this.capacity, levels.slice(tailStart)),
      });
      // Passes over the fluid grid ride its indirect arguments (nothing runs while no particle is alive); a coarser
      // level is dispatched by its own size, and the single-workgroup passes by [1, 1].
      const mgStep = (entryPoint: string, bindings: Binding[], constants?: Record<string, number>, groups?: [number, number]): Step =>
        step(mgModule, entryPoint, groups ? null : this.gridArgs, bindings, constants, groups);
      const cover = (level: LevelGeometry): [number, number] =>
        [Math.ceil(level.width / GRID_WORKGROUP), Math.ceil(level.height / GRID_WORKGROUP)];
      const own = (k: number): [number, number] | undefined => (k === 0 ? undefined : cover(levels[k]));

      const weightsB = fixed(m.weights, weights);
      const diagDivB = fixed(m.diagDiv, diagDiv);
      const levelPB = fixed(m.levelP, levelP);
      const mgPB = fixed(m.p, p);
      const divergenceMgB = fixed(m.divergence, divergence);
      const dB = fixed(m.cgD, cgD);
      const qB = fixed(m.cgQ, cgQ);
      const partialsB = fixed(m.partials, partials);
      const scalarsB = fixed(m.scalars, scalars);
      const levelB = [weightsB, diagDivB, levelPB];

      // Level k's smoothing, and the transfer between level k and k + 1 (restriction and building run one thread per
      // coarse cell, prolongation one per fine cell).
      const smooth = (k: number, color: 0 | 1): Step => mgStep(
        'smoothLevel', levelB, { NX: levels[k].width, NY: levels[k].height, OFF: levels[k].offset, COLOR: color }, own(k),
      );
      const between = (entryPoint: string, k: number, byFine: boolean): Step => {
        const fine = levels[k];
        const coarse = levels[k + 1];
        const constants = {
          FNX: fine.width, FNY: fine.height, FOFF: fine.offset, CNX: coarse.width, CNY: coarse.height, COFF: coarse.offset,
        };
        return mgStep(entryPoint, levelB, constants, byFine ? own(k) : cover(coarse));
      };
      const perLevel = <T>(make: (k: number) => T): T[] => Array.from({ length: tailStart }, (_, k) => make(k));
      const smoothing = perLevel((k) => [smooth(k, 0), smooth(k, 1)] as const);
      const restriction = perLevel((k) => between('restrictLevel', k, false));
      const prolongation = perLevel((k) => between('prolongLevel', k, true));
      const building = perLevel((k) => between('buildLevel', k, false));
      const tailBuild = tailStart < levels.length - 1 ? mgStep('tailBuild', levelB, undefined, [1, 1]) : null;
      const tailCycle = mgStep('tailCycle', levelB, undefined, [1, 1]);

      // One V-cycle on the preconditioner system: the levels above the tail by dispatches, the tail in one.
      const vCycle: Step[] = [];
      for (let k = 0; k < tailStart; k++) {
        for (let i = 0; i < FLUID.preSweeps; i++) vCycle.push(smoothing[k][0], smoothing[k][1]);
        vCycle.push(restriction[k]);
      }
      vCycle.push(tailCycle);
      for (let k = tailStart - 1; k >= 0; k--) {
        vCycle.push(prolongation[k]);
        for (let i = 0; i < FLUID.postSweeps; i++) vCycle.push(smoothing[k][1], smoothing[k][0]);
      }

      const cgInit = mgStep('cgInit', [weightsB, diagDivB, levelPB, mgPB, divergenceMgB]);
      const cgDotInit = mgStep('cgDotInit', [diagDivB, levelPB, dB, partialsB]);
      const cgMultiply = mgStep('cgMultiply', [weightsB, diagDivB, dB, qB, partialsB]);
      const cgUpdate = mgStep('cgUpdate', [diagDivB, levelPB, mgPB, dB, qB, scalarsB]);
      const cgDot = mgStep('cgDot', [diagDivB, levelPB, partialsB]);
      const cgDirection = mgStep('cgDirection', [levelPB, dB, scalarsB]);
      const scalarSteps = ['scalarInit', 'scalarAlpha', 'scalarBeta'].map((name) => mgStep(name, [partialsB, scalarsB], undefined, [1, 1]));
      const [scalarInit, scalarAlpha, scalarBeta] = scalarSteps;

      const add = (group: string, ...steps: Step[]): void => {
        for (const added of steps) this.solve.push({ step: added, group });
      };
      add('buildLevels', ...building);
      if (tailBuild) add('buildLevels', tailBuild);
      // Warm-started conjugate gradients: each iteration but the last ends in a V-cycle on the new residual.
      add('cgSetup', cgInit);
      add('vCycle', ...vCycle);
      add('cgSetup', cgDotInit, scalarInit);
      for (let i = 1; i <= FLUID.cycles; i++) {
        add('cgIteration', cgMultiply, scalarAlpha, cgUpdate);
        if (i === FLUID.cycles) break;
        add('vCycle', ...vCycle);
        add('cgIteration', cgDot, scalarBeta, cgDirection);
      }
    } else {
      const sweeps = [0, 1].map((color) => gridStep('sweep', [pB, ...solverB, divergenceB], { COLOR: color }));
      for (let i = 0; i < this.iterations; i++) sweeps.forEach((sweep) => this.solve.push({ step: sweep, group: 'sweeps' }));
    }

    const rb = RASTER_BINDINGS;
    const rasterModule = device.createShaderModule({ code: fluidRasterWGSL(width, height, this.capacity) });
    const rasterStep = (entryPoint: string, bindings: Binding[], constants?: Record<string, number>, single = false): Step =>
      step(rasterModule, entryPoint, single ? null : this.gridArgs, bindings, constants);
    const rasterCells: Binding = { binding: rb.cells, buffer: (c) => c };
    const rasterCounts = [fixed(rb.counts, counts), fixed(rb.oilCounts, oilCounts)];
    const keysB = fixed(rb.keys, keys);
    const selectB = fixed(rb.select, select);
    const histogramB = fixed(rb.histogram, histogram);
    const stateB = fixed(rb.state, this.particleState);
    // One selection: four rounds of a histogram over `source` and a single-thread pick that advances the round.
    const selection = (source: GPUBuffer, oil: 0 | 1): Step[] => Array.from({ length: 4 }, () => [
      rasterStep('histogramPass', [readOnly(rb.source, source), selectB, histogramB]),
      rasterStep('pick', [selectB, histogramB], { OIL: oil }, true),
    ]).flat();

    this.moveParticles = [
      particleModuleStep('gridToParticles', [
        state, liveParticles, particleCells, readOnly(b.flags, flags), readOnly(b.u, u), readOnly(b.v, v),
        readOnly(b.uPrev, uPrev), readOnly(b.vPrev, vPrev),
      ]),
      rasterStep('clearCounts', [...rasterCounts, stateB]),
      particleModuleStep('rasterCount', [state, liveParticles, fixed(b.counts, counts), fixed(b.oilCounts, oilCounts)]),
      rasterStep('setWanted', [stateB, selectB], undefined, true),
    ];
    this.padKeys = [
      rasterStep('keys', [rasterCells, ...rasterCounts, keysB]),
      ...Array.from({ length: FLUID.paddingRings }, (_, ring) => rasterStep('padRing', [rasterCells, keysB], { RING: ring + 1 })),
    ];
    this.selectCells = selection(keys, 0);
    this.oilKeyStep = rasterStep('oilKeys', [...rasterCounts, keysB, fixed(rb.oilKeys, oilKeys), selectB]);
    this.selectOil = selection(oilKeys, 1);
    this.writeStep = rasterStep('writeCells', [rasterCells, keysB, fixed(rb.oilKeys, oilKeys), selectB]);

    this.clear();
  }

  /** The buffer holding the live particles, `Particle { px, py, vx, vy: f32, kind: u32 }` records of 20 bytes. */
  get particleBuffer(): GPUBuffer {
    return this.particleBuffers[this.current];
  }

  /** Replaces the particles with `FLUID.perCell` at rest in every water and oil cell of `cells`. */
  load(cells: Uint32Array): void {
    const { width, height } = this.cells;
    const spawned = spawnParticles(cells, width, height);
    if (spawned.count > this.capacity) {
      throw new RangeError(`the scene needs ${spawned.count} particles, the store holds ${this.capacity}`);
    }
    if (spawned.count > 0) this.device.queue.writeBuffer(this.particleBuffer, 0, spawned.floats);
    this.setState(spawned.count, spawned.water, spawned.oil);
  }

  /** Removes every particle. */
  clear(): void {
    this.setState(0, 0, 0);
  }

  /**
   * Gives the live particles random velocities in [-0.5, 0.5) per component, drawn in the order of the CPU
   * reference's `FlipModel.seedVelocities`. Only meaningful right after `load`, while the buffer is still in
   * load order and no frame has been recorded.
   */
  async seedVelocities(seed: number): Promise<void> {
    const state = await this.read(this.particleState, STATE_WORDS * 4);
    const count = new Uint32Array(state)[0];
    if (count === 0) return;
    const records = new Float32Array(await this.read(this.particleBuffer, count * PARTICLE_BYTES));
    const rand = mulberry32(seed);
    const stride = PARTICLE_BYTES / 4;
    for (let p = 0; p < count; p++) {
      records[p * stride + 2] = rand() / 2 ** 32 - 0.5;
      records[p * stride + 3] = rand() / 2 ** 32 - 0.5;
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, records);
  }

  /**
   * Records the start of a frame into the caller's compute pass: the brush's effect on the particles, then the
   * compaction. The brush appends to the current buffer, after its `count` live particles, and compaction copies
   * everything live (old and new) into the other buffer, which becomes the current one.
   */
  recordFrameStart(pass: GPUComputePassEncoder, brush: SimulationInput | null): void {
    const cellsIndex = this.cells.currentBuffer === this.cells.bufferA ? 0 : 1;
    const source = this.current;

    if (brush) {
      this.writeBrushUniforms(brush);
      // Kills first, so they see the old cell types; spawning then appends behind the live particles.
      pass.setPipeline(this.killPipeline);
      pass.setBindGroup(0, this.killGroups[cellsIndex][source]);
      pass.dispatchWorkgroupsIndirect(this.particleArgs, 0);

      pass.setPipeline(this.brushPipeline);
      pass.setBindGroup(0, this.brushGroups[cellsIndex][source]);
      pass.dispatchWorkgroups(Math.ceil(this.cells.width / GRID_WORKGROUP), Math.ceil(this.cells.height / GRID_WORKGROUP));
    }

    pass.setPipeline(this.compactArgsPipeline);
    pass.setBindGroup(0, this.compactArgsGroup);
    pass.dispatchWorkgroups(1);

    pass.setPipeline(this.compactPipeline);
    pass.setBindGroup(0, this.compactGroups[source]);
    pass.dispatchWorkgroupsIndirect(this.particleArgs, 0);

    pass.setPipeline(this.finalizePipeline);
    pass.setBindGroup(0, this.finalizeGroup);
    pass.dispatchWorkgroups(1);

    this.current = source === 0 ? 1 : 0;
  }

  /**
   * Records one fluid update into the caller's compute pass, after `recordFrameStart` published the particle
   * count: the grid passes that carry the particles' velocities through gravity, the pressure projection and the
   * extrapolation (passes 1-13), then, for `stage` 'full', the particles move and the liquid is rasterized into
   * the current cell buffer (passes 14-19). Binds the cell buffer that is current now and the live particle buffer.
   * The CA dispatches of the step are the caller's.
   */
  recordStep(pass: GPUComputePassEncoder, stage: FluidStage = 'full'): void {
    this.forEachStep(stage, (step) => this.recordPass(pass, step));
  }

  /**
   * Bench only: `recordStep` with every pass in a compute pass of its own, so `stamp` can ask for the timestamps
   * of each one. `stamp` gets the pass's group (the step list it belongs to) and label, and returns where to write.
   * The extra pass boundaries cost a little, so the sum is not a frame time; compare passes with each other.
   */
  recordStepTimed(
    encoder: GPUCommandEncoder,
    stage: FluidStage,
    stamp: (group: string, label: string) => GPUComputePassTimestampWrites,
  ): void {
    this.forEachStep(stage, (step, group) => {
      const pass = encoder.beginComputePass({ timestampWrites: stamp(group, step.label) });
      this.recordPass(pass, step);
      pass.end();
    });
  }

  /** Bench only: `recordFrameStart` with the compaction in a compute pass of its own, timestamped as `recordStepTimed`. */
  recordFrameStartTimed(encoder: GPUCommandEncoder, timestampWrites: GPUComputePassTimestampWrites): void {
    const pass = encoder.beginComputePass({ timestampWrites });
    this.recordFrameStart(pass, null);
    pass.end();
  }

  // The passes of one step in order, each with the name of the list it comes from.
  private forEachStep(stage: FluidStage, visit: (step: Step, group: string) => void): void {
    this.beforeSolve.forEach((step) => visit(step, 'beforeSolve'));
    this.solve.forEach(({ step, group }) => visit(step, group));
    this.afterSolve.forEach((step) => visit(step, 'afterSolve'));
    if (stage === 'grid') return;
    this.moveParticles.forEach((step) => visit(step, 'moveParticles'));
    this.padKeys.forEach((step) => visit(step, 'padKeys'));
    this.selectCells.forEach((step) => visit(step, 'selectCells'));
    visit(this.oilKeyStep, 'oilKeys');
    this.selectOil.forEach((step) => visit(step, 'selectOil'));
    visit(this.writeStep, 'write');
  }

  /**
   * Test only: one radix selection alone, over `raster.keys`. The caller writes `wanted` into `raster.select`
   * (round 0, histogram empty, as after `load`) and reads `threshold`, `none`, `chosen` and `shortfall` back.
   */
  recordSelect(pass: GPUComputePassEncoder): void {
    this.selectCells.forEach((step) => this.recordWhole(pass, step));
  }

  /**
   * Test only: the key pass and the padding rings, over the whole grid, from `raster.counts` and the current
   * cell buffer, into `raster.keys`.
   */
  recordKeys(pass: GPUComputePassEncoder): void {
    this.padKeys.forEach((step) => this.recordWhole(pass, step));
  }

  /**
   * Test only: the oil key pass over the whole grid, from `raster.keys`, `raster.counts`, `raster.oilCounts` and the
   * `threshold` and `none` the caller wrote into `raster.select`.
   */
  recordOilKeys(pass: GPUComputePassEncoder): void {
    this.recordWhole(pass, this.oilKeyStep);
  }

  /**
   * Test only: records the pass that writes the largest remaining residual of the current pressure into
   * `grid.residual` (as the bits of an f32). The caller zeroes the buffer first.
   */
  recordResidual(pass: GPUComputePassEncoder): void {
    this.recordPass(pass, this.residualStep);
  }

  private recordPass(pass: GPUComputePassEncoder, step: Step): void {
    this.bind(pass, step);
    if (step.indirect) pass.dispatchWorkgroupsIndirect(step.indirect, 0);
    else pass.dispatchWorkgroups(...step.workgroups);
  }

  // Dispatches a cell pass over the whole grid whatever the indirect arguments say, for the test hooks.
  private recordWhole(pass: GPUComputePassEncoder, step: Step): void {
    this.bind(pass, step);
    if (step.indirect) pass.dispatchWorkgroups(Math.ceil(this.cells.width / GRID_WORKGROUP), Math.ceil(this.cells.height / GRID_WORKGROUP));
    else pass.dispatchWorkgroups(1);
  }

  private bind(pass: GPUComputePassEncoder, step: Step): void {
    const cellsIndex = this.cells.currentBuffer === this.cells.bufferA ? 0 : 1;
    pass.setPipeline(step.pipeline);
    pass.setBindGroup(0, step.groups[cellsIndex][this.current]);
  }

  private setState(count: number, water: number, oil: number): void {
    const { width, height } = this.cells;
    // The pressure is the one grid field that carries over from step to step (the solver's warm start).
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.grid.p);
    // The selection state and its histogram start from zero, including the running `maxShortfall`.
    encoder.clearBuffer(this.raster.select);
    encoder.clearBuffer(this.raster.histogram);
    this.device.queue.submit([encoder.finish()]);
    const state = new Uint32Array(STATE_WORDS);
    state[0] = count;
    state[1] = count;
    state[3] = water;
    state[4] = oil;
    this.device.queue.writeBuffer(this.particleState, 0, state);
    const live = count > 0;
    this.device.queue.writeBuffer(this.particleArgs, 0, new Uint32Array([Math.ceil(count / PARTICLE_WORKGROUP), 1, 1]));
    this.device.queue.writeBuffer(this.gridArgs, 0, new Uint32Array(live
      ? [Math.ceil((width + 1) / GRID_WORKGROUP), Math.ceil((height + 1) / GRID_WORKGROUP), 1]
      : [0, 0, 0]));
  }

  private writeBrushUniforms(input: SimulationInput): void {
    const f = this.brushFloats;
    const w = this.brushWords;
    f[0] = input.prevMousePos.x;
    f[1] = input.prevMousePos.y;
    f[2] = input.mousePos.x;
    f[3] = input.mousePos.y;
    f[4] = input.brushSize;
    w[5] = input.particleType;
    w[6] = input.erasing ? 1 : 0;
    w[7] = input.replacing ? 1 : 0;
    w[8] = this.seedSource();
    this.device.queue.writeBuffer(this.brushUniformBuffer, 0, this.brushUniformData);
  }

  private async read(buffer: GPUBuffer, byteLength: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return data;
  }
}
