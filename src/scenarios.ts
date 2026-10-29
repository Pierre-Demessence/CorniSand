import { ELEMENT as T } from './elements';
import { Canvas, packCell, tank, WALL } from './scene-canvas';
import type { Scene, SceneInfo } from './scenes';

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

/**
 * `redHotBar`: a steel bar 16x16 cells (2.2 cm square) at 1,000 °C hanging in still room air, in a box 96 cells wide and
 * 128 high that is open at the top, so the bar loses heat through its four sides, as a long bar does. The bar's cells
 * are aligned to the air's 4x4 cells.
 */
export const RED_HOT_BAR = {
  boxWidth: 96,
  boxHeight: 128,
  side: 16,
  x0: 40,
  y0: 24,
  temp: 1000,
} as const;

export function redHotBar(): Scene {
  const { boxWidth, boxHeight, side, x0, y0, temp } = RED_HOT_BAR;
  const canvas = new Canvas(boxWidth, boxHeight);
  canvas.fill(T.WALL, 0, WALL, 0, boxHeight);
  canvas.fill(T.WALL, boxWidth - WALL, boxWidth, 0, boxHeight);
  canvas.fill(T.WALL, 0, boxWidth, 0, WALL);
  canvas.fill(T.METAL, x0, x0 + side, y0, y0 + side);
  canvas.fillTemp(temp, x0, x0 + side, y0, y0 + side);
  return { name: 'redHotBar', width: boxWidth, height: boxHeight, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `lavaCrust`: a pool of lava open to still room air, in a box of WALL (floor and sides hold no heat) with `airHeight`
 * rows of air above it. The crust is the run of STONE cells that grows down from the surface. The lava starts at
 * `lavaTemp`.
 */
export const LAVA_CRUST = {
  poolWidth: 64,
  poolDepth: 80,
  airHeight: 34,
  lavaTemp: 1300,
} as const;

export function lavaCrust(lavaTemp: number = LAVA_CRUST.lavaTemp): Scene {
  const { poolWidth, poolDepth, airHeight } = LAVA_CRUST;
  const width = poolWidth + 2 * WALL;
  const height = WALL + poolDepth + airHeight;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, WALL, 0, height);
  canvas.fill(T.WALL, width - WALL, width, 0, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  canvas.fill(T.LAVA, WALL, WALL + poolWidth, WALL, WALL + poolDepth);
  canvas.fillTemp(lavaTemp, WALL, WALL + poolWidth, WALL, WALL + poolDepth);
  return { name: 'lavaCrust', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `heatedLayer`: a layer of water between two METAL plates (`plateRows` rows each, so that a plate's temperature drifts by
 * a fraction of the difference over minutes), the lower one warmer than the upper by `delta`, centred on `mean`, in WALL
 * sides `width` cells apart. The layer starts with conduction's straight-line profile between the plates. `above` is a
 * layer well above the threshold of convection (8 cells and 2 °C: a Rayleigh number of 36,780), `below` one under it
 * (3 cells and 1 °C: 970). `liquid` is the element of the layer, for a test that swaps in another.
 */
export const HEATED_LAYER = {
  width: 64,
  plateRows: 70,
  mean: 20,
  above: { depth: 8, delta: 2 },
  below: { depth: 3, delta: 1 },
} as const;

export type HeatedLayerKind = 'above' | 'below';

export function heatedLayer(kind: HeatedLayerKind = 'above', liquid: number = T.WATER): Scene {
  const { width: layerWidth, plateRows, mean } = HEATED_LAYER;
  const { depth, delta } = HEATED_LAYER[kind];
  const width = layerWidth + 2 * WALL;
  const height = 2 * plateRows + depth;
  const [x0, x1] = [WALL, WALL + layerWidth];
  const layerY0 = plateRows;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.METAL, x0, x1, 0, plateRows);
  canvas.fillTemp(mean + delta / 2, x0, x1, 0, plateRows);
  canvas.fill(T.METAL, x0, x1, layerY0 + depth, height);
  canvas.fillTemp(mean - delta / 2, x0, x1, layerY0 + depth, height);
  canvas.fill(T.WATER, x0, x1, layerY0, layerY0 + depth);
  // Another element of a test table is not in the default one `fill` reads temperatures from: swap the kind afterwards.
  for (let y = layerY0; y < layerY0 + depth; y++) canvas.fields.kind.fill(packCell(liquid), y * width + x0, y * width + x1);
  // The cell j of the layer is j + 1 cells from the lower plate's top row, of depth + 1 between the two plate rows.
  for (let j = 0; j < depth; j++) canvas.fillTemp(mean + delta * (0.5 - (j + 1) / (depth + 1)), x0, x1, layerY0 + j, layerY0 + j + 1);
  return { name: 'heatedLayer', width, height, fields: canvas.fields, floorY: 0, chambers: [] };
}

/**
 * `hourglass`: a flat-bottomed silo `siloWidth` cells wide, filled `fillWidths` silo widths high with sand, standing on a
 * plate with an outlet of `outlet` cells in its middle, over a bulb `bulbWidth` wide and `bulbHeight` high that holds the
 * pile (an 18,432-cell pile at 34 degrees is 330 cells wide and 112 high). The silo and the plate are WALL; the bulb is
 * closed at its sides and floor, open above. `fill` is the element of the silo, for a test that swaps in another.
 */
export const HOURGLASS = {
  siloWidth: 64,
  fillWidths: 6,
  headroom: 8,
  bulbWidth: 360,
  bulbHeight: 140,
  outlet: 8,
} as const;

/** The rows and columns of an hourglass with this outlet: the plate is the rows [plateY0, plateY1), the outlet the columns [outletX0, outletX1). */
export function hourglassLayout(outlet: number = HOURGLASS.outlet) {
  const { siloWidth, fillWidths, headroom, bulbWidth, bulbHeight } = HOURGLASS;
  const siloX0 = (bulbWidth - siloWidth) >> 1;
  const outletX0 = (bulbWidth - outlet) >> 1;
  const plateY0 = WALL + bulbHeight;
  const plateY1 = plateY0 + WALL;
  const fillRows = siloWidth * fillWidths;
  return {
    width: bulbWidth,
    height: plateY1 + fillRows + headroom,
    siloX0,
    siloX1: siloX0 + siloWidth,
    outletX0,
    outletX1: outletX0 + outlet,
    plateY0,
    plateY1,
    fillRows,
    cells: siloWidth * fillRows,
  };
}

export function hourglass(outlet: number = HOURGLASS.outlet, fill: number = T.SAND): Scene {
  const { bulbWidth } = HOURGLASS;
  const { width, height, siloX0, siloX1, outletX0, outletX1, plateY0, plateY1, fillRows } = hourglassLayout(outlet);
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, bulbWidth, 0, WALL);
  canvas.fill(T.WALL, 0, WALL, 0, plateY1);
  canvas.fill(T.WALL, bulbWidth - WALL, bulbWidth, 0, plateY1);
  canvas.fill(T.WALL, siloX0 - WALL, siloX1 + WALL, plateY0, plateY1);
  canvas.fill(T.WALL, siloX0 - WALL, siloX0, plateY0, height);
  canvas.fill(T.WALL, siloX1, siloX1 + WALL, plateY0, height);
  canvas.fill(T.EMPTY, outletX0, outletX1, plateY0, plateY1);
  canvas.fill(T.SAND, siloX0, siloX1, plateY1, plateY1 + fillRows);
  // Another element of a test table is not in the default one `fill` reads temperatures from: swap the kind afterwards.
  for (let y = plateY1; y < plateY1 + fillRows; y++) canvas.fields.kind.fill(packCell(fill), y * width + siloX0, y * width + siloX1);
  return { name: 'hourglass', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `viscousSpread`: a column of lava `columnWidth` cells wide and `columnHeight` high against the left wall of a tank
 * `tankWidth` wide, released at once on a floor of WALL. The lava keeps its painted temperature (run it with `air: false`
 * for the floor takes no heat). `liquid` is the element of the column, for a test that swaps in another.
 */
export const VISCOUS_SPREAD = {
  tankWidth: 150,
  columnWidth: 14,
  columnHeight: 40,
  headroom: 8,
} as const;

export function viscousSpread(liquid: number = T.LAVA): Scene {
  const { tankWidth, columnWidth, columnHeight, headroom } = VISCOUS_SPREAD;
  const height = WALL + columnHeight + headroom;
  const canvas = tank(tankWidth, height);
  canvas.fill(liquid, WALL, WALL + columnWidth, WALL, WALL + columnHeight);
  return { name: 'viscousSpread', width: tankWidth, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `freeFall`: one grain dropped from `fallCells` cells (1 m) above the floor in a column `width` cells wide, open above.
 * The grain is the element `grain`; its cell is the one at the top of the column.
 */
export const FREE_FALL = {
  width: 8,
  fallCells: 734,
} as const;

export function freeFall(grain: number = T.SAND): Scene {
  const { width, fallCells } = FREE_FALL;
  const height = WALL + fallCells + 1;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  canvas.fill(grain, width >> 1, (width >> 1) + 1, height - 1, height);
  return { name: 'freeFall', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

export const SCENARIO_SCENES: Record<string, () => Scene> = {
  iceCup: () => iceCup('full'),
  steamBurn: () => steamBurn('steam'),
  contactTemp,
  redHotBar,
  lavaCrust: () => lavaCrust(),
  heatedLayer: () => heatedLayer('above'),
  hourglass: () => hourglass(),
  viscousSpread: () => viscousSpread(),
  freeFall: () => freeFall(),
};

/**
 * The menu's entry for each scenario scene, in the same order as `SCENARIO_SCENES`. The entries are short until I31.2
 * writes each one's target and waiting time from its test.
 */
export const SCENARIO_INFO: Record<string, SceneInfo> = {
  iceCup: {
    label: 'Ice in water',
    group: 'scenarios',
    description: 'A cube of ice in a sealed cup of water, 1 part ice to 9 by mass. Watch it melt and the cup even out slowly; the whole cup should end at 10.0 °C (heat view, H).',
  },
  steamBurn: {
    label: 'Steam on steel',
    group: 'scenarios',
    description: 'Steam at 100 °C sealed in a cavity inside a cold steel box. It condenses and gives its heat to the steel, far more than the same mass of boiling water would.',
  },
  contactTemp: {
    label: 'Contact temperature',
    group: 'scenarios',
    description: 'A steel block at 80 °C pressed against a granite block at 20 °C. Their contact face jumps at once to a temperature between the two, set by how readily each takes up heat, and holds it (heat view, H).',
  },
  redHotBar: {
    label: 'Red-hot bar',
    group: 'scenarios',
    description: 'A steel bar at 1,000 °C hanging in still room air. It cools through its four sides as the air next to it warms and rises.',
  },
  lavaCrust: {
    label: 'Lava crust',
    group: 'scenarios',
    description: 'A pool of lava at 1,300 °C open to still air. A crust of stone grows down from the surface as the lava loses heat to the air.',
  },
  heatedLayer: {
    label: 'Heated water layer',
    group: 'scenarios',
    description: 'A layer of water between two metal plates, the lower one 2 °C warmer. The layer is deep enough for the warm water to rise and the cold to sink, so it stirs itself (heat view, H).',
  },
  hourglass: {
    label: 'Hourglass',
    group: 'scenarios',
    description: 'A silo of sand over a narrow outlet, above a bulb. The sand pours through the outlet and builds a pile at its natural angle.',
  },
  viscousSpread: {
    label: 'Lava spread',
    group: 'scenarios',
    description: 'A column of lava released against a wall. Lava is thick: it creeps along the floor far slower than water would.',
  },
  freeFall: {
    label: 'Free fall',
    group: 'scenarios',
    description: 'One grain of sand dropped from 1 m above the floor in a narrow column. It falls under gravity and lands after about half a second.',
  },
};
