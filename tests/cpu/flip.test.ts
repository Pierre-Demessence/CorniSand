import { describe, expect, it } from 'vitest';
import { FLUID, MAX_FLUID_CELLS, oilKey, rasterKey, rasterQuality } from '../../src/fluid-params';
import { PARTICLE_TYPES as T } from '../../src/particles';
import { packCell, type Scene } from '../../src/scenes';
import { mulberry32 } from '../random';
import { FlipModel, rasterKeys } from './flip';

function tank(width: number, height: number): Uint32Array<ArrayBuffer> {
  const cells = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < 2 || x >= width - 2 || y < 2) cells[y * width + x] = packCell(T.WALL);
    }
  }
  return cells;
}

function scene(width: number, height: number, cells: Uint32Array<ArrayBuffer>): Scene {
  return { name: 'test', width, height, cells, floorY: 2, chambers: [] };
}

function fillRect(cells: Uint32Array, width: number, type: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) cells.fill(packCell(type), y * width + x0, y * width + x1);
}

describe('rasterization keys', () => {
  it('stay unique and inside 32 bits at the extremes', () => {
    const best = rasterKey(rasterQuality(99, 99, 99, true), 0);
    expect(rasterQuality(99, 99, 99, true)).toBe(243);
    expect(best).toBeLessThan(2 ** 32);
    expect(rasterKey(243, 0)).toBeGreaterThan(rasterKey(243, 1));
    expect(rasterKey(1, 0)).toBeGreaterThan(0);
    expect(oilKey(255, MAX_FLUID_CELLS - 1)).toBeLessThan(2 ** 32);
  });

  it('order cells like the former float key when no count exceeds the clamp', () => {
    const rand = mulberry32(2024);
    const types = [T.EMPTY, T.EMPTY, T.WATER, T.OIL, T.WALL, T.SAND, T.SMOKE, T.FIRE];
    const width = 9;
    const height = 7;
    for (let round = 0; round < 10_000; round++) {
      const cells = new Uint32Array(width * height);
      const counts = new Uint16Array(width * height);
      for (let c = 0; c < width * height; c++) {
        cells[c] = types[rand() % types.length];
        counts[c] = rand() % 3 === 0 ? 0 : rand() % (FLUID.countClamp + 1);
      }

      // The former key: floats, side weight 0.5, 0.3 for a cell that is liquid now, a bias toward low rows.
      const oldKey = (c: number): number => {
        const x = c % width;
        const side = (n: number, inside: boolean): number => {
          const type = inside ? cells[n] & 0xff : T.WALL;
          return type === T.WALL || type === T.SAND ? counts[c] : counts[n];
        };
        const liquid = (cells[c] & 0xff) === T.WATER || (cells[c] & 0xff) === T.OIL;
        const y = Math.floor(c / width);
        return counts[c] + 0.5 * (side(c - 1, x > 0) + side(c + 1, x < width - 1)) + (liquid ? 0.3 : 0) + (height - y) / (height * 20);
      };

      // Cells holding a particle that both versions may pick (the old one also took smoke and fire; the padding ring is new).
      const comparable: number[] = [];
      for (let c = 0; c < width * height; c++) {
        const type = cells[c] & 0xff;
        if (counts[c] > 0 && (type === T.EMPTY || type === T.WATER || type === T.OIL)) comparable.push(c);
      }
      const keys = rasterKeys(cells, counts, width, height);
      const byNew = [...comparable].sort((a, b) => keys[b] - keys[a]);
      const byOld = [...comparable].sort((a, b) => oldKey(b) - oldKey(a) || a - b);
      expect(byNew).toEqual(byOld);
    }
  });
});

describe('FlipModel rasterization', () => {
  it('never overwrites smoke or fire, and keeps the water volume (D16)', () => {
    const width = 40;
    const height = 20;
    const cells = tank(width, height);
    fillRect(cells, width, T.WATER, 2, width - 2, 2, 8);
    // Smoke and fire sit in the top row of the pool, where its particles drift into them. Cell (10, 7) and (20, 7)
    // hold no particles at load; the CA of the CPU reference does not move smoke or fire, so only rasterization
    // could change them.
    const smoke = 7 * width + 10;
    const fire = 7 * width + 20;
    cells[smoke] = packCell(T.SMOKE);
    cells[fire] = packCell(T.FIRE);
    const model = new FlipModel();
    model.load(scene(width, height, cells));
    const water = model.volume(T.WATER);
    expect(water).toBe(36 * 6 - 2);

    let entered = 0;
    for (let step = 0; step < 100; step++) {
      model.step(1);
      const state = model.debugState();
      for (let p = 0; p < state.px.length; p++) {
        const at = Math.floor(state.py[p]) * width + Math.floor(state.px[p]);
        if (at === smoke || at === fire) entered++;
      }
      expect(model.cells()[smoke] & 0xff).toBe(T.SMOKE);
      expect(model.cells()[fire] & 0xff).toBe(T.FIRE);
      expect(model.volume(T.WATER)).toBe(water);
    }
    // The test only means something if particles did reach the protected cells.
    expect(entered).toBeGreaterThan(0);
    expect(model.maxShortfall).toBe(0);
  });

  it('removes an oil particle inside a fire cell and the oil cell it paid for', () => {
    const width = 20;
    const height = 12;
    const cells = tank(width, height);
    fillRect(cells, width, T.OIL, 4, 8, 2, 4);
    const model = new FlipModel();
    model.load(scene(width, height, cells));
    expect(model.volume(T.OIL)).toBe(8);
    expect(model.debugState().px).toHaveLength(32);

    const burning = 2 * width + 5;
    model.cells()[burning] = packCell(T.FIRE);
    model.step(1);

    const state = model.debugState();
    expect(state.px).toHaveLength(28);
    expect(state.kind.every((kind) => kind === 1)).toBe(true);
    expect(model.volume(T.OIL)).toBe(7);
    expect(model.cells()[burning] & 0xff).toBe(T.FIRE);
  });

  it('shows floor(particles / 4) liquid cells', () => {
    const width = 20;
    const height = 12;
    const cells = tank(width, height);
    fillRect(cells, width, T.WATER, 4, 10, 2, 6);
    const model = new FlipModel();
    model.load(scene(width, height, cells));
    expect(model.debugState().px).toHaveLength(96);

    // 83 = 4 * 20 + 3
    model.dropParticles(13);
    expect(model.debugState().px).toHaveLength(83);
    model.step(1);
    expect(model.volume(T.WATER)).toBe(20);
  });

  it('fills the rings around the particle cells, nearest first, when they are packed into too few cells', () => {
    const width = 20;
    const height = 12;
    const cells = tank(width, height);
    fillRect(cells, width, T.WATER, 4, 8, 2, 4);
    const model = new FlipModel();
    model.load(scene(width, height, cells));
    // Stack the 32 particles into two cells: their first ring has four open cells, so the volume of eight needs two more.
    const state = model.debugState();
    for (let p = 0; p < state.px.length; p++) {
      state.px[p] = 4.5 + (p % 2);
      state.py[p] = 2.5;
    }
    model.stepRaster();
    expect(model.volume(T.WATER)).toBe(8);
    expect(model.shortfall).toBe(0);
    const water = (x: number, y: number): boolean => (model.cells()[y * width + x] & 0xff) === T.WATER;
    for (const [x, y] of [[4, 2], [5, 2], [3, 2], [6, 2], [4, 3], [5, 3]]) expect(water(x, y), `(${x}, ${y})`).toBe(true);
  });
});
