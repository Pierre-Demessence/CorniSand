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
  const canvas = new Canvas(cells, 1);
  canvas.fill(T[material], 0, cells, 0, 1);
  canvas.fillTemp(cold, 0, cells, 0, 1);
  canvas.fillTemp(hot, 0, cells / 2, 0, 1);
  return { name: 'sealedBars', width: cells, height: 1, fields: canvas.fields, floorY: 0, chambers: [] };
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
  sealedBars: () => sealedBars('METAL'),
  ...version('sealedBars', 'stone', () => sealedBars('STONE')),
  ...version('sealedBars', 'ice', () => sealedBars('ICE')),
  coolingBlock,
  heatedPot: () => heatedPot(),
};

/**
 * The menu's entry for each scenario scene, in the same order as `SCENARIO_SCENES`. A description says the experiment,
 * the target as its test states it, and how long to wait in game time (1x is real time: 240 supersteps per second);
 * when the test waits for an item, it says so too. It changes with the test's target, in the same commit.
 */
export const SCENARIO_INFO: Record<string, SceneInfo> = {
  iceCup: {
    label: 'Ice in water',
    group: 'scenarios',
    description: "A cube of ice (100 cells) in a sealed, insulated cup of water (900 cells): 1 part ice to 9 by mass, nothing leaves the cup. Reality: all the ice melts and the cup ends at 10.0 °C. The game should end at 9.8 to 10.2 °C once the ice is gone; read it with the pointer or the heat view (H). The last ice melts after about 7 minutes at 1x; the water does not stir, so the cup is not even until much later.",
  },
  'iceCup-fast': {
    label: 'Ice in water (chips)',
    group: 'scenarios',
    description: 'The same cup with the ice as chips, one cell in ten spread through the cup, so it melts sooner: the last ice goes after about 30 s at 1x. Target as for the cube: the cup ends at 10.0 °C, 9.8 to 10.2 in the game.',
  },
  steamBurn: {
    label: 'Steam on steel',
    group: 'scenarios',
    description: "Why steam scalds worse than boiling water: 10 cells of steam at 100 °C sealed in a cavity inside a box of 100 steel cells at 20 °C. Reality: the steam condenses and the box ends at 80.7 to 86.2 °C (steel's heat capacity is known to within that range). Wait about 20 s at 1x until the box is even, and read it with the pointer or the heat view (H).",
  },
  'steamBurn-water': {
    label: 'Boiling water on steel',
    group: 'scenarios',
    description: 'The same box with 10 cells of boiling water at 100 °C instead of steam: no latent heat, so the box ends far cooler, at 27.8 to 28.6 °C. Wait about 25 s at 1x until the box is even.',
  },
  contactTemp: {
    label: 'Contact temperature',
    group: 'scenarios',
    description: 'Why metal feels colder than wood: a steel block at 80 °C (left, 100 cells) pressed against a granite block at 20 °C (60 cells). Reality: their contact face jumps at once to 69.1 to 72.7 °C (71.0 from the rows) and stays within 1 °C of it until the heat reaches a far end. Check it with the heat view (H) from 10 s to 60 s at 1x.',
  },
  redHotBar: {
    label: 'Red-hot bar',
    group: 'scenarios',
    description: "A steel bar 2.2 cm square (16x16 cells) at 1,000 °C hanging in still room air, in a box open at the top. Reality: after 125 s the bar is at 715 to 755 °C (radiation and convection, steel's heat capacity changing with temperature); with a constant heat capacity, 565 to 655 °C. The 565 to 655 °C target waits for radiation (I26); the 715 to 755 °C target waits for radiation (I26) and a heat capacity that follows temperature (I30); the game reaches neither yet. Read the bar at 125 s at 1x.",
  },
  lavaCrust: {
    label: 'Lava crust',
    group: 'scenarios',
    description: "A pool of lava at 1,300 °C (64 cells wide, 80 deep) open to still air. Reality (Hon et al. 1994, Kilauea's pahoehoe flows, extrapolated to the first minutes by a stated factor of 1.5): a crust of stone grows down from the surface, 4.9 to 11.1 cells thick after 1 minute and 14.8 to 33.2 after 9, so 2.5 to 3.6 times as thick at 9 minutes as at 1. This scenario waits for radiation (I26, B16), so the game does not reach it yet. Wait 9 minutes at 1x (8x is faster).",
  },
  heatedLayer: {
    label: 'Heated water layer',
    group: 'scenarios',
    description: 'A layer of water 8 cells deep between two metal plates, the lower one 2 °C warmer. Reality: the layer is well above the threshold where heated water starts to stir, so it carries 2.6 to 4.0 times the heat that conduction alone would (3.2 to 3.3 by the published fit). Watch the water roll in the heat view (H); the heat is measured from 2 to 3 minutes at 1x. This scenario waits for the onset of convection (I29), so the game does not reach it yet.',
  },
  'heatedLayer-below': {
    label: 'Heated water layer (below the threshold)',
    group: 'scenarios',
    description: 'A layer of water 3 cells deep between two metal plates, the lower one 1 °C warmer: under the threshold, so the water stays still and heat crosses by conduction alone, 0.8 to 1.2 times the conduction rate. The heat is measured from 2 to 3 minutes at 1x (heat view, H). This scenario waits for the onset of convection (I29): the game stirs the water anyway.',
  },
  hourglass: {
    label: 'Hourglass',
    group: 'scenarios',
    description: "A silo of sand 6 silo widths high over an outlet 8 cells wide, above a bulb. Reality: sand runs through at a steady rate however much is left above it (within 10% of its mean from 6 to 1.5 widths of sand), and the pile stands at 34 ± 4 degrees. The test reads the angle after plugging the outlet and letting the pile settle for 12 s, so in the live scene it is approximate while sand still falls. The window takes about 42 s at 1x (8x is faster). The pile's angle waits for B18, so the game does not reach it yet.",
  },
  'hourglass-wide': {
    label: 'Hourglass (wide outlet)',
    group: 'scenarios',
    description: "The same silo with an outlet 16 cells wide: it empties 2.83 to 3.56 times as fast as the 8-cell one (Beverloo's law in two dimensions), and the pile stands at 34 ± 4 degrees (read, as for the 8-cell silo, after plugging the outlet and settling for 12 s, so approximate in the live scene). The rate window (from 6 to 1.5 silo widths of sand above) takes about 23 s at 1x today; at the target rate it would take 12 to 15 s. The rate waits for B17 and the angle for B18, so the game does not reach them yet.",
  },
  viscousSpread: {
    label: 'Lava spread',
    group: 'scenarios',
    description: "A column of lava 14 cells wide and 40 high released against a wall. Reality (Huppert 1982): the front is 52 to 78 cells from the wall after 3 s and 82 to 124 after 30 s, so 1.45 to 1.75 times as far at 30 s as at 3 s. Count the front from the wall at 1x. The 30 s position is met; the 3 s position and the ratio wait for I35, because the game's lava spreads too slowly at first.",
  },
  freeFall: {
    label: 'Free fall',
    group: 'scenarios',
    description: 'One grain of sand dropped from 1 m (734 cells) above the floor in a narrow column. Reality: a 0.3 mm grain lands in 0.58 to 0.74 s. It waits for I34 (grains of every size fall with the same drag), so the game does not reach it yet. Slow the game to 1/4x to watch it.',
  },
  sealedBars: {
    label: 'Steel bar relaxing',
    group: 'scenarios',
    description: 'A steel bar one cell high and 40 cells long, the left half at 100 °C and the right half at 0 °C, with nothing around it that holds heat (a thin line, heat view H). Reality: the difference between the halves decays as e^(−t/τ) with τ = L² / (π² α), 21 s for this bar. The game should decay at that time constant within 15%. Wait about 30 s at 1x.',
  },
  'sealedBars-stone': {
    label: 'Stone bar relaxing',
    group: 'scenarios',
    description: 'A stone bar one cell high and 12 cells long, the left half at 100 °C and the right half at 0 °C, nothing around it holding heat. Reality: the difference decays with τ = L² / (π² α), 24 s for this bar, and the game should match it within 15%. Wait about 35 s at 1x (heat view, H).',
  },
  'sealedBars-ice': {
    label: 'Ice bar relaxing',
    group: 'scenarios',
    description: 'An ice bar one cell high and 12 cells long, the left half at −5 °C and the right half at −25 °C, so it stays ice, nothing around it holding heat. Reality: the difference decays with τ = L² / (π² α), 23 s for this bar, and the game should match it within 15%. Wait about 35 s at 1x (heat view, H).',
  },
  coolingBlock: {
    label: 'Cooling steel block',
    group: 'scenarios',
    description: "A steel block 50 cells (68 mm) wide at 500 °C hanging in a large box of still room air. Reality: natural convection in still air carries 5 to 25 W/m²·K away from objects of a centimetre to a metre. The game should cool with an effective surface coefficient of 5 to 20 W/m²·K (within a factor of 2 of the typical 10): after 37.5 s at 1x the block's mean has fallen by about 1.5 to 6 °C only (heat view, H).",
  },
  heatedPot: {
    label: 'Heated pot',
    group: 'scenarios',
    description: 'A block of water 4x4 cells at 90 °C on the floor of a tank of water 32 cells deep at 20 °C. Reality: the warm block rises at the free-convection speed, about 0.12 m/s by the free-convection scale (an estimate, not a measured speed), crossing the middle half of the tank in 0.18 s. The game should be within a factor of 3 of that speed: 0.06 to 0.55 s for the same stretch. It reaches three quarters of the way up in under a second; slow the game to 1/4x and use the heat view (H).',
  },
};
