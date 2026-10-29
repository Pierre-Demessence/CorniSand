import type { CellData } from './cell-fields';
import { ELEMENT as T } from './elements';
import { packHalf2 } from './half';
import { Canvas, packCell, tank, WALL } from './scene-canvas';
import { SCENARIO_INFO, SCENARIO_SCENES } from './scenarios';

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
  ceiling: { x0: WALL, x1: 42, y0: 18, y1: 26, temp: -50 },
  steam: { x0: WALL, x1: 42, y0: 17, y1: 18 },
};

/** A closed box of walls holding an 8-row metal ceiling at -50 °C with a row of steam at 110 °C under it (condensing takes 2,257 per cell, so the ceiling must hold a lot of cold). Steam against the cold ceiling condenses. */
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

/**
 * `explosion`: rectangles are [x0, x1) by [y0, y1). A layer of sand fills the tank to `depth`; the gunpowder pocket sits
 * inside it on a wall shelf (gunpowder is denser than sand, so a charge in the middle of the sand would sink) with a fire
 * cell against its left side, and a stone wall stands to its right, taller than the sand.
 */
export const EXPLOSION = {
  width: 256,
  height: 160,
  depth: 48,
  shelf: { x0: 94, x1: 106, y0: WALL + 28, y1: WALL + 30 },
  charge: { x0: 96, x1: 104, y0: WALL + 30, y1: WALL + 36 },
  fire: { x: 95, y: WALL + 33 },
  stone: { x0: 140, x1: 144, y0: WALL, y1: WALL + 64 },
};

/** A 48-cell gunpowder charge buried 12 cells deep in a 48-deep layer of sand in a 256x160 tank, lit by a fire cell, with a 4x64 stone wall 40 cells to its right. */
export function explosion(): Scene {
  const { width, height, depth, shelf, charge, fire, stone } = EXPLOSION;
  const canvas = tank(width, height);
  canvas.fill(T.SAND, WALL, width - WALL, WALL, WALL + depth);
  canvas.fill(T.WALL, shelf.x0, shelf.x1, shelf.y0, shelf.y1);
  canvas.fill(T.GUNPOWDER, charge.x0, charge.x1, charge.y0, charge.y1);
  canvas.fill(T.STONE, stone.x0, stone.x1, stone.y0, stone.y1);
  canvas.fire(fire.x, fire.y);
  return { name: 'explosion', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `plume`: rectangles are [x0, x1) by [y0, y1). A metal plate on the floor of a tall box with an open top, at `plate.temp`,
 * and a block of smoke on the floor to each side of it.
 */
export const PLUME = {
  width: 256,
  height: 192,
  plate: { x0: 96, x1: 160, y0: WALL, y1: WALL + 4, temp: 1000 },
  smoke: [
    { x0: 40, x1: 48, y0: WALL, y1: WALL + 8 },
    { x0: 208, x1: 216, y0: WALL, y1: WALL + 8 },
  ],
};

/** A 64x4 metal plate at 1,000 °C on the floor of a 256x192 box open at the top, with a block of smoke on the floor at each side. The plate warms the air above it, which rises in a plume. */
export function plume(): Scene {
  const { width, height, plate, smoke } = PLUME;
  const canvas = tank(width, height);
  canvas.fill(T.METAL, plate.x0, plate.x1, plate.y0, plate.y1);
  canvas.fillTemp(plate.temp, plate.x0, plate.x1, plate.y0, plate.y1);
  for (const s of smoke) canvas.fill(T.SMOKE, s.x0, s.x1, s.y0, s.y1);
  return { name: 'plume', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `mound`: a triangle of sand with a triangle of gunpowder inside it on the floor of a tank, as drawn at the M6.6 gate:
 * `base` cells wide at the floor and `height` tall, centered on the tank. Light the gunpowder at its left foot (`foot`).
 */
export const MOUND = {
  width: 640,
  height: 320,
  sand: { base: 250, height: 125 },
  gunpowder: { base: 200, height: 90 },
  foot: { x: 224, y: WALL + 2 },
};

/** A 640x320 tank holding a 250-by-125 triangle of sand over a 200-by-90 triangle of gunpowder (about 9,000 cells), both on the floor. */
export function mound(): Scene {
  const { width, height, sand, gunpowder } = MOUND;
  const canvas = tank(width, height);
  const triangle = (type: number, shape: { base: number; height: number }): void => {
    for (let row = 0; row < shape.height; row++) {
      const half = Math.round((shape.base / 2) * (1 - row / shape.height));
      canvas.fill(type, width / 2 - half, width / 2 + half, WALL + row, WALL + row + 1);
    }
  };
  triangle(T.SAND, sand);
  triangle(T.GUNPOWDER, gunpowder);
  return { name: 'mound', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `physics`: a row of walled rooms, each showing one thing the M8.8 properties change; rectangles are [x0, x1) by
 * [y0, y1) and the rooms are laid out left to right by `physicsRooms`. Every room is open at the top (the grid edge closes it).
 */
export const PHYSICS = {
  height: 100,
  /** The widths of the rooms, in the order of `PHYSICS_ROOMS`; a 2-cell wall stands between two rooms. */
  widths: { pot: 48, damWater: 64, damOil: 64, damLava: 64, sand: 64, gunpowder: 64, fire: 48, pond: 48 },
  /** Water 16 deep on an 8-row metal plate that starts at `temp` (a plate that thin holds enough heat to boil some of it). */
  pot: { plate: 8, depth: 16, temp: 700 },
  /** A column of liquid against the left wall of its room. */
  dam: { width: 14, height: 40 },
  /**
   * A hopper of grains, centered in its room: wall slopes funnel them to an `outlet`-wide opening `outletY` rows over
   * the floor, so they pour from a point and pile up under it. The hopper is `height` rows tall; its half-width grows
   * by `slope` cells per row.
   */
  hopper: { outletY: 30, height: 20, outlet: 4, slope: 0.9 },
  /** An oil pool with one lit fire cell on its surface, under a metal ceiling `ceilingY` rows over the pool. */
  fire: { oil: 6, ceilingY: 24, ceiling: 4 },
  /** Water at `temp` filling its room to a metal ceiling held at `ceilingTemp`. */
  pond: { depth: 16, temp: 10, ceiling: 6, ceilingTemp: -50 },
};

export type PhysicsRoom = keyof typeof PHYSICS.widths;

export const PHYSICS_ROOMS = Object.keys(PHYSICS.widths) as PhysicsRoom[];

/** The columns [x0, x1) inside each room of the `physics` scene, and the scene's width. */
export function physicsRooms(): { rooms: Record<PhysicsRoom, { x0: number; x1: number }>; width: number } {
  let x = WALL;
  const rooms = {} as Record<PhysicsRoom, { x0: number; x1: number }>;
  for (const name of PHYSICS_ROOMS) {
    rooms[name] = { x0: x, x1: x + PHYSICS.widths[name] };
    x += PHYSICS.widths[name] + WALL;
  }
  return { rooms, width: x };
}

/**
 * A lab of eight rooms, 100 cells tall: a pot of water on a hot plate (it boils and stirs itself), dam breaks of
 * water, oil and lava (water runs, oil is a little slower, lava creeps), a hopper of sand and one of gunpowder
 * pouring onto a pile each at its own angle, a pool of oil on fire under a metal ceiling, and a pond under a
 * freezing ceiling (it freezes from the top).
 */
export function physics(): Scene {
  const { height, pot, dam, hopper, fire, pond } = PHYSICS;
  const { rooms, width } = physicsRooms();
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  canvas.fill(T.WALL, 0, WALL, 0, height);
  for (const name of PHYSICS_ROOMS) canvas.fill(T.WALL, rooms[name].x1, rooms[name].x1 + WALL, 0, height);

  const potRoom = rooms.pot;
  canvas.fill(T.METAL, potRoom.x0, potRoom.x1, WALL, WALL + pot.plate);
  canvas.fillTemp(pot.temp, potRoom.x0, potRoom.x1, WALL, WALL + pot.plate);
  canvas.fill(T.WATER, potRoom.x0, potRoom.x1, WALL + pot.plate, WALL + pot.plate + pot.depth);

  for (const [name, type] of [['damWater', T.WATER], ['damOil', T.OIL], ['damLava', T.LAVA]] as const) {
    canvas.fill(type, rooms[name].x0, rooms[name].x0 + dam.width, WALL, WALL + dam.height);
  }

  for (const [name, type] of [['sand', T.SAND], ['gunpowder', T.GUNPOWDER]] as const) {
    const room = rooms[name];
    const center = (room.x0 + room.x1) >> 1;
    canvas.fill(T.WALL, room.x0, room.x1, WALL + hopper.outletY, WALL + hopper.outletY + hopper.height);
    for (let row = 0; row < hopper.height; row++) {
      const half = hopper.outlet / 2 + Math.floor(row * hopper.slope);
      const y = WALL + hopper.outletY + row;
      canvas.fill(type, center - half, center + half, y, y + 1);
    }
  }

  const fireRoom = rooms.fire;
  canvas.fill(T.OIL, fireRoom.x0, fireRoom.x1, WALL, WALL + fire.oil);
  canvas.fire((fireRoom.x0 + fireRoom.x1) >> 1, WALL + fire.oil);
  canvas.fill(T.METAL, fireRoom.x0, fireRoom.x1, WALL + fire.oil + fire.ceilingY, WALL + fire.oil + fire.ceilingY + fire.ceiling);

  const pondRoom = rooms.pond;
  const pondTop = WALL + pond.depth;
  canvas.fill(T.WATER, pondRoom.x0, pondRoom.x1, WALL, pondTop);
  canvas.fillTemp(pond.temp, pondRoom.x0, pondRoom.x1, WALL, pondTop);
  canvas.fill(T.METAL, pondRoom.x0, pondRoom.x1, pondTop, pondTop + pond.ceiling);
  canvas.fillTemp(pond.ceilingTemp, pondRoom.x0, pondRoom.x1, pondTop, pondTop + pond.ceiling);

  return { name: 'physics', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `showcase`: one of everything the finished look draws, side by side in a tank open at the top. Rectangles are
 * [x0, x1) by [y0, y1); the heaps are triangles of a `base` width and a `height`, centered on `x`.
 */
export const SHOWCASE = {
  width: 320,
  height: 128,
  sand: { x: 38, base: 56, height: 26 },
  /** A walled pool of water with oil on top of it. */
  pool: {
    walls: [{ x0: 72, x1: 74 }, { x0: 120, x1: 122 }],
    wallTop: WALL + 64,
    water: { x0: 74, x1: 120, y0: WALL, y1: WALL + 48 },
    oil: { x0: 74, x1: 120, y0: WALL + 48, y1: WALL + 52 },
  },
  /** Lava in a basin whose right side is a stone block. */
  lava: {
    wall: { x0: 128, x1: 130, y0: WALL, y1: WALL + 20 },
    pool: { x0: 130, x1: 170, y0: WALL, y1: WALL + 10 },
    stone: { x0: 170, x1: 190, y0: WALL, y1: WALL + 22 },
  },
  bar: { x0: 196, x1: 236, y0: WALL + 14, y1: WALL + 18, temp: 900 },
  /** A heap of gunpowder with a lit cell on its tip. */
  gunpowder: { x: 256, base: 28, height: 12 },
  /** Smoke over a hot plate. */
  plate: { x0: 280, x1: 312, y0: WALL, y1: WALL + 2, temp: 1000 },
  smoke: { x0: 290, x1: 302, y0: WALL + 2, y1: WALL + 8 },
};

/** A sand pile, a pool of water with oil on it, a lava pool beside stone, a hot metal bar, a fire on gunpowder and a plume of smoke over a hot plate, 320x128. */
export function showcase(): Scene {
  const { width, height, sand, pool, lava, bar, gunpowder, plate, smoke } = SHOWCASE;
  const canvas = tank(width, height);
  const heap = (type: number, shape: { x: number; base: number; height: number }): void => {
    for (let row = 0; row < shape.height; row++) {
      const half = Math.round((shape.base / 2) * (1 - row / shape.height));
      canvas.fill(type, shape.x - half, shape.x + half, WALL + row, WALL + row + 1);
    }
  };
  heap(T.SAND, sand);
  for (const w of pool.walls) canvas.fill(T.WALL, w.x0, w.x1, WALL, pool.wallTop);
  canvas.fill(T.WATER, pool.water.x0, pool.water.x1, pool.water.y0, pool.water.y1);
  canvas.fill(T.OIL, pool.oil.x0, pool.oil.x1, pool.oil.y0, pool.oil.y1);
  canvas.fill(T.WALL, lava.wall.x0, lava.wall.x1, lava.wall.y0, lava.wall.y1);
  canvas.fill(T.LAVA, lava.pool.x0, lava.pool.x1, lava.pool.y0, lava.pool.y1);
  canvas.fill(T.STONE, lava.stone.x0, lava.stone.x1, lava.stone.y0, lava.stone.y1);
  canvas.fill(T.METAL, bar.x0, bar.x1, bar.y0, bar.y1);
  canvas.fillTemp(bar.temp, bar.x0, bar.x1, bar.y0, bar.y1);
  heap(T.GUNPOWDER, gunpowder);
  canvas.fire(gunpowder.x, WALL + gunpowder.height);
  canvas.fill(T.METAL, plate.x0, plate.x1, plate.y0, plate.y1);
  canvas.fillTemp(plate.temp, plate.x0, plate.x1, plate.y0, plate.y1);
  canvas.fill(T.SMOKE, smoke.x0, smoke.x1, smoke.y0, smoke.y1);
  return { name: 'showcase', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
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
  explosion,
  plume,
  mound,
  physics,
  showcase,
  ...SCENARIO_SCENES,
};

/** The menu's groups in the order it lists them; the real-world scenarios come last. */
export const SCENE_GROUPS = [
  { id: 'liquids', label: 'Liquids' },
  { id: 'motion', label: 'Motion' },
  { id: 'heat', label: 'Heat' },
  { id: 'air', label: 'Air' },
  { id: 'labs', label: 'Labs' },
  { id: 'scenarios', label: 'Real-world scenarios' },
] as const;

export type SceneGroup = (typeof SCENE_GROUPS)[number]['id'];

/** What the Scenes menu shows of a scene, so that it never has to build one to read its label. */
export interface SceneInfo {
  label: string;
  group: SceneGroup;
  /** One or two sentences: what the scene is and what to watch. */
  description: string;
}

/** One entry per key of `SCENES`, in the same order (`tests/scenes.test.ts` checks both). */
export const SCENE_INFO: Record<string, SceneInfo> = {
  uTube: {
    label: 'U-tube',
    group: 'liquids',
    description: 'Two arms joined under a partition, the left one full of water. Watch the right arm: the arms do not level, because local rules carry no pressure through the passage (a known limit).',
  },
  basin: {
    label: 'Basin',
    group: 'liquids',
    description: 'A block of water at the left of a tank. Watch it flood into a flat sheet about 10 cells deep.',
  },
  damBreak: {
    label: 'Dam break',
    group: 'liquids',
    description: 'A column of water against the left wall of a tank. Watch the front run along the floor and the level settle flat.',
  },
  sandIntoPool: {
    label: 'Sand into a pool',
    group: 'liquids',
    description: 'A block of sand hangs over a pool of water. Watch it fall, sink through the water and pile on the floor.',
  },
  oilOnWater: {
    label: 'Oil on water',
    group: 'liquids',
    description: 'A block of oil hangs over a layer of water. Watch it fall and spread out, floating on top.',
  },
  pile: {
    label: 'Sand pile',
    group: 'motion',
    description: 'A wide block of sand hangs above the floor. Watch it fall, speed up and settle into a pile.',
  },
  blast: {
    label: 'Blast',
    group: 'motion',
    description: 'A layer of sand a blast has just hit: grains near the center fly up and out, then land back in piles. A large scene (1024x512).',
  },
  heatBars: {
    label: 'Heat bars',
    group: 'heat',
    description: 'A metal bar above a stone bar, both at 500 °C at the left end. Turn on the heat view (H): heat runs along the metal far faster than along the stone.',
  },
  iceLava: {
    label: 'Ice and lava',
    group: 'heat',
    description: 'A block of ice touching a pool of lava. Watch the ice melt, the water boil and the lava next to it set into stone; the heat view (H) shows the temperatures.',
  },
  steamCeiling: {
    label: 'Steam on a cold ceiling',
    group: 'heat',
    description: 'A closed box with a row of steam under a metal ceiling at -50 °C. Watch the steam condense into water against the ceiling.',
  },
  moltenMetal: {
    label: 'Molten metal',
    group: 'heat',
    description: 'A pool of molten metal at 1,600 °C on a cold metal floor. Watch the floor take the heat and the pool set back into metal.',
  },
  explosion: {
    label: 'Buried charge',
    group: 'air',
    description: 'A gunpowder charge buried in sand, with a fire cell against it and a stone wall to its right. Watch the blast throw sand and push the air; the air view (A) shows the pressure.',
  },
  plume: {
    label: 'Hot plate plume',
    group: 'air',
    description: 'A metal plate at 1,000 °C on the floor of a tall box, with a block of smoke on each side. The plate warms the air above it, which rises; the heat view (H) shows the warm air and the smoke shows the flow.',
  },
  mound: {
    label: 'Gunpowder mound',
    group: 'air',
    description: 'A triangle of gunpowder inside a triangle of sand. Light the gunpowder at its left foot with fire and watch the blast break the mound; the air view (A) shows the pressure.',
  },
  physics: {
    label: 'Physics lab',
    group: 'labs',
    description: 'Eight rooms side by side: a pot of water on a hot plate, dam breaks of water, oil and lava, hoppers of sand and gunpowder, an oil fire under a ceiling and a pond under a freezing ceiling.',
  },
  showcase: {
    label: 'Showcase',
    group: 'labs',
    description: 'One of everything the finished look draws: sand, water with oil, lava beside stone, a hot metal bar, a fire on gunpowder and smoke over a hot plate. Press C to see the cells look.',
  },
  ...SCENARIO_INFO,
};

/** The scene registered under `name`; own keys only, so `?scene=constructor` does not match. */
export function findScene(name: string): Scene | undefined {
  return Object.hasOwn(SCENES, name) ? SCENES[name]() : undefined;
}
