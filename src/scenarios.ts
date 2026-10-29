import { ELEMENT as T } from './elements';
import { Canvas, WALL } from './scene-canvas';
import type { Scene } from './scenes';

// The scenario scenes (`?scene=<name>`), each built from `scene-canvas.ts`'s primitives and registered here by
// the item that adds the scenario; `SCENES` spreads them in. A type-only import keeps `scenes.ts` free of a cycle.
// Each scene sets its own temperatures, so `tests/scenes.test.ts` leaves them out of the element-temperature check.

/** The temperature water is at the boil and ice at the melt, physically: the rows' thresholds. */
const BOIL = 100;
const MELT = 0;

/**
 * `iceCup`: ice at 0 °C in water at 20 °C, 1 part ice to 9 by mass, in a sealed insulated cup. A cell is one unit of
 * matter, so a cup of 25x40 cells holds 100 ice and 900 water. The cup is full and walled in WALL, which holds no
 * heat, so nothing leaves it: the cup ends at the temperature a heat balance gives (10.0 °C). `fast` is chips, one ice
 * cell in ten spread through the cup; `full` is one cube against the top; the cup has no flow to stir it, so it evens out slowly (backlog B15).
 */
export const ICE_CUP = {
  cupWidth: 25,
  cupHeight: 40,
  iceTemp: MELT,
  waterTemp: 20,
  chipsEveryX: 5,
  chipsEveryY: 2,
  chipsOffsetX: 2,
  cube: { x0: 7, size: 10, top: 40 },
} as const;

export type IceCupVersion = 'fast' | 'full';

export function iceCup(version: IceCupVersion = 'full'): Scene {
  const { cupWidth, cupHeight, iceTemp, waterTemp, chipsEveryX, chipsEveryY, chipsOffsetX, cube } = ICE_CUP;
  const width = cupWidth + 2 * WALL;
  const height = cupHeight + 2 * WALL;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.WATER, WALL, WALL + cupWidth, WALL, WALL + cupHeight);
  canvas.fillTemp(waterTemp, WALL, WALL + cupWidth, WALL, WALL + cupHeight);

  if (version === 'full') {
    const x0 = WALL + cube.x0;
    const y1 = WALL + cube.top;
    canvas.fill(T.ICE, x0, x0 + cube.size, y1 - cube.size, y1);
    canvas.fillTemp(iceTemp, x0, x0 + cube.size, y1 - cube.size, y1);
  } else {
    for (let y = 0; y < cupHeight; y += chipsEveryY) {
      for (let x = chipsOffsetX; x < cupWidth; x += chipsEveryX) {
        canvas.fill(T.ICE, WALL + x, WALL + x + 1, WALL + y, WALL + y + 1);
        canvas.fillTemp(iceTemp, WALL + x, WALL + x + 1, WALL + y, WALL + y + 1);
      }
    }
  }
  return { name: 'iceCup', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `steamBurn`: the same mass of steam or of boiling water, at 100 °C, sealed inside a cold steel box, so the condensate
 * stays against the steel. The box is 10x11 cells of which a cavity of 2x5 holds the 10 steam (or water) cells: 100
 * METAL cells at 20 °C around it, and WALL beyond, which holds no heat. The cavity is full, so nothing moves out.
 */
export const STEAM_BURN = {
  boxWidth: 10,
  boxHeight: 11,
  cavity: { x0: 4, x1: 6, y0: 3, y1: 8 },
  fillTemp: BOIL,
  boxTemp: 20,
} as const;

export type SteamBurnFill = 'steam' | 'water';

export function steamBurn(fill: SteamBurnFill = 'steam'): Scene {
  const { boxWidth, boxHeight, cavity, fillTemp, boxTemp } = STEAM_BURN;
  const width = boxWidth + 2 * WALL;
  const height = boxHeight + 2 * WALL;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.METAL, WALL, WALL + boxWidth, WALL, WALL + boxHeight);
  canvas.fillTemp(boxTemp, WALL, WALL + boxWidth, WALL, WALL + boxHeight);
  const [x0, x1, y0, y1] = [WALL + cavity.x0, WALL + cavity.x1, WALL + cavity.y0, WALL + cavity.y1];
  canvas.fill(fill === 'steam' ? T.STEAM : T.WATER, x0, x1, y0, y1);
  canvas.fillTemp(fillTemp, x0, x1, y0, y1);
  return { name: 'steamBurn', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `contactTemp`: a steel block at 80 °C pressed against a granite block at 20 °C, a bar left to right. Their contact
 * face jumps at once to the mean of their temperatures weighted by their effusivities and stays there until the heat
 * reaches a far end. The rows are `height` identical rows, so the heat runs along x only; the grid edge holds no heat.
 */
export const CONTACT_TEMP = {
  steelCells: 100,
  stoneCells: 60,
  height: 8,
  steelTemp: 80,
  stoneTemp: 20,
} as const;

export function contactTemp(): Scene {
  const { steelCells, stoneCells, height, steelTemp, stoneTemp } = CONTACT_TEMP;
  const width = steelCells + stoneCells;
  const canvas = new Canvas(width, height);
  canvas.fill(T.METAL, 0, steelCells, 0, height);
  canvas.fillTemp(steelTemp, 0, steelCells, 0, height);
  canvas.fill(T.STONE, steelCells, width, 0, height);
  canvas.fillTemp(stoneTemp, steelCells, width, 0, height);
  return { name: 'contactTemp', width, height, fields: canvas.fields, floorY: 0, chambers: [] };
}

export const SCENARIO_SCENES: Record<string, () => Scene> = {
  iceCup: () => iceCup('full'),
  steamBurn: () => steamBurn('steam'),
  contactTemp,
};
