import { describe, expect, it } from 'vitest';
import { computeGrid } from '../src/grid';

// 128 MiB binding limit / 4-byte cells
const DEFAULT_MAX_CELLS = 134217728 / 4;

describe('B1: computeGrid', () => {
  it('uses one cell per CSS pixel when the grid fits', () => {
    expect(computeGrid(1920, 1032, DEFAULT_MAX_CELLS)).toEqual({ width: 1920, height: 1032, scale: 1 });
  });

  it('fits a 4K window at the default limit with a 4-byte cell', () => {
    expect(computeGrid(3840, 2112, DEFAULT_MAX_CELLS).scale).toBe(1);
  });

  it('fits exactly at the limit', () => {
    expect(computeGrid(100, 50, 5000)).toEqual({ width: 100, height: 50, scale: 1 });
  });

  it('picks the smallest integer scale that fits', () => {
    // 100x50 = 5000 cells; scale 2 gives 50x25 = 1250
    expect(computeGrid(100, 50, 4999)).toEqual({ width: 50, height: 25, scale: 2 });
    expect(computeGrid(100, 50, 1250)).toEqual({ width: 50, height: 25, scale: 2 });
    expect(computeGrid(100, 50, 1249).scale).toBe(3);
  });

  it('rounds partial cells up so the grid covers the window', () => {
    expect(computeGrid(101, 51, 1500)).toEqual({ width: 51, height: 26, scale: 2 });
  });

  it('never returns a grid above the limit', () => {
    for (const max of [1, 7, 100, 999, 123456]) {
      const grid = computeGrid(1913, 1007, max);
      expect(grid.width * grid.height).toBeLessThanOrEqual(max);
    }
  });

  it('rejects a limit that holds no cell', () => {
    expect(() => computeGrid(10, 10, 0)).toThrow(RangeError);
  });
});
