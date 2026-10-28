import { AIR } from '../src/air';
import type { AirData } from '../src/air-grid';
import { ELEMENT as T, elementHeatCapacity, elementHoldsHeat, transitionLatent, type ElementDef } from '../src/elements';
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

/**
 * The heat each element holds on top of its capacity times its stored temperature, so that a phase change moves no heat:
 * for A above -> B at T with latent heat L, B holds A's offset plus (C_A - C_B)·T + L (below -> B: minus L). One offset
 * per group of elements joined by transitions, 0 for the first of its group; elements that hold no heat have none.
 */
export function latentOffsets(table: readonly ElementDef[]): Map<number, number> {
  const byKey = new Map(table.map((e) => [e.key, e]));
  // Each transition as an edge a -> b with the offset b has over a, walked both ways.
  const edges: { from: number; to: number; delta: number }[] = [];
  for (const a of table) {
    for (const [side, sign] of [['above', 1], ['below', -1]] as const) {
      const t = a[side];
      if (!t) continue;
      const b = byKey.get(t.becomes)!;
      const delta = (elementHeatCapacity(a) - elementHeatCapacity(b)) * t.temp + sign * transitionLatent(t);
      edges.push({ from: a.id, to: b.id, delta }, { from: b.id, to: a.id, delta: -delta });
    }
  }
  const offsets = new Map<number, number>();
  for (const start of table) {
    if (!elementHoldsHeat(start) || offsets.has(start.id)) continue;
    offsets.set(start.id, 0);
    const queue = [start.id];
    for (const id of queue) {
      for (const edge of edges) {
        if (edge.from !== id || offsets.has(edge.to)) continue;
        offsets.set(edge.to, offsets.get(id)! + edge.delta);
        queue.push(edge.to);
      }
    }
  }
  return offsets;
}

/**
 * The heat of the cells that hold heat: the sum of heat capacity times stored temperature plus the latent offset of the
 * element (see `latentOffsets`) over the cells of the grid and the flyers in the air (`kind` and `temp` words), and, when
 * `air` is given (`Simulation.air.read()` and the air cell size), the air's heat capacity times its temperature over
 * every air cell.
 */
export function heatContent(
  table: readonly ElementDef[],
  grid: { kind: Uint32Array; temp: Uint32Array },
  flyers: readonly { cell: { kind: number; temp: number } }[] = [],
  air?: { data: AirData; cellSize: number },
): number {
  const capacity = new Map<number, number>();
  for (const e of table) if (elementHoldsHeat(e)) capacity.set(e.id, elementHeatCapacity(e));
  const offsets = latentOffsets(table);
  const bits = new Uint32Array(1);
  const asFloat = new Float32Array(bits.buffer);
  const heat = (kind: number, temp: number): number => {
    const c = capacity.get(kind & 0xff);
    if (c === undefined) return 0;
    bits[0] = temp;
    return c * asFloat[0] + offsets.get(kind & 0xff)!;
  };
  let total = 0;
  for (let i = 0; i < grid.kind.length; i++) total += heat(grid.kind[i], grid.temp[i]);
  for (const f of flyers) total += heat(f.cell.kind, f.cell.temp);
  if (air) {
    const capacity = AIR.heatCapacity * air.cellSize * air.cellSize;
    for (const t of air.data.temperature) total += capacity * t;
  }
  return total;
}

/** The height above `floorY` of the highest cell of `kind` in each column, 0 for a column without one. */
export function columnTops(cells: Uint32Array, width: number, height: number, floorY: number, kind: number): number[] {
  const tops: number[] = [];
  for (let x = 0; x < width; x++) {
    let top = 0;
    for (let y = floorY; y < height; y++) if (cellTypeAt(cells, width, x, y) === kind) top = y - floorY + 1;
    tops.push(top);
  }
  return tops;
}

/**
 * The slope of a pile in degrees: from the highest column, a least-squares line through each side's column tops between
 * 25% and 80% of the apex height (the apex and the foot are rounded), and the mean of the two sides' angles.
 */
export function pileAngle(tops: readonly number[]): number {
  const apex = Math.max(...tops);
  const center = tops.indexOf(apex);
  const angles: number[] = [];
  for (const direction of [-1, 1]) {
    const points: [number, number][] = [];
    for (let x = center + direction; x >= 0 && x < tops.length && tops[x] > 0; x += direction) {
      if (tops[x] >= 0.25 * apex && tops[x] <= 0.8 * apex) points.push([Math.abs(x - center), tops[x]]);
    }
    if (points.length < 3) throw new Error(`the pile has no slope on the ${direction < 0 ? 'left' : 'right'}`);
    const meanX = points.reduce((sum, [d]) => sum + d, 0) / points.length;
    const meanY = points.reduce((sum, [, h]) => sum + h, 0) / points.length;
    const slope = points.reduce((sum, [d, h]) => sum + (d - meanX) * (h - meanY), 0) / points.reduce((sum, [d]) => sum + (d - meanX) ** 2, 0);
    angles.push((Math.atan(-slope) * 180) / Math.PI);
  }
  return (angles[0] + angles[1]) / 2;
}
