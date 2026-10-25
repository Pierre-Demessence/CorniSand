import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../../src/particles';
import { packCell, type Scene } from '../../src/scenes';
import { chamberLevel, flatness } from '../metrics';
import { FlipModel } from './flip';

// M1.5c experiment E4: the deep pool at half size (256x600) for 3,000 steps under multigrid and under 40 sweep pairs.
// Minutes per solver, so run on demand, one solver per process if you want them in parallel:
// `E4=1 npx vitest run solver-e4 -t multigrid` (add `E4_STIFFNESS=0.5` to restore the values before M1.5c.3b, at which this scene fails). The numbers it logs are recorded in docs/plans/physics-foundation.md.

const WALL = 2;
const SIZE = { width: 256, height: 600, depth: 500, columnWidth: 50, columnHeight: 75, columnY: 520 };

function halfDeepPool(): Scene {
  const { width, height, depth, columnWidth, columnHeight, columnY } = SIZE;
  const cells = new Uint32Array(width * height);
  const wall = packCell(T.WALL);
  const water = packCell(T.WATER);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < WALL || x >= width - WALL || y < WALL;
      const pool = y < WALL + depth;
      const column = x < WALL + columnWidth && y >= columnY && y < columnY + columnHeight;
      cells[y * width + x] = edge ? wall : pool || column ? water : 0;
    }
  }
  const interior = width - 2 * WALL;
  return {
    name: 'deepPoolHalf',
    width,
    height,
    cells,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: width - WALL }],
    expectedLevel: (interior * depth + columnWidth * columnHeight) / interior,
  };
}

function fastShare(model: FlipModel, speed: number): number {
  const { vx, vy } = model.debugState();
  let fast = 0;
  for (let p = 0; p < vx.length; p++) if (Math.max(Math.abs(vx[p]), Math.abs(vy[p])) > speed) fast++;
  return fast / vx.length;
}

describe.skipIf(!process.env.E4)('E4: half-size deepPool, 3,000 steps', () => {
  it.each(['multigrid', 'sor'] as const)('%s', (method) => {
    const scene = halfDeepPool();
    const strength = process.env.E4_STIFFNESS === undefined ? {} : { stiffness: Number(process.env.E4_STIFFNESS), pull: Number(process.env.E4_STIFFNESS) };
    const model = new FlipModel({ method, ...strength });
    model.load(scene);
    const chamber = scene.chambers[0];
    for (let done = 0; done < 3000; done += 500) {
      model.step(500);
      const cells = model.cells();
      console.log([
        `${method} step ${done + 500}:`,
        `level ${chamberLevel(cells, scene.width, scene.height, chamber, scene.floorY).toFixed(1)} (expected ${scene.expectedLevel!.toFixed(1)})`,
        `flatness ${flatness(cells, scene.width, scene.height, chamber, scene.floorY)}`,
        `fast ${(100 * fastShare(model, 0.3)).toFixed(1)}%`,
        `maxShortfall ${model.maxShortfall}`,
        `residual ${model.lastResidual.toExponential(1)}`,
      ].join(', '));
    }
    expect(model.maxShortfall).toBeGreaterThanOrEqual(0);
  }, 7_200_000);
});
