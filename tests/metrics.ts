import { ELEMENT as T } from '../src/elements';
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

/** Columns where a cell of `upper` lies above a cell of `lower`. */
export function columnsWithAbove(cells: Uint32Array, width: number, height: number, upper: number, lower: number): number {
  let columns = 0;
  for (let x = 0; x < width; x++) {
    let lowerSeen = false;
    for (let y = 0; y < height; y++) {
      const type = cellTypeAt(cells, width, x, y);
      if (type === lower) lowerSeen = true;
      else if (type === upper && lowerSeen) {
        columns++;
        break;
      }
    }
  }
  return columns;
}
