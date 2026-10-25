import { PARTICLE_TYPES as T } from './particles';

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
  /** Packed cells (same layout as `cell.wgsl.ts`), row y = 0 at the bottom. */
  cells: Uint32Array<ArrayBuffer>;
  /** First open row above the floor; levels are heights above it. */
  floorY: number;
  chambers: Chamber[];
  /** Analytic rest height above the floor of the connected chambers, when the scene has one. */
  expectedLevel?: number;
}

type Liquid = typeof T.WATER | typeof T.OIL;

// Same packing as `makeCell` in `cell.wgsl.ts`.
export function packCell(type: number, variant = 0, life = 0): number {
  return (type | (variant << 8) | (life << 16)) >>> 0;
}

class Canvas {
  readonly cells: Uint32Array<ArrayBuffer>;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = new Uint32Array(width * height);
  }

  /** Fills columns [x0, x1) and rows [y0, y1). */
  fill(type: number, x0: number, x1: number, y0: number, y1: number): void {
    const c = packCell(type);
    for (let y = y0; y < y1; y++) this.cells.fill(c, y * this.width + x0, y * this.width + x1);
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

export interface UTubeOptions {
  /** Integer multiplier applied to every length. */
  scale?: number;
  /** Arm widths in cells at scale 1. */
  leftArm?: number;
  rightArm?: number;
  liquid?: Liquid;
  /** Height (exclusive, at scale 1) the left arm is filled to; the passage is always full. */
  fillTo?: number;
}

const PARTITION_WIDTH = 32;
const PASSAGE_HEIGHT = 8;
const U_TUBE_HEIGHT = 80;

/**
 * Two vertical arms joined by a passage under a partition. Both arms open at the top; the left one starts
 * filled above the passage and the right one starts empty. At scale 1 with 16-wide arms the grid is 68x80.
 */
export function uTube({ scale = 1, leftArm = 16, rightArm = 16, liquid = T.WATER, fillTo = 70 }: UTubeOptions = {}): Scene {
  const s = scale;
  const floor = 2 * s;
  const passageTop = floor + PASSAGE_HEIGHT * s;
  const leftX0 = WALL * s;
  const leftX1 = leftX0 + leftArm * s;
  const rightX0 = leftX1 + PARTITION_WIDTH * s;
  const rightX1 = rightX0 + rightArm * s;
  const width = rightX1 + WALL * s;
  const height = U_TUBE_HEIGHT * s;

  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, floor);
  canvas.fill(T.WALL, 0, leftX0, 0, height);
  canvas.fill(T.WALL, rightX1, width, 0, height);
  canvas.fill(T.WALL, leftX1, rightX0, passageTop, height);
  canvas.fill(liquid, leftX0, rightX1, floor, passageTop);
  canvas.fill(liquid, leftX0, leftX1, passageTop, fillTo * s);

  const passageVolume = (width - 2 * WALL * s) * (passageTop - floor);
  const volume = passageVolume + leftArm * s * (fillTo * s - passageTop);
  const armColumns = (leftArm + rightArm) * s;
  const partitionVolume = PARTITION_WIDTH * s * (passageTop - floor);

  return {
    name: 'uTube',
    width,
    height,
    cells: canvas.cells,
    floorY: floor,
    chambers: [
      { name: 'left', x0: leftX0, x1: leftX1 },
      { name: 'right', x0: rightX0, x1: rightX1 },
    ],
    expectedLevel: (volume - partitionVolume) / armColumns,
  };
}

const BASIN_WIDTH = 200;
const BASIN_HEIGHT = 60;

function basinScene(name: string, blockWidth: number, blockHeight: number): Scene {
  const canvas = tank(BASIN_WIDTH, BASIN_HEIGHT);
  canvas.fill(T.WATER, WALL, WALL + blockWidth, WALL, WALL + blockHeight);
  const interior = BASIN_WIDTH - 2 * WALL;
  return {
    name,
    width: BASIN_WIDTH,
    height: BASIN_HEIGHT,
    cells: canvas.cells,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: BASIN_WIDTH - WALL }],
    expectedLevel: (blockWidth * blockHeight) / interior,
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

/** A 20x20 chamber completely full of water inside a closed box: there is no free surface. */
export function sealedChamber(): Scene {
  const size = 24;
  const canvas = new Canvas(size, size);
  canvas.fill(T.WALL, 0, size, 0, size);
  canvas.fill(T.WATER, WALL, size - WALL, WALL, size - WALL);
  return { name: 'sealedChamber', width: size, height: size, cells: canvas.cells, floorY: WALL, chambers: [] };
}

/** One water cell resting on the floor of a 40x20 tank. */
export function droplet(): Scene {
  const canvas = tank(40, 20);
  canvas.fill(T.WATER, 20, 21, WALL, WALL + 1);
  return { name: 'droplet', width: 40, height: 20, cells: canvas.cells, floorY: WALL, chambers: [] };
}

/** A one-cell-thick film, 40 wide, on the floor of a 60x20 tank. */
export function film(): Scene {
  const canvas = tank(60, 20);
  canvas.fill(T.WATER, 10, 50, WALL, WALL + 1);
  return { name: 'film', width: 60, height: 20, cells: canvas.cells, floorY: WALL, chambers: [] };
}

export const SAND_POOL = { sandSize: 10, sandX: 35, poolDepth: 20 };

/** A 76x20 pool of water in an 80x60 tank with a 10x10 block of sand hanging above it. */
export function sandIntoPool(): Scene {
  const { sandSize, sandX, poolDepth } = SAND_POOL;
  const width = 80;
  const canvas = tank(width, 60);
  canvas.fill(T.WATER, WALL, width - WALL, WALL, WALL + poolDepth);
  canvas.fill(T.SAND, sandX, sandX + sandSize, 35, 35 + sandSize);
  const interior = width - 2 * WALL;
  return {
    name: 'sandIntoPool',
    width,
    height: 60,
    cells: canvas.cells,
    floorY: WALL,
    chambers: [{ name: 'pool', x0: WALL, x1: width - WALL }],
    expectedLevel: (interior * poolDepth + sandSize * sandSize) / interior,
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
    cells: canvas.cells,
    floorY: WALL,
    chambers: [{ name: 'tank', x0: WALL, x1: width - WALL }],
  };
}

export const SCENES: Record<string, () => Scene> = {
  uTube,
  uTubeLarge: () => uTube({ scale: 3 }),
  uTubeUnequal: () => uTube({ leftArm: 8, rightArm: 32 }),
  uTubeOil: () => uTube({ liquid: T.OIL }),
  basin,
  damBreak,
  sealedChamber,
  droplet,
  film,
  sandIntoPool,
  oilOnWater,
};

/** The scene registered under `name`; own keys only, so `?scene=constructor` does not match. */
export function findScene(name: string): Scene | undefined {
  return Object.hasOwn(SCENES, name) ? SCENES[name]() : undefined;
}
