import { emptyCellData, kindWord, tempView, type CellData } from './cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementTemperature, type ElementDef } from './elements';

// The kind word, packed as `makeCell` in `cell.wgsl.ts` does.
export function packCell(type: number, variant = 0): number {
  return kindWord(type, variant);
}

// The temperature a cell of this element of the default table starts at.
export function startTemp(type: number): number {
  const e = (ELEMENTS as readonly ElementDef[]).find((row) => row.id === type);
  if (!e) throw new Error(`no element with id ${type}`);
  return elementTemperature(e);
}

// Every cell starts at its element's temperature, empty space included.
export class Canvas {
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

  /** Fills the cell at (x, y) with a lit FIRE cell: it starts with the element's life, as the brush paints it. */
  fire(x: number, y: number): void {
    this.fill(T.FIRE, x, x + 1, y, y + 1);
    this.fields.life[y * this.width + x] = elementByKey(ELEMENTS, 'FIRE').life!.start;
  }

  /** Sets the temperature of columns [x0, x1) and rows [y0, y1), whatever the cells there are. */
  fillTemp(temp: number, x0: number, x1: number, y0: number, y1: number): void {
    for (let y = y0; y < y1; y++) this.temps.fill(temp, y * this.width + x0, y * this.width + x1);
  }
}

export const WALL = 2;

// Open-topped basin: 2-cell walls on both sides and a 2-cell floor. The grid edge closes the top.
export function tank(width: number, height: number): Canvas {
  const canvas = new Canvas(width, height);
  canvas.fill(T.WALL, 0, WALL, 0, height);
  canvas.fill(T.WALL, width - WALL, width, 0, height);
  canvas.fill(T.WALL, 0, width, 0, WALL);
  return canvas;
}
