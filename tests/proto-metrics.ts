import { PARTICLE_TYPES as T } from '../src/particles';
import type { MovementProto, ProtoFlyer } from '../src/proto/movement';
import { BLAST_MARK } from '../src/proto/params';
import { WALL_THICKNESS } from '../src/proto/scenes';

// Measurements of the M4.1 movement prototype on read-back state (docs/plans/m4-element-engine.md, scenes P1-P3).

export interface Grain {
  x: number;
  y: number;
  marked: boolean;
}

// Every grain, in the grid (at its cell center) and in flight.
export function grains(cells: Uint32Array, width: number, flyers: ProtoFlyer[]): Grain[] {
  const out: Grain[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if ((c & 0xff) !== T.SAND) continue;
    out.push({ x: (i % width) + 0.5, y: Math.floor(i / width) + 0.5, marked: ((c >> 8) & BLAST_MARK) !== 0 });
  }
  for (const f of flyers) out.push({ x: f.x, y: f.y, marked: ((f.cell >> 8) & BLAST_MARK) !== 0 });
  return out;
}

export async function readGrains(proto: MovementProto): Promise<Grain[]> {
  return grains(await proto.readCells(), proto.width, await proto.readFlyers());
}

export function countSand(cells: Uint32Array): number {
  let n = 0;
  for (const c of cells) if ((c & 0xff) === T.SAND) n++;
  return n;
}

// Grains in the grid plus flyers in the air.
export async function grainCount(proto: MovementProto): Promise<number> {
  return countSand(await proto.readCells()) + (await proto.readStats()).live;
}

function slope(points: [number, number][]): number {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  return sxy / sxx;
}

// P1: least-squares slope of the column heights (sand cells per column) on each flank of the peak, between 10% and
// 90% of the peak height, in degrees, both flanks averaged.
export function pileAngle(cells: Uint32Array, width: number, height: number): number {
  const heights: number[] = [];
  for (let x = WALL_THICKNESS; x < width - WALL_THICKNESS; x++) {
    let h = 0;
    for (let y = 0; y < height; y++) if ((cells[y * width + x] & 0xff) === T.SAND) h++;
    heights.push(h);
  }
  const peak = Math.max(...heights);
  const peakAt = heights.indexOf(peak);
  const flank = (from: number, to: number): [number, number][] => {
    const points: [number, number][] = [];
    for (let i = from; i < to; i++) {
      if (heights[i] >= 0.1 * peak && heights[i] <= 0.9 * peak) points.push([i, heights[i]]);
    }
    return points;
  };
  const angles = [flank(0, peakAt), flank(peakAt + 1, heights.length)]
    .filter((points) => points.length >= 2)
    .map((points) => (Math.atan(Math.abs(slope(points))) * 180) / Math.PI);
  return angles.reduce((s, a) => s + a, 0) / angles.length;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// P2: the 99th-percentile distance from the blast center of the marked grains.
export function debrisDistance(all: Grain[], cx: number, cy: number): number {
  return percentile(all.filter((g) => g.marked).map((g) => Math.hypot(g.x - cx, g.y - cy)), 0.99);
}

// P3: the grains' horizontal center of mass.
export function centerOfMassX(all: Grain[]): number {
  return all.reduce((s, g) => s + g.x, 0) / all.length;
}
