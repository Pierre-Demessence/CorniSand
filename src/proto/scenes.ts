import { PARTICLE_TYPES as T } from '../particles';
import { mulberry32 } from '../random';
import type { SourceRect } from './movement';

// Scenes of the M4.1 movement prototype: P1-P3 measure the physics in a tank, T1-T3 the cost at screen size.

export interface Blast {
  x: number;
  y: number;
  radius: number;
  speed: number;
}

export interface ProtoScene {
  name: string;
  width: number;
  height: number;
  cells: Uint32Array<ArrayBuffer>;
  source?: SourceRect;
  wind?: [number, number];
  // Applied once, right after loading.
  blast?: Blast;
  // Supersteps after which the scene's metric is taken.
  supersteps: number;
}

export const WALL_THICKNESS = 2;
const SAND = T.SAND;
const WALL = T.WALL;

function fill(cells: Uint32Array, width: number, type: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) cells.fill(type, y * width + x0, y * width + x1);
}

// Walls on both sides and a floor, WALL_THICKNESS cells thick; the grid edge closes the top.
export function tank(width: number, height: number): Uint32Array<ArrayBuffer> {
  const cells = new Uint32Array(width * height);
  fill(cells, width, WALL, 0, WALL_THICKNESS, 0, height);
  fill(cells, width, WALL, width - WALL_THICKNESS, width, 0, height);
  fill(cells, width, WALL, 0, width, 0, WALL_THICKNESS);
  return cells;
}

// P1: sand poured from a 4-cell source at the top center, then left to settle; the metric is the pile angle.
export function pourScene(width = 1024, height = 512, pour = 2000, settle = 500): ProtoScene & { pourSupersteps: number } {
  const x0 = Math.floor(width / 2) - 2;
  return {
    name: 'pour', width, height, cells: tank(width, height),
    source: { x0, x1: x0 + 4, y: height - 3 },
    supersteps: pour + settle, pourSupersteps: pour,
  };
}

// P2: a sand layer hit by a blast centered half its radius under the middle of the surface, so the grains above the
// center are thrown up and out; the metric is how far the pushed grains fly.
export function blastScene(width = 1024, height = 512, depth = 100, radius = 32, speed = 8, supersteps = 120): ProtoScene {
  const cells = tank(width, height);
  const top = WALL_THICKNESS + depth;
  fill(cells, width, SAND, WALL_THICKNESS, width - WALL_THICKNESS, WALL_THICKNESS, top);
  return { name: 'blast', width, height, cells, blast: { x: width / 2, y: top - radius / 2, radius, speed }, supersteps };
}

// P3: wind over a sand layer whose top two rows are half full (seeded), so loose grains have somewhere to go; the
// metric is the shift of the grains' horizontal center of mass.
export function windScene(width = 1024, height = 512, depth = 10, supersteps = 400, seed = 7): ProtoScene {
  const cells = tank(width, height);
  const top = WALL_THICKNESS + depth;
  fill(cells, width, SAND, WALL_THICKNESS, width - WALL_THICKNESS, WALL_THICKNESS, top - 2);
  const random = mulberry32(seed);
  for (let y = top - 2; y < top; y++) {
    for (let x = WALL_THICKNESS; x < width - WALL_THICKNESS; x++) {
      if (random() & 1) cells[y * width + x] = SAND;
    }
  }
  return { name: 'wind', width, height, cells, wind: [1 / 64, 1 / 256], supersteps };
}

// T1: every cell sand, at rest.
export function fullScene(width: number, height: number): ProtoScene {
  return { name: 'full', width, height, cells: new Uint32Array(width * height).fill(SAND), supersteps: 0 };
}

// T2: the top half sand over an empty bottom half.
export function topHalfScene(width: number, height: number): ProtoScene {
  const cells = new Uint32Array(width * height);
  fill(cells, width, SAND, 0, width, Math.floor(height / 2), height);
  return { name: 'top half', width, height, cells, supersteps: 0 };
}

// T3's ground: the bottom half sand, the top half empty.
export function bottomHalfScene(width: number, height: number): ProtoScene {
  const cells = new Uint32Array(width * height);
  fill(cells, width, SAND, 0, width, 0, Math.floor(height / 2));
  return { name: 'bottom half', width, height, cells, supersteps: 0 };
}
