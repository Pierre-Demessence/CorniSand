import { ELEMENT as T } from './elements';
import { ROOM_TEMP } from './heat';
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
 * `contactTemp`: a steel block at 80 °C pressed against a basalt block at 20 °C, a bar left to right. Their contact
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

/**
 * `sealedBars`: a bar one cell high of `cells` cells of one material, the left half at `hot` and the right half at
 * `cold`, with nothing around it that holds heat (the grid's edge holds none): the difference between its halves
 * decays with the time constant of the material. One bar per material, of a length that lets the heat cross in a few
 * seconds; the ice bar sits below freezing so that it stays ice.
 */
export const SEALED_BARS = {
  METAL: { cells: 40, hot: 100, cold: 0 },
  STONE: { cells: 12, hot: 100, cold: 0 },
  ICE: { cells: 12, hot: -5, cold: -25 },
} as const;

export type SealedBarsMaterial = keyof typeof SEALED_BARS;

export function sealedBars(material: SealedBarsMaterial = 'METAL'): Scene {
  const { cells, hot, cold } = SEALED_BARS[material];
  return bar('sealedBars', T[material], cells, hot, cold);
}

/** A bar one cell high of `cells` cells of one material, the left half at `hot` and the right half at `cold`, and nothing around it that holds heat. */
function bar(name: string, type: number, cells: number, hot: number, cold: number): Scene {
  const canvas = new Canvas(cells, 1);
  canvas.fill(type, 0, cells, 0, 1);
  canvas.fillTemp(cold, 0, cells, 0, 1);
  canvas.fillTemp(hot, 0, cells / 2, 0, 1);
  return { name, width: cells, height: 1, fields: canvas.fields, floorY: 0, chambers: [] };
}

/**
 * `metalBars`: `sealedBars` for the metals and diamond, every bar of the same 40 cells (5.5 cm) so that their time constants
 * compare: the left half at 100 °C, the right at 0, nothing around it that holds heat. Steel is the reference; each other
 * bar relaxes faster or slower by the ratio of its diffusivity (conductivity over heat capacity) to steel's.
 */
export const METAL_BARS = { cells: 40, hot: 100, cold: 0 } as const;

export type MetalBarsMaterial = 'METAL' | 'ALUMINIUM' | 'COPPER' | 'GOLD' | 'TITANIUM' | 'DIAMOND';

export function metalBars(material: MetalBarsMaterial = 'METAL'): Scene {
  const { cells, hot, cold } = METAL_BARS;
  return bar('metalBars', T[material], cells, hot, cold);
}

/**
 * `insulationWall`: lava against a wall one cell thick, water on its far side, in a sealed box (the grid's edge holds no heat)
 * with no empty cell. `lavaWidth` and `waterWidth` are the cells either side; the rows are identical, so heat runs along x
 * only. `wall` is the element of the wall: aerogel, or basalt for the control of the scenario.
 */
export const INSULATION_WALL = { lavaWidth: 12, waterWidth: 12, height: 8 } as const;

export function insulationWall(wall: number = T.INSULATION): Scene {
  const { lavaWidth, waterWidth, height } = INSULATION_WALL;
  const width = lavaWidth + 1 + waterWidth;
  const canvas = new Canvas(width, height);
  canvas.fill(T.LAVA, 0, lavaWidth, 0, height);
  canvas.fill(wall, lavaWidth, lavaWidth + 1, 0, height);
  canvas.fill(T.WATER, lavaWidth + 1, width, 0, height);
  return { name: 'insulationWall', width, height, fields: canvas.fields, floorY: 0, chambers: [] };
}

/**
 * `crucible`: a cup of `cupWall`-thick walls and floor, `inner` cells wide and `depth` deep inside, standing on a floor of WALL
 * (which holds no heat) and full of molten steel at its painted 1,600 °C. `cup` is the element of the cup and `cupTemp` its
 * temperature: a cold cup is at room temperature; a preheated ceramic cup is at `PREHEAT`, a little under the steel's, so that
 * the steel does not meet a cup far colder than itself.
 */
export const CRUCIBLE = {
  inner: 14,
  depth: 10,
  cupWall: 2,
  margin: 3,
  headroom: 6,
  /** The temperature of the preheated ceramic cup, 100 K under the steel's 1,600 °C. */
  preheat: 1500,
} as const;

/** The cup's own cells: the floor rows, then the two side walls. */
export function crucibleCup(): { x0: number; x1: number; y0: number; y1: number }[] {
  const { inner, depth, cupWall, margin } = CRUCIBLE;
  const x0 = margin;
  const x1 = margin + inner + 2 * cupWall;
  return [
    { x0, x1, y0: WALL, y1: WALL + cupWall },
    { x0, x1: x0 + cupWall, y0: WALL + cupWall, y1: WALL + cupWall + depth },
    { x0: x1 - cupWall, x1, y0: WALL + cupWall, y1: WALL + cupWall + depth },
  ];
}

export function crucible(cup: number = T.CERAMIC, cupTemp: number = CRUCIBLE.preheat): Scene {
  const { inner, depth, cupWall, margin, headroom } = CRUCIBLE;
  const width = inner + 2 * cupWall + 2 * margin;
  const height = WALL + cupWall + depth + headroom;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  canvas.fill(T.MOLTEN_METAL, margin + cupWall, margin + cupWall + inner, WALL + cupWall, WALL + cupWall + depth);
  for (const { x0, x1, y0, y1 } of crucibleCup()) {
    canvas.fill(cup, x0, x1, y0, y1);
    canvas.fillTemp(cupTemp, x0, x1, y0, y1);
  }
  return { name: 'crucible', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `coolingBlock`: a steel block `side` cells (68 mm) wide at `temp`, hanging in a large box of room-temperature air
 * (the grid's edge is open air), `x0` and `y0` cells from the lower left corner.
 */
export const COOLING_BLOCK = {
  width: 160,
  height: 160,
  side: 50,
  x0: 55,
  y0: 55,
  temp: 500,
} as const;

export function coolingBlock(): Scene {
  const { width, height, side, x0, y0, temp } = COOLING_BLOCK;
  const canvas = new Canvas(width, height);
  canvas.fill(T.METAL, x0, x0 + side, y0, y0 + side);
  canvas.fillTemp(temp, x0, x0 + side, y0, y0 + side);
  return { name: 'coolingBlock', width, height, fields: canvas.fields, floorY: 0, chambers: [] };
}

/**
 * `heatedPot`: a tank `width` cells wide (a wall cell at each side) with `plateRows` rows of WALL under and over a layer of
 * water `depth` rows deep at `liquidTemp`, and a block of `blockSize` by `blockSize` cells at `blockTemp` on the floor
 * of the layer, `blockX0` cells from the left. `liquid` is the element of the layer, for a test that swaps in another.
 */
export const HEATED_POT = {
  width: 18,
  plateRows: 2,
  depth: 32,
  liquidTemp: 20,
  blockTemp: 90,
  blockX0: 7,
  blockSize: 4,
} as const;

export function heatedPot(liquid: number = T.WATER): Scene {
  const { width, plateRows, depth, liquidTemp, blockTemp, blockX0, blockSize } = HEATED_POT;
  const height = depth + 2 * plateRows;
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, width, 0, height);
  canvas.fill(T.WATER, 1, width - 1, plateRows, plateRows + depth);
  canvas.fillTemp(liquidTemp, 1, width - 1, plateRows, plateRows + depth);
  canvas.fillTemp(blockTemp, blockX0, blockX0 + blockSize, plateRows, plateRows + blockSize);
  // Another element of a test table is not in the default one `fill` reads temperatures from: swap the kind afterwards.
  for (let y = plateRows; y < plateRows + depth; y++) canvas.fields.kind.fill(packCell(liquid), y * width + 1, y * width + width - 1);
  return { name: 'heatedPot', width, height, fields: canvas.fields, floorY: plateRows, chambers: [] };
}

/**
 * `densityColumn`: four layers `layer` cells thick in a tank `width` wide (a wall of `WALL` cells each side) that a test pours
 * in any order: `order` lists their elements from the floor up. The default is the order that is wrong for every pair, the
 * lightest at the bottom, so every layer has to cross the others.
 */
export const DENSITY_COLUMN = { width: 24, layer: 6, headroom: 4 } as const;

/** The four materials of the column, lightest first. */
export function densityColumnLayers(powder: number = T.SAWDUST): number[] {
  return [powder, T.OIL, T.WATER, T.MERCURY];
}

export function densityColumn(order: readonly number[] = densityColumnLayers()): Scene {
  const { width, layer, headroom } = DENSITY_COLUMN;
  const height = WALL + order.length * layer + headroom;
  const canvas = tank(width, height);
  order.forEach((type, i) => canvas.fill(type, WALL, width - WALL, WALL + i * layer, WALL + (i + 1) * layer));
  return { name: 'densityColumn', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `nitrogenOnWater`: `nitrogen` rows of liquid nitrogen at its painted -196 °C over `water` rows of water at 20 °C in a tank
 * `width` wide (a wall of `WALL` cells each side and under), with `headroom` rows of empty space above for the gas. The grid's
 * edge closes the top.
 */
export const NITROGEN_ON_WATER = { width: 20, water: 12, nitrogen: 8, headroom: 16 } as const;

export function nitrogenOnWater(): Scene {
  const { width, water, nitrogen, headroom } = NITROGEN_ON_WATER;
  const height = WALL + water + nitrogen + headroom;
  const canvas = tank(width, height);
  canvas.fill(T.WATER, WALL, width - WALL, WALL, WALL + water);
  canvas.fill(T.LIQUID_NITROGEN, WALL, width - WALL, WALL + water, WALL + water + nitrogen);
  return { name: 'nitrogenOnWater', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/**
 * `thermometer`: a glass bulb `bulb` cells square full of mercury, with a glass tube one cell wide and `tubeHeight` tall rising
 * from the middle of its top, sealed at the end. The mercury stands `base` cells up the tube at 20 °C; marks of wall cells beside
 * the tube sit at the level the mercury should reach at 0, 20, 60 and 100 °C (those above the bulb). Every cell of the
 * thermometer is at `temp`. With `bath`, the bulb stands in a tank of water at `BATH_TEMP`, up to a few rows above its top,
 * so the tube rises out of it. One unit of matter per cell, the mercury does not swell (backlog I22).
 */
export const THERMOMETER = {
  bulb: 33,
  glass: 1,
  tubeHeight: 40,
  base: 4,
  /** Mercury's volumetric expansion at 20 °C, per °C (Wikipedia "Mercury (element)": 181.71e-6). */
  expansion: 1.8171e-4,
  /** The °C of one mark. */
  mark: 5,
  /** The temperature of the bath, and of the thermometer outside it. */
  bathTemp: 60,
  startTemp: 20,
  /** The temperature of the loaded version, `thermometer-hot`. */
  hotTemp: 100,
  /** The bath: cells of water either side of the bulb, under it, and over its top. */
  bathMargin: 16,
  bathBelow: 8,
  bathAbove: 3,
  /** Empty cells at the left of the thermometer, which hold its marks. */
  margin: 4,
} as const;

/** Where the thermometer's parts are: `top` is the row of the first cell of the tube, `tubeX` its column, `interior` the mercury of the bulb. */
export function thermometerLayout(bath: boolean) {
  const { bulb, glass, tubeHeight, bathMargin, bathBelow, margin } = THERMOMETER;
  const ox = bath ? WALL + bathMargin : margin;
  const oy = bath ? WALL + bathBelow : WALL;
  const outer = bulb + 2 * glass;
  const top = oy + outer - glass;
  const tubeX = ox + glass + (bulb >> 1);
  const width = bath ? outer + 2 * (WALL + bathMargin) : ox + outer + margin;
  const height = top + tubeHeight + glass + WALL;
  return {
    width,
    height,
    ox,
    oy,
    outer,
    top,
    tubeX,
    interior: { x0: ox + glass, x1: ox + glass + bulb, y0: oy + glass, y1: oy + glass + bulb },
  };
}

/** The level in cells above the bulb that a column of mercury calibrated at `base` stands at when it is `temp`, if it expanded as the data say. */
export function thermometerLevel(temp: number): number {
  const { bulb, base, expansion, startTemp } = THERMOMETER;
  return base + bulb * bulb * expansion * (temp - startTemp);
}

export function thermometer(temp: number = THERMOMETER.startTemp, bath = false): Scene {
  const { glass, tubeHeight, base, bathTemp, bathAbove } = THERMOMETER;
  const { width, height, ox, oy, outer, top, tubeX, interior } = thermometerLayout(bath);
  const canvas = new Canvas(width, height);
  if (bath) {
    const waterTop = top + bathAbove;
    canvas.fill(T.WALL, 0, width, 0, WALL);
    canvas.fill(T.WALL, 0, WALL, 0, waterTop);
    canvas.fill(T.WALL, width - WALL, width, 0, waterTop);
    canvas.fill(T.WATER, WALL, width - WALL, WALL, waterTop);
    canvas.fillTemp(bathTemp, WALL, width - WALL, WALL, waterTop);
  }
  const thermo = (type: number, x0: number, x1: number, y0: number, y1: number): void => {
    canvas.fill(type, x0, x1, y0, y1);
    canvas.fillTemp(temp, x0, x1, y0, y1);
  };
  thermo(T.GLASS, ox, ox + outer, oy, oy + outer);
  thermo(T.MERCURY, interior.x0, interior.x1, interior.y0, interior.y1);
  // The tube: two walls and a cap, over a hole in the top of the bulb, mercury `base` cells up.
  thermo(T.GLASS, tubeX - glass, tubeX, top, top + tubeHeight);
  thermo(T.GLASS, tubeX + 1, tubeX + 1 + glass, top, top + tubeHeight);
  thermo(T.GLASS, tubeX, tubeX + 1, top + tubeHeight, top + tubeHeight + glass);
  thermo(T.MERCURY, tubeX, tubeX + 1, top, top + base);
  // Marks beside the tube, above the bulb and the bath, for the temperatures a calibrated thermometer reads.
  const waterTop = bath ? top + bathAbove : 0;
  for (const t of [0, 20, 60, 100]) {
    const y = top + Math.round(thermometerLevel(t)) - 1;
    if (y >= top && y >= waterTop) canvas.fill(T.WALL, tubeX - glass - 1, tubeX - glass, y, y + 1);
  }
  return { name: 'thermometer', width, height, fields: canvas.fields, floorY: WALL, chambers: [] };
}

/** One entry of `SCENARIO_SCENES` for a version other than the main one, under `<name>-<version>`; the scene carries that name too. */
function version(name: string, versionName: string, build: () => Scene): Record<string, () => Scene> {
  const key = `${name}-${versionName}`;
  return { [key]: () => ({ ...build(), name: key }) };
}

/**
 * The scenario scenes in the order the menu lists them. A scenario's main version is under the bare name; each other
 * version a test builds through a builder parameter is `<name>-<version>` (`tests/scenes.test.ts`, I31 AC7).
 */
export const SCENARIO_SCENES: Record<string, () => Scene> = {
  iceCup: () => iceCup('full'),
  ...version('iceCup', 'fast', () => iceCup('fast')),
  steamBurn: () => steamBurn('steam'),
  ...version('steamBurn', 'water', () => steamBurn('water')),
  contactTemp,
  redHotBar,
  lavaCrust: () => lavaCrust(),
  heatedLayer: () => heatedLayer('above'),
  ...version('heatedLayer', 'below', () => heatedLayer('below')),
  hourglass: () => hourglass(),
  ...version('hourglass', 'wide', () => hourglass(2 * HOURGLASS.outlet)),
  viscousSpread: () => viscousSpread(),
  freeFall: () => freeFall(),
  ...version('freeFall', 'pebble', () => freeFall(T.GRAVEL)),
  sealedBars: () => sealedBars('METAL'),
  ...version('sealedBars', 'stone', () => sealedBars('STONE')),
  ...version('sealedBars', 'ice', () => sealedBars('ICE')),
  metalBars: () => metalBars('METAL'),
  ...version('metalBars', 'aluminium', () => metalBars('ALUMINIUM')),
  ...version('metalBars', 'copper', () => metalBars('COPPER')),
  ...version('metalBars', 'gold', () => metalBars('GOLD')),
  ...version('metalBars', 'titanium', () => metalBars('TITANIUM')),
  ...version('metalBars', 'diamond', () => metalBars('DIAMOND')),
  insulationWall: () => insulationWall(T.INSULATION),
  ...version('insulationWall', 'basalt', () => insulationWall(T.STONE)),
  crucible: () => crucible(T.CERAMIC),
  ...version('crucible', 'tungsten', () => crucible(T.TUNGSTEN, ROOM_TEMP)),
  ...version('crucible', 'cold', () => crucible(T.CERAMIC, ROOM_TEMP)),
  densityColumn: () => densityColumn(),
  nitrogenOnWater,
  thermometer: () => thermometer(THERMOMETER.startTemp, true),
  ...version('thermometer', 'hot', () => thermometer(THERMOMETER.hotTemp)),
  coolingBlock,
  heatedPot: () => heatedPot(),
};

/**
 * The menu's entry for each scenario scene, in the same order as `SCENARIO_SCENES`. A description is one line: what to
 * watch, and the target only when it fits; it changes with the test's target, in the same commit. `waitsFor` lists the
 * items a scenario's test waits for and the test takes its `[waits for ...]` title from it; delete it in the commit
 * that makes the scenario pass.
 */
export const SCENARIO_INFO: Record<string, SceneInfo> = {
  iceCup: {
    label: 'Ice in water',
    group: 'scenarios',
    version: 'full',
    description: 'A cube of ice in a sealed cup of water, 1 part to 9 by mass: all the ice melts and the cup ends at 10 °C.',
  },
  'iceCup-fast': {
    label: 'Ice in water (chips)',
    group: 'scenarios',
    family: 'iceCup',
    version: 'fast',
    description: 'The same cup with the ice as chips spread through the cup, so it melts sooner and ends at 10 °C.',
  },
  steamBurn: {
    label: 'Steam on steel',
    group: 'scenarios',
    version: 'steam',
    description: 'Why steam scalds worse than boiling water: 10 cells of steam at 100 °C sealed in 100 cells of steel at 20 °C.',
  },
  'steamBurn-water': {
    label: 'Boiling water on steel',
    group: 'scenarios',
    family: 'steamBurn',
    version: 'water',
    description: 'The same steel box with boiling water instead of steam: no latent heat, so it ends far cooler.',
  },
  contactTemp: {
    label: 'Contact temperature',
    group: 'scenarios',
    description: 'Why metal feels cold: steel at 80 °C against basalt at 20 °C, the contact face jumps to about 71 °C.',
  },
  redHotBar: {
    label: 'Red-hot bar',
    group: 'scenarios',
    description: 'A steel bar 2.2 cm square at 1,000 °C cooling in still air: it should reach 715-755 °C after 125 s.',
    waitsFor: ['I26', 'I30'],
  },
  lavaCrust: {
    label: 'Lava crust',
    group: 'scenarios',
    description: 'A pool of lava at 1,300 °C open to still air: a crust of basalt grows down from the surface.',
    waitsFor: ['I26', 'B16'],
  },
  heatedLayer: {
    label: 'Heated water layer',
    group: 'scenarios',
    version: 'above',
    description: 'Water 8 cells deep between plates, the lower 2 °C warmer: it stirs and carries 2.6 to 4.0 times conduction.',
    waitsFor: ['I29'],
  },
  'heatedLayer-below': {
    label: 'Heated water layer (below the threshold)',
    group: 'scenarios',
    family: 'heatedLayer',
    version: 'below',
    description: 'Water 3 cells deep, the lower plate 1 °C warmer: under the threshold, so it stays still and conducts only.',
    waitsFor: ['I29'],
  },
  hourglass: {
    label: 'Hourglass',
    group: 'scenarios',
    version: 'outlet 8',
    description: 'A silo of sand over an 8-cell outlet: sand runs at a steady rate and the pile stands at 34 ± 4 degrees.',
    waitsFor: ['B17', 'B18'],
  },
  'hourglass-wide': {
    label: 'Hourglass (wide outlet)',
    group: 'scenarios',
    family: 'hourglass',
    version: 'outlet 16',
    description: 'The same silo with a 16-cell outlet: it empties 2.83 to 3.56 times as fast as the 8-cell one.',
    waitsFor: ['B17', 'B18'],
  },
  viscousSpread: {
    label: 'Lava spread',
    group: 'scenarios',
    description: 'A column of lava released against a wall: the front is 52 to 78 cells out after 3 s and 82 to 124 after 30 s.',
    waitsFor: ['I35'],
  },
  freeFall: {
    label: 'Free fall',
    group: 'scenarios',
    version: 'sand',
    description: 'One grain of sand dropped from 1 m in a narrow column: a 0.3 mm grain lands in 0.58 to 0.74 s.',
    waitsFor: ['I34'],
  },
  'freeFall-pebble': {
    label: 'Free fall (pebble)',
    group: 'scenarios',
    family: 'freeFall',
    version: 'pebble',
    description: 'One piece of gravel dropped from 1 m in a narrow column: a 5 mm pebble lands in 0.45 to 0.47 s.',
    waitsFor: ['I34'],
  },
  sealedBars: {
    label: 'Steel bar relaxing',
    group: 'scenarios',
    version: 'steel',
    description: 'A steel bar 40 cells long, halves at 100 and 0 °C: the difference decays with a 21 s time constant.',
  },
  'sealedBars-stone': {
    label: 'Basalt bar relaxing',
    group: 'scenarios',
    family: 'sealedBars',
    version: 'stone',
    description: 'A basalt bar 12 cells long, halves at 100 and 0 °C: the difference decays with a 32 s time constant.',
  },
  'sealedBars-ice': {
    label: 'Ice bar relaxing',
    group: 'scenarios',
    family: 'sealedBars',
    version: 'ice',
    description: 'An ice bar 12 cells long, halves at -5 and -25 °C: the difference decays with a 23 s time constant.',
  },
  metalBars: {
    label: 'Metal bars',
    group: 'scenarios',
    version: 'steel',
    description: 'A steel bar 40 cells long, halves at 100 and 0 °C: the reference the other metals are timed against.',
  },
  'metalBars-aluminium': {
    label: 'Metal bars (aluminium)',
    group: 'scenarios',
    family: 'metalBars',
    version: 'aluminium',
    description: 'The same bar in aluminium: heat should cross it 6.9 times as fast as steel (the ratio of the diffusivities).',
    waitsFor: ['D40'],
  },
  'metalBars-copper': {
    label: 'Metal bars (copper)',
    group: 'scenarios',
    family: 'metalBars',
    version: 'copper',
    description: 'The same bar in copper: heat should cross it 8.1 times as fast as steel (the ratio of the diffusivities).',
    waitsFor: ['D40'],
  },
  'metalBars-gold': {
    label: 'Metal bars (gold)',
    group: 'scenarios',
    family: 'metalBars',
    version: 'gold',
    description: 'The same bar in gold: heat should cross it 8.9 times as fast as steel (the ratio of the diffusivities).',
    waitsFor: ['D40'],
  },
  'metalBars-titanium': {
    label: 'Metal bars (titanium)',
    group: 'scenarios',
    family: 'metalBars',
    version: 'titanium',
    description: 'The same bar in titanium, a poorer conductor: heat crosses it 0.65 times as fast as steel.',
  },
  'metalBars-diamond': {
    label: 'Metal bars (diamond)',
    group: 'scenarios',
    family: 'metalBars',
    version: 'diamond',
    description: 'The same bar in diamond: heat crosses it fastest of all, faster than in any metal.',
  },
  insulationWall: {
    label: 'Aerogel wall',
    group: 'scenarios',
    version: 'aerogel',
    description: 'Lava against a one-cell aerogel wall: the water behind it warms at least 20 times less than behind basalt.',
  },
  'insulationWall-basalt': {
    label: 'Aerogel wall (basalt)',
    group: 'scenarios',
    family: 'insulationWall',
    version: 'basalt',
    description: 'The same wall in basalt: the water behind it warms many times faster than behind aerogel.',
  },
  crucible: {
    label: 'Crucible',
    group: 'scenarios',
    version: 'ceramic',
    description: 'Molten steel at 1,600 °C in a ceramic cup preheated to 1,500 °C: no cup cell changes in 8 seconds.',
  },
  'crucible-tungsten': {
    label: 'Crucible (tungsten)',
    group: 'scenarios',
    family: 'crucible',
    version: 'tungsten',
    description: 'The same steel in a cold tungsten cup, which melts only at 3,422 °C: no cup cell changes.',
  },
  'crucible-cold': {
    label: 'Crucible (cold ceramic)',
    group: 'scenarios',
    family: 'crucible',
    version: 'cold',
    description: 'The same steel in a cold ceramic cup: the shock of the heat should crack it.',
    waitsFor: ['M8.1k'],
  },
  densityColumn: {
    label: 'Density column',
    group: 'scenarios',
    description: 'Sawdust, oil, water and mercury poured in the worst order: they settle with the heaviest at the bottom.',
  },
  nitrogenOnWater: {
    label: 'Nitrogen on water',
    group: 'scenarios',
    description: 'Liquid nitrogen poured on water boils away into gas that rises, and freezes at most 0.78 ice cells per cell.',
  },
  thermometer: {
    label: 'Mercury thermometer',
    group: 'scenarios',
    version: 'bath',
    description: 'A mercury thermometer dipped from 20 °C into a 60 °C bath: the mercury should rise 0.2 cells per degree.',
    waitsFor: ['I22'],
  },
  'thermometer-hot': {
    label: 'Mercury thermometer (hot)',
    group: 'scenarios',
    family: 'thermometer',
    version: 'hot',
    description: 'The same thermometer at 100 °C: its mercury should stand 16 cells higher than at 20 °C.',
    waitsFor: ['I22'],
  },
  coolingBlock: {
    label: 'Cooling steel block',
    group: 'scenarios',
    description: 'A steel block 68 mm wide at 500 °C in still air: it cools with a surface coefficient of 5 to 20 W/m²·K.',
  },
  heatedPot: {
    label: 'Heated pot',
    group: 'scenarios',
    description: 'A 4x4 block of water at 90 °C on the floor of a 20 °C tank: it rises at about 0.12 m/s (within a factor of 3).',
  },
};
