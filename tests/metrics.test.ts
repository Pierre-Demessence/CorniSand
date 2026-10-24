import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { parseGrid as parse } from './ascii';
import {
  bubbleCount,
  chamberLevel,
  columnLevel,
  countType,
  expectedLevel,
  flatness,
  foamCount,
  liquidVolume,
} from './metrics';

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

  it('count a sealed pocket as a bubble but not a dent open to the air', () => {
    const open = parse(['.....', 'ww.ww', 'wwwww', '#####']);
    expect(bubbleCount(open.cells, open.width, open.height)).toBe(0);

    const sealed = parse(['.....', 'wwwww', 'ww.ww', 'wwwww', '#####']);
    expect(bubbleCount(sealed.cells, sealed.width, sealed.height)).toBe(1);

    const channel = parse(['..w..', '..w..', 'ww.ww', 'wwwww', '#####']);
    expect(bubbleCount(channel.cells, channel.width, channel.height)).toBe(1);
  });

  it('count cells between 5% and 95% full only when they sit more than one cell below the surface', () => {
    const width = 1;
    const height = 6;
    // Surface cell (y = 4) and the one under it (y = 3) are exempt; y = 1 is foam.
    const fill = Float32Array.from([1, 0.5, 1, 0.5, 0.5, 0]);
    expect(foamCount(fill, width, height)).toBe(1);
    expect(foamCount(Float32Array.from([1, 1, 1, 0.5, 0, 0]), width, height)).toBe(0);
    expect(foamCount(Float32Array.from([1, 0.02, 1, 0.5, 1, 0]), width, height)).toBe(0);
  });

  it('derive the rest level from the volume and the open column heights', () => {
    const { cells, width, height } = parse([
      '#.##.#',
      '#.##.#',
      '#....#',
      '######',
    ]);
    // Floor y = 1. Columns 1 and 4 are 3 tall, columns 2 and 3 are 1 tall (a passage under a partition).
    expect(expectedLevel(cells, width, height, 1, 4)).toBeCloseTo(1, 6);
    expect(expectedLevel(cells, width, height, 1, 6)).toBeCloseTo(2, 6);
    expect(expectedLevel(cells, width, height, 1, 100)).toBeCloseTo(3, 6);
  });
});
