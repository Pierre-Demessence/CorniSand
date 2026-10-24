import { PARTICLE_TYPES as T } from '../src/particles';
import { packCell } from '../src/scenes';

const KINDS: Record<string, number> = { '.': T.EMPTY, '#': T.WALL, w: T.WATER, o: T.OIL, s: T.SAND };

/** Builds a grid from rows listed top to bottom: '.' empty, '#' wall, 'w' water, 'o' oil, 's' sand. */
export function parseGrid(rows: string[]): { cells: Uint32Array<ArrayBuffer>; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const cells = new Uint32Array(width * height);
  rows.forEach((row, i) => {
    for (let x = 0; x < width; x++) cells[(height - 1 - i) * width + x] = packCell(KINDS[row[x]]);
  });
  return { cells, width, height };
}
