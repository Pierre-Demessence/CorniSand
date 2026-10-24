import { PARTICLE_TYPES as T } from '../src/particles';
import type { Chamber } from '../src/scenes';

// Measurements on a packed cell grid (row y = 0 at the bottom). Levels are heights above `floorY`.

export const LIQUIDS: readonly number[] = [T.WATER, T.OIL];

export function cellTypeAt(cells: Uint32Array, width: number, x: number, y: number): number {
  return cells[y * width + x] & 0xff;
}

export function countType(cells: Uint32Array, type: number): number {
  let n = 0;
  for (const c of cells) if ((c & 0xff) === type) n++;
  return n;
}

export function liquidVolume(cells: Uint32Array): number {
  let n = 0;
  for (const c of cells) if (LIQUIDS.includes(c & 0xff)) n++;
  return n;
}

/** Height of the contiguous run of `kinds` cells that starts at the floor of column x. */
export function columnLevel(
  cells: Uint32Array,
  width: number,
  height: number,
  x: number,
  floorY: number,
  kinds: readonly number[] = LIQUIDS,
): number {
  let y = floorY;
  while (y < height && kinds.includes(cellTypeAt(cells, width, x, y))) y++;
  return y - floorY;
}

export function columnLevels(
  cells: Uint32Array,
  width: number,
  height: number,
  chamber: Chamber,
  floorY: number,
  kinds: readonly number[] = LIQUIDS,
): number[] {
  const levels: number[] = [];
  for (let x = chamber.x0; x < chamber.x1; x++) levels.push(columnLevel(cells, width, height, x, floorY, kinds));
  return levels;
}

/** Mean column level over the chamber's columns. */
export function chamberLevel(
  cells: Uint32Array,
  width: number,
  height: number,
  chamber: Chamber,
  floorY: number,
  kinds: readonly number[] = LIQUIDS,
): number {
  const levels = columnLevels(cells, width, height, chamber, floorY, kinds);
  return levels.reduce((a, b) => a + b, 0) / levels.length;
}

/** Highest minus lowest column level over the chamber. */
export function flatness(
  cells: Uint32Array,
  width: number,
  height: number,
  chamber: Chamber,
  floorY: number,
  kinds: readonly number[] = LIQUIDS,
): number {
  const levels = columnLevels(cells, width, height, chamber, floorY, kinds);
  return Math.max(...levels) - Math.min(...levels);
}

/**
 * Empty cells that are not 4-connected, through empty cells, to an empty cell of the top row. A dent open
 * to the air is not a bubble; a pocket sealed in liquid, sand or walls is.
 */
export function bubbleCount(cells: Uint32Array, width: number, height: number): number {
  const reached = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (i: number): void => {
    if (reached[i] === 0 && (cells[i] & 0xff) === T.EMPTY) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) visit((height - 1) * width + x);
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (y > 0) visit(i - width);
    if (y < height - 1) visit(i + width);
  }
  let bubbles = 0;
  for (let i = 0; i < cells.length; i++) if ((cells[i] & 0xff) === T.EMPTY && reached[i] === 0) bubbles++;
  return bubbles;
}

/** Cells of a fractional fill field that are between 5% and 95% full more than 1 cell below their column's surface. */
export function foamCount(fill: Float32Array, width: number, height: number): number {
  let foam = 0;
  for (let x = 0; x < width; x++) {
    let top = -1;
    for (let y = height - 1; y >= 0; y--) {
      if (fill[y * width + x] > 0.05) {
        top = y;
        break;
      }
    }
    for (let y = 0; y < top - 1; y++) {
      const f = fill[y * width + x];
      if (f > 0.05 && f < 0.95) foam++;
    }
  }
  return foam;
}

/**
 * Rest height of `volume` cells of liquid poured into the open columns above `floorY`. A column is open
 * from the floor up to its first wall. All columns share one level, capped by each column's open height.
 */
export function expectedLevel(cells: Uint32Array, width: number, height: number, floorY: number, volume: number): number {
  const open: number[] = [];
  for (let x = 0; x < width; x++) {
    let y = floorY;
    while (y < height && cellTypeAt(cells, width, x, y) !== T.WALL) y++;
    open.push(y - floorY);
  }
  const held = (level: number): number => open.reduce((sum, o) => sum + Math.min(level, o), 0);
  let lo = 0;
  let hi = height - floorY;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (held(mid) < volume) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
