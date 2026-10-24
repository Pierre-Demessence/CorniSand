import { describe, expect, it } from 'vitest';
import { parseGrid } from '../ascii';
import { AIR, FluidGrid, LIQUID, SOLID } from './fluid-grid';

// Flags printed top to bottom with the same letters as the ASCII grids: '.' air, 'w' liquid, '#' solid.
function flagRows(grid: FluidGrid): string[] {
  const rows: string[] = [];
  for (let j = grid.ny - 1; j >= 0; j--) {
    let row = '';
    for (let i = 0; i < grid.nx; i++) row += { [AIR]: '.', [LIQUID]: 'w', [SOLID]: '#' }[grid.flags[grid.cellIndex(i, j)]];
    rows.push(row);
  }
  return rows;
}

describe('FluidGrid', () => {
  it('sizes the staggered arrays: one extra face on the u axis and on the v axis', () => {
    const grid = new FluidGrid(8, 6);
    expect([grid.nx, grid.ny]).toEqual([8, 6]);
    expect(grid.u).toHaveLength(9 * 6);
    expect(grid.v).toHaveLength(8 * 7);
    expect(grid.p).toHaveLength(8 * 6);
  });

  it('flags walls and sand solid, liquids liquid and everything else air at k = 1', () => {
    const { cells, width, height } = parseGrid(['..s.', 'ww#w', 'oo..', '####']);
    const grid = new FluidGrid(width, height, 1);
    grid.classify(cells);
    expect(flagRows(grid)).toEqual(['..#.', 'ww#w', 'ww..', '####']);
  });

  it('records a density per liquid cell', () => {
    const { cells, width, height } = parseGrid(['wo.', '###']);
    const grid = new FluidGrid(width, height, 1);
    grid.classify(cells);
    expect(grid.density[grid.cellIndex(0, 1)]).toBe(1);
    expect(grid.density[grid.cellIndex(1, 1)]).toBeCloseTo(0.8, 6);
    expect(grid.density[grid.cellIndex(2, 1)]).toBe(0);
  });

  it('flags 2x2 blocks by majority at k = 2', () => {
    const { cells, width, height } = parseGrid([
      'ww.w',
      'wwww',
      '#.##',
      '###.',
    ]);
    const grid = new FluidGrid(width, height, 2);
    grid.classify(cells);
    expect([grid.nx, grid.ny]).toEqual([2, 2]);
    // Top: four water, then three water and one empty (still liquid). Bottom: three solid of four each.
    expect(flagRows(grid)).toEqual(['ww', '##']);
  });

  it('flags a half-full block liquid, a quarter-full one air, and a half-solid one solid at k = 2', () => {
    const half = parseGrid(['w.', 'w.']);
    const quarter = parseGrid(['w.', '..']);
    const tie = parseGrid(['w#', 'w#']);
    const flags = [half, quarter, tie].map(({ cells, width, height }) => {
      const grid = new FluidGrid(width, height, 2);
      grid.classify(cells);
      return flagRows(grid)[0];
    });
    expect(flags).toEqual(['w', '.', '#']);
  });

  it('counts the part of a block that sticks out of the grid as solid', () => {
    const { cells, width, height } = parseGrid(['www', 'www', '###']);
    const grid = new FluidGrid(width, height, 2);
    grid.classify(cells);
    expect([grid.nx, grid.ny]).toEqual([2, 2]);
    expect(flagRows(grid)).toEqual(['##', '##']);
  });

  it('reports the domain edge as solid', () => {
    const grid = new FluidGrid(4, 4);
    expect(grid.flagAt(-1, 0)).toBe(SOLID);
    expect(grid.flagAt(0, 4)).toBe(SOLID);
    expect(grid.flagAt(2, 2)).toBe(AIR);
  });
});
