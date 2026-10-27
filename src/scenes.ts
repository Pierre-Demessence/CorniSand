import { emptyCellData, tempView, type CellData } from './cell-fields';
import { ELEMENT as T, ELEMENTS, elementTemperature, type ElementDef } from './elements';
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

// The temperature a cell of this element of the default table starts at.
function startTemp(type: number): number {
  const e = (ELEMENTS as readonly ElementDef[]).find((row) => row.id === type);
  if (!e) throw new Error(`no element with id ${type}`);
  return elementTemperature(e);
}

// Every cell starts at its element's temperature, empty space included.
class Canvas {
  readonly fields: CellData;
  private readonly temps: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.fields = emptyCellData(width * height);
    this.temps = tempView(this.fields);
    this.temps.fill(startTemp(T.EMPTY));
  }

  /** Fills columns [x0, x1) and rows [y0, y1). */
  fill(type: number, x0: number, x1: number, y0: number, y1: number): void {
    const c = packCell(type);
    const temp = startTemp(type);
    for (let y = y0; y < y1; y++) {
      this.fields.kind.fill(c, y * this.width + x0, y * this.width + x1);
      this.temps.fill(temp, y * this.width + x0, y * this.width + x1);
    }
  }

  /** Sets the temperature of columns [x0, x1) and rows [y0, y1), whatever the cells there are. */
  fillTemp(temp: number, x0: number, x1: number, y0: number, y1: number): void {
    for (let y = y0; y < y1; y++) this.temps.fill(temp, y * this.width + x0, y * this.width + x1);
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

/**
 * A metal bar and a stone bar, each in a wall channel of its own, hot at the left end: the shape of the bars and the
 * rows and columns a test samples.
 */
export const HEAT_BARS = {
  width: 52,
  height: 14,
  x0: WALL,
  x1: 50,
  hotColumns: 6,
  hot: 500,
  cold: 20,
  metalY0: WALL,
  stoneY0: WALL + 4 + WALL,
  barHeight: 4,
};

/** A metal bar above a stone bar, 48x4 each, the left 6 columns at 500 °C and the rest at 20 °C. Heat crosses the metal much faster. */
export function heatBars(): Scene {
  const { width, height, x0, x1, hotColumns, hot, metalY0, stoneY0, barHeight } = HEAT_BARS;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.METAL, x0, x1, metalY0, metalY0 + barHeight);
  canvas.fill(T.STONE, x0, x1, stoneY0, stoneY0 + barHeight);
  for (const y0 of [metalY0, stoneY0]) canvas.fillTemp(hot, x0, x0 + hotColumns, y0, y0 + barHeight);
  return { name: 'heatBars', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/** `iceLava`: a block of ice on the floor beside a pool of lava, in an open-topped tank. Rectangles are [x0, x1) by [y0, y1). */
export const ICE_LAVA = {
  width: 80,
  height: 60,
  ice: { x0: WALL, x1: WALL + 10, y0: WALL, y1: WALL + 10 },
  lava: { x0: WALL + 10, x1: WALL + 40, y0: WALL, y1: WALL + 8 },
};

/** A 10x10 block of ice at the left of an 80x60 tank, touching a 30x8 pool of lava. The ice melts, the water boils, the lava touching it sets into stone. */
export function iceLava(): Scene {
  const { width, height, ice, lava } = ICE_LAVA;
  const canvas = tank(width, height);
  canvas.fill(T.ICE, ice.x0, ice.x1, ice.y0, ice.y1);
  canvas.fill(T.LAVA, lava.x0, lava.x1, lava.y0, lava.y1);
  return { name: 'iceLava', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/** `steamCeiling`: a closed wall box (40x24 inside) with a metal ceiling and a layer of steam under it. */
export const STEAM_CEILING = {
  width: 44,
  height: 28,
  ceiling: { x0: WALL, x1: 42, y0: 22, y1: 26, temp: -50 },
  steam: { x0: WALL, x1: 42, y0: 18, y1: 22 },
};

/** A closed box of walls holding a 4-row metal ceiling at -50 °C with 4 rows of steam at 110 °C under it. Steam rising against the cold ceiling condenses. */
export function steamCeiling(): Scene {
  const { width, height, ceiling, steam } = STEAM_CEILING;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.EMPTY, WALL, width - WALL, WALL, height - WALL);
  canvas.fill(T.METAL, ceiling.x0, ceiling.x1, ceiling.y0, ceiling.y1);
  canvas.fillTemp(ceiling.temp, ceiling.x0, ceiling.x1, ceiling.y0, ceiling.y1);
  canvas.fill(T.STEAM, steam.x0, steam.x1, steam.y0, steam.y1);
  return { name: 'steamCeiling', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/** `moltenMetal`: a pool of molten metal on a thick metal floor, in an open-topped tank. */
export const MOLTEN_METAL = {
  width: 40,
  height: 24,
  floor: { x0: WALL, x1: 38, y0: WALL, y1: WALL + 8 },
  pool: { x0: 10, x1: 30, y0: WALL + 8, y1: WALL + 12 },
};

/** A 20x4 pool of molten metal at 1,600 °C on an 8-row metal floor at 20 °C. The floor takes its heat and the pool sets back into metal. */
export function moltenMetal(): Scene {
  const { width, height, floor, pool } = MOLTEN_METAL;
  const canvas = tank(width, height);
  canvas.fill(T.METAL, floor.x0, floor.x1, floor.y0, floor.y1);
  canvas.fill(T.MOLTEN_METAL, pool.x0, pool.x1, pool.y0, pool.y1);
  return { name: 'moltenMetal', width, height, fields: canvas.fields, floorY: floor.y1, chambers: [] };
}

export const SCENES: Record<string, () => Scene> = {
  uTube,
  basin,
  damBreak,
  sandIntoPool,
  oilOnWater,
  pile,
  blast,
  heatBars,
  iceLava,
  steamCeiling,
  moltenMetal,
};

/** The scene registered under `name`; own keys only, so `?scene=constructor` does not match. */
export function findScene(name: string): Scene | undefined {
  return Object.hasOwn(SCENES, name) ? SCENES[name]() : undefined;
}
