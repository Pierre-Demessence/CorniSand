import { emptyCellData, type CellData } from './cell-fields';
import { ELEMENT as T } from './elements';
import { packHalf2 } from './half';

// Columns [x0, x1) whose liquid is expected to settle at one shared level.
export interface Chamber {
  name: string;
  x0: number;
  x1: number;
}

export interface Scene {
  name: string;
  width: number;
  height: number;
  /** Every cell field, row y = 0 at the bottom. */
  fields: CellData;
  /** First open row above the floor; levels are heights above it. */
  floorY: number;
  chambers: Chamber[];
}

// The `kind` word, packed as `makeCell` in `cell.wgsl.ts` does.
export function packCell(type: number, variant = 0): number {
  return (type | (variant << 8)) >>> 0;
}

class Canvas {
  readonly fields: CellData;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.fields = emptyCellData(width * height);
  }

  /** Fills columns [x0, x1) and rows [y0, y1). */
  fill(type: number, x0: number, x1: number, y0: number, y1: number): void {
    const c = packCell(type);
    for (let y = y0; y < y1; y++) this.fields.kind.fill(c, y * this.width + x0, y * this.width + x1);
  }
}

const WALL = 2;

// Open-topped basin: 2-cell walls on both sides and a 2-cell floor. The grid edge closes the top.
function tank(width: number, height: number): Canvas {
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, WALL, 0, height);
  canvas.fill(T.WALL, width - WALL, width, 0, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  return canvas;
}

const PARTITION_WIDTH = 32;
const PASSAGE_HEIGHT = 8;
const U_TUBE_HEIGHT = 80;
const ARM_WIDTH = 16;
const FILL_TO = 70;

/**
 * Two vertical arms joined by a passage under a partition, 68x80. Both arms open at the top; the left one starts
 * filled above the passage and the right one starts empty. Liquid cells move by local rules, which cannot carry a
 * pressure difference through the passage, so the arms do not level (backlog I10).
 */
export function uTube(): Scene {
  const floor = 2;
  const passageTop = floor + PASSAGE_HEIGHT;
  const leftX0 = WALL;
  const leftX1 = leftX0 + ARM_WIDTH;
  const rightX0 = leftX1 + PARTITION_WIDTH;
  const rightX1 = rightX0 + ARM_WIDTH;
  const width = rightX1 + WALL;

  const canvas = new Canvas(width, U_TUBE_HEIGHT);
  canvas.fill(T.WALL, 0, width, 0, floor);
  canvas.fill(T.WALL, 0, leftX0, 0, U_TUBE_HEIGHT);
  canvas.fill(T.WALL, rightX1, width, 0, U_TUBE_HEIGHT);
  canvas.fill(T.WALL, leftX1, rightX0, passageTop, U_TUBE_HEIGHT);
  canvas.fill(T.WATER, leftX0, rightX1, floor, passageTop);
  canvas.fill(T.WATER, leftX0, leftX1, passageTop, FILL_TO);

  return {
    name: 'uTube',
    width,
    height: U_TUBE_HEIGHT,
    fields: canvas.fields,
    floorY: floor,
    chambers: [
      { name: 'left', x0: leftX0, x1: leftX1 },
      { name: 'right', x0: rightX0, x1: rightX1 },
    ],
  };
}

const BASIN_WIDTH = 200;
const BASIN_HEIGHT = 60;

function basinScene(name: string, blockWidth: number, blockHeight: number): Scene {
  const canvas = tank(BASIN_WIDTH, BASIN_HEIGHT);
  canvas.fill(T.WATER, WALL, WALL + blockWidth, WALL, WALL + blockHeight);
  return {
    name,
    width: BASIN_WIDTH,
    height: BASIN_HEIGHT,
    fields: canvas.fields,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: BASIN_WIDTH - WALL }],
  };
}

/** A 40x49 block of water at the left end of a 200x60 tank. It floods to a flat sheet of height 10. */
export function basin(): Scene {
  return basinScene('basin', 40, 49);
}

/** A 30x40 water column against the left wall of a 200x60 tank. */
export function damBreak(): Scene {
  return basinScene('damBreak', 30, 40);
}

export const SAND_POOL = { sandSize: 10, sandX: 35, poolDepth: 20 };

/** A 76x20 pool of water in an 80x60 tank with a 10x10 block of sand hanging above it. */
export function sandIntoPool(): Scene {
  const { sandSize, sandX, poolDepth } = SAND_POOL;
  const width = 80;
  const canvas = tank(width, 60);
  canvas.fill(T.WATER, WALL, width - WALL, WALL, WALL + poolDepth);
  canvas.fill(T.SAND, sandX, sandX + sandSize, 35, 35 + sandSize);
  return {
    name: 'sandIntoPool',
    width,
    height: 60,
    fields: canvas.fields,
    floorY: WALL,
    chambers: [{ name: 'pool', x0: WALL, x1: width - WALL }],
  };
}

/** A 56x15 layer of water in a 60x40 tank with a 20x6 block of oil hanging above it. */
export function oilOnWater(): Scene {
  const width = 60;
  const canvas = tank(width, 40);
  canvas.fill(T.WATER, WALL, width - WALL, WALL, WALL + 15);
  canvas.fill(T.OIL, 20, 40, 25, 31);
  return {
    name: 'oilOnWater',
    width,
    height: 40,
    fields: canvas.fields,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: width - WALL }],
  };
}

/** A 120x30 block of sand hanging 50 cells over the floor of a 200x120 tank. It falls, speeds up and piles. */
export function pile(): Scene {
  const width = 200;
  const height = 120;
  const canvas = tank(width, height);
  canvas.fill(T.SAND, 40, 160, WALL + 50, WALL + 80);
  return {
    name: 'pile',
    width,
    height,
    fields: canvas.fields,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: width - WALL }],
  };
}

/** The variant bit `blast` sets on every grain it throws, so a test can follow them. */
export const BLAST_MARK = 1;

export const BLAST = { width: 1024, height: 512, depth: 100, radius: 32, speed: 8 };

/** The blast's center: half a radius under the middle of the sand surface. */
export const BLAST_CENTER = { x: BLAST.width / 2, y: WALL + BLAST.depth - BLAST.radius / 2 };

/**
 * A 100-deep layer of sand in a 1024x512 tank, already hit by a blast: every grain within 32 cells of the center
 * starts with a velocity pointing away from it, 8 cells per step at the center falling to 0 at the edge. The grains
 * above the center fly up and out, then land back in piles.
 */
export function blast(): Scene {
  const { width, height, depth, radius, speed } = BLAST;
  const canvas = tank(width, height);
  canvas.fill(T.SAND, WALL, width - WALL, WALL, WALL + depth);
  const { kind, velocity } = canvas.fields;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (kind[i] !== packCell(T.SAND)) continue;
      const dx = x + 0.5 - BLAST_CENTER.x;
      const dy = y + 0.5 - BLAST_CENTER.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= radius) continue;
      const push = dist > 0 ? (speed * (1 - dist / radius)) / dist : 0;
      kind[i] = packCell(T.SAND, BLAST_MARK);
      velocity[i] = packHalf2(dx * push, dist > 0 ? dy * push : speed);
    }
  }
  return { name: 'blast', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

export const SCENES: Record<string, () => Scene> = {
  uTube,
  basin,
  damBreak,
  sandIntoPool,
  oilOnWater,
  pile,
  blast,
};

/** The scene registered under `name`; own keys only, so `?scene=constructor` does not match. */
export function findScene(name: string): Scene | undefined {
  return Object.hasOwn(SCENES, name) ? SCENES[name]() : undefined;
}
