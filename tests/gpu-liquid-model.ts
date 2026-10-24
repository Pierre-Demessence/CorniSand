import { PARTICLE_STRIDE } from '../src/fluid-params';
import { PARTICLE_TYPES as T } from '../src/particles';
import type { Scene } from '../src/scenes';
import type { Simulation } from '../src/simulation';
import { createSim, readCells, readParticles, readSelectState, runMany } from './gpu';
import type { LiquidModel } from './liquid-model';

/** The acceptance tests' view of the real GPU build: every query reads back from the device. */
export class GpuLiquidModel implements LiquidModel {
  maxShortfall = 0;
  private sim!: Simulation;
  private current: Uint32Array = new Uint32Array(0);

  load(scene: Scene): void {
    this.sim = createSim(scene.width, scene.height);
    this.sim.load(scene.cells);
    this.maxShortfall = 0;
    this.current = Uint32Array.from(scene.cells);
  }

  async step(n: number): Promise<void> {
    // One encoder (one frame start) per chunk, as the page records them.
    await runMany(this.sim, n);
    this.current = await readCells(this.sim);
    this.maxShortfall = (await readSelectState(this.sim)).maxShortfall;
  }

  cells(): Uint32Array {
    return this.current;
  }

  volume(type: number): number {
    let count = 0;
    for (const c of this.current) if ((c & 0xff) === type) count++;
    return count;
  }

  /** Largest particle speed in cells per step, as the CPU model reports it. */
  async maxSpeed(): Promise<number> {
    const { count, floats } = await readParticles(this.sim);
    // An empty read-back would make every speed threshold pass vacuously.
    if (count === 0 && (this.volume(T.WATER) > 0 || this.volume(T.OIL) > 0)) throw new Error('no particles read back from a world with liquid');
    let max = 0;
    for (let p = 0; p < count; p++) {
      max = Math.max(max, Math.abs(floats[p * PARTICLE_STRIDE + 2]), Math.abs(floats[p * PARTICLE_STRIDE + 3]));
    }
    return max;
  }
}
