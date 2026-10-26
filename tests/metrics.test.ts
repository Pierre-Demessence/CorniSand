import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { parseGrid as parse } from './ascii';
import {
  chamberLevel,
  columnLevel,
  columnsWithAbove,
  countType,
  flatness,
  liquidVolume,
} from './metrics';

function flat(rows: string[]): [Uint32Array<ArrayBuffer>, number, number] {
  const { cells, width, height } = parse(rows);
  return [cells, width, height];
}

describe('metrics', () => {
  it('count volumes per type', () => {
    const { cells } = parse(['.w.', 'wow', '###']);
    expect(countType(cells, T.WATER)).toBe(3);
    expect(countType(cells, T.OIL)).toBe(1);
    expect(liquidVolume(cells)).toBe(4);
  });

  it('measure the contiguous run above the floor, stopping at a gap', () => {
    const { cells, width, height } = parse(['w..', 'w.w', '.ww', 'www', '###']);
    // Floor is row y = 1 (the row above the wall): column 0 has a gap at y = 2.
    expect(columnLevel(cells, width, height, 0, 1)).toBe(1);
    expect(columnLevel(cells, width, height, 1, 1)).toBe(2);
    expect(columnLevel(cells, width, height, 2, 1)).toBe(3);
  });

  it('count oil on top of water in one run, and sand as a base only when asked', () => {
    const { cells, width, height } = parse(['o', 'w', 's', '#']);
    expect(columnLevel(cells, width, height, 0, 1)).toBe(0);
    expect(columnLevel(cells, width, height, 0, 1, [T.SAND, T.WATER, T.OIL])).toBe(3);
    expect(columnLevel(cells, width, height, 0, 2)).toBe(2);
  });

  it('average the level over a partly filled chamber and report its flatness', () => {
    const { cells, width, height } = parse(['....', '.ww.', 'wwww', '####']);
    const chamber = { name: 'c', x0: 0, x1: 4 };
    expect(chamberLevel(cells, width, height, chamber, 1)).toBe(1.5);
    expect(flatness(cells, width, height, chamber, 1)).toBe(1);
    expect(flatness(cells, width, height, { name: 'd', x0: 1, x1: 3 }, 1)).toBe(0);
  });

  it('count the columns where one type lies above another', () => {
    expect(columnsWithAbove(...flat(['w.o', 'o.w', '###']), T.WATER, T.OIL)).toBe(1);
    expect(columnsWithAbove(...flat(['o.o', 'w.w', '###']), T.WATER, T.OIL)).toBe(0);
    expect(columnsWithAbove(...flat(['w.w', 'o.o', '###']), T.WATER, T.OIL)).toBe(2);
  });
});
