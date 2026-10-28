import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { Display } from '../src/display';
import { ELEMENT as T, ELEMENTS, type ElementDef } from '../src/elements';
import { ROOM_TEMP } from '../src/heat';
import type { Look, LookSettings } from '../src/look';
import type { Simulation } from '../src/simulation';
import { cell, createSim, device, runMany } from './gpu';

// M11's tests of the finished look (docs/plans/m11-rendering.md). One grid cell per pixel; the width is a multiple of 64
// so a row of pixels is a multiple of 256 bytes, the alignment a texture copy needs.

const LOOKS: Look[] = ['finished', 'cells'];
const ROWS: readonly ElementDef[] = ELEMENTS;

interface RenderOptions {
  look?: Look;
  heatView?: boolean;
  airView?: boolean;
  settings?: Partial<LookSettings>;
}

// The picture of a sim, RGBA bytes, the first row the world's top.
async function render(sim: Simulation, width: number, height: number, options: RenderOptions = {}): Promise<Uint8Array> {
  const dev = device!;
  const display = new Display(dev, 'rgba8unorm', width, height, sim.fields, sim.elements, sim.flyers.overlay, {
    air: sim.air,
    ...(options.settings && { settings: options.settings }),
  });
  const target = dev.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const staging = dev.createBuffer({ size: width * 4 * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  dev.pushErrorScope('validation');
  const encoder = dev.createCommandEncoder();
  sim.recordOverlay(encoder);
  display.render(encoder, target.createView(), width, height, {
    mousePos: { x: 0, y: 0 },
    brushSize: 0,
    showBrush: false,
    erasing: false,
    replacing: false,
    heatView: options.heatView,
    airView: options.airView,
    look: options.look,
  });
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: width * 4 }, [width, height]);
  dev.queue.submit([encoder.finish()]);
  const error = await dev.popErrorScope();
  if (error) throw new Error(`WebGPU validation error: ${error.message}`);
  await staging.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  target.destroy();
  return pixels;
}

const luminanceOf = (rgb: ArrayLike<number>): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const pixelAt = (pixels: Uint8Array, width: number, x: number, row: number): number[] => [...pixels.slice((row * width + x) * 4, (row * width + x) * 4 + 3)];

// The mean luminance of the `w` by `h` pixels from (x, row), `row` counted from the top of the picture.
function patchLuminance(pixels: Uint8Array, width: number, x: number, row: number, w: number, h: number): number {
  let sum = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) sum += luminanceOf(pixelAt(pixels, width, x + i, row + j));
  return sum / (w * h);
}

// A row of one cell per element of the table, in table order, at room temperature and, for fire, with its life.
function everyElementRow(width: number): { kind: Uint32Array<ArrayBuffer>; life: Uint32Array<ArrayBuffer>; temp: Uint32Array<ArrayBuffer> } {
  const kind = new Uint32Array(width);
  const life = new Uint32Array(width);
  const temp = new Uint32Array(width);
  tempView({ temp }).fill(ROOM_TEMP);
  ROWS.forEach((e, i) => {
    kind[i] = cell(e.id);
    life[i] = e.life?.start ?? 0;
  });
  return { kind, life, temp };
}

describe.skipIf(!device)('M11.2 the two looks', () => {
  it('M11 AC2: the heat and air views render bit-identically in both looks', async () => {
    const width = 64;
    const height = 16;
    for (const view of [{ heatView: true }, { airView: true }]) {
      const sim = createSim(width, height);
      const kind = new Uint32Array(width * height);
      const temp = new Uint32Array(width * height);
      tempView({ temp }).fill(ROOM_TEMP);
      ROWS.forEach((e, i) => { kind[8 * width + 2 + 4 * i] = cell(e.id, 37 * i); });
      tempView({ temp })[8 * width + 2 + 4 * 7] = 900;
      sim.load({ kind, temp });
      const finished = await render(sim, width, height, { ...view, look: 'finished' });
      const cells = await render(sim, width, height, { ...view, look: 'cells' });
      expect(finished, JSON.stringify(view)).toEqual(cells);
    }
  });

  it('M11 AC3: a cell with nothing around it is drawn in its cells-look color, for every element of the table', async () => {
    const width = 64;
    const sim = createSim(width, 1);
    sim.load(everyElementRow(width));
    const finished = await render(sim, width, 1, { look: 'finished' });
    const cells = await render(sim, width, 1, { look: 'cells' });
    ROWS.forEach((e, i) => {
      pixelAt(finished, width, i, 0).forEach((channel, c) => {
        expect(Math.abs(channel - cells[i * 4 + c]), `${e.key}, channel ${c}`).toBeLessThanOrEqual(1);
      });
    });
  });
});

describe.skipIf(!device)('M11.2 grain', () => {
  const width = 256;

  // The picture of a row of 256 cells of one element, variant i in cell i, at room temperature.
  async function variantsOf(type: number, look: Look = 'cells'): Promise<Uint8Array> {
    const sim = createSim(width, 1);
    const kind = new Uint32Array(width);
    for (let i = 0; i < width; i++) kind[i] = cell(type, i);
    const temp = new Uint32Array(width);
    tempView({ temp }).fill(ROOM_TEMP);
    const life = new Uint32Array(width).fill(ROWS.find((e) => e.id === type)?.life?.start ?? 0);
    sim.load({ kind, life, temp });
    return render(sim, width, 1, { look });
  }

  const lumRange = (pixels: Uint8Array): number => {
    const lums = Array.from({ length: width }, (_, i) => luminanceOf(pixelAt(pixels, width, i, 0)));
    return Math.max(...lums) - Math.min(...lums);
  };

  it('M11 AC4: sand and gunpowder spread their luminance over at least 20 steps, stone and metal over 3 to 12', async () => {
    for (const look of LOOKS) {
      expect(lumRange(await variantsOf(T.SAND, look)), `sand, ${look}`).toBeGreaterThanOrEqual(20);
      expect(lumRange(await variantsOf(T.GUNPOWDER, look)), `gunpowder, ${look}`).toBeGreaterThanOrEqual(20);
      for (const [name, type] of [['stone', T.STONE], ['metal', T.METAL]] as const) {
        const range = lumRange(await variantsOf(type, look));
        expect(range, `${name}, ${look}`).toBeGreaterThanOrEqual(3);
        expect(range, `${name}, ${look}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it('M11 AC4: no liquid, gas or fire varies with its variant', async () => {
    for (const key of ['WATER', 'OIL', 'LAVA', 'MOLTEN_METAL', 'SMOKE', 'STEAM', 'FIRE'] as const) {
      expect(lumRange(await variantsOf(T[key])), key).toBe(0);
    }
  });

  it('M11 AC4: variant 0 is the table color and the mean shade over the 256 variants is within 1 step of it', async () => {
    // Empty space is the wall. Lava, molten metal and fire are not their table color: they glow or take it from their life.
    for (const e of ROWS.filter((row) => !['EMPTY', 'LAVA', 'MOLTEN_METAL', 'FIRE'].includes(row.key))) {
      const pixels = await variantsOf(e.id);
      pixelAt(pixels, width, 0, 0).forEach((channel, c) => {
        expect(Math.abs(channel - e.color[c] * 255), `${e.key} variant 0, channel ${c}`).toBeLessThanOrEqual(1);
      });
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let i = 0; i < width; i++) sum += pixels[i * 4 + c];
        expect(Math.abs(sum / width - e.color[c] * 255), `${e.key} mean, channel ${c}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('M11 AC4: a grain that falls keeps its color', async () => {
    const w = 64;
    const height = 40;
    const sim = createSim(w, height);
    const kind = new Uint32Array(w * height);
    const variant = 77;
    kind[30 * w + 10] = cell(T.SAND, variant);
    sim.load({ kind });

    // The grain is the brightest thing in a picture of a dark wall.
    const find = (pixels: Uint8Array): { at: number; color: number[] } => {
      let at = 0;
      for (let i = 1; i < w * height; i++) if (luminanceOf(pixels.slice(i * 4, i * 4 + 3)) > luminanceOf(pixels.slice(at * 4, at * 4 + 3))) at = i;
      return { at, color: [...pixels.slice(at * 4, at * 4 + 3)] };
    };
    const before = find(await render(sim, w, height));
    await runMany(sim, 24);
    const after = find(await render(sim, w, height));

    expect(after.at, 'the grain moved').toBeGreaterThan(before.at);
    expect(after.color).toEqual(before.color);
    const table = ROWS.find((e) => e.id === T.SAND)!.color;
    expect(before.color.some((channel, c) => Math.abs(channel - table[c] * 255) > 2), 'variant 77 is not the table color').toBe(true);
  });
});

describe.skipIf(!device)('M11.2 wall', () => {
  const width = 64;
  const height = 32;
  const emptyPicture = async (look: Look, wall?: number): Promise<Uint8Array> => {
    const sim = createSim(width, height);
    return render(sim, width, height, { look, ...(wall !== undefined && { settings: { wall } }) });
  };
  const topCenter = (pixels: Uint8Array): number => patchLuminance(pixels, width, 28, 0, 8, 2);

  it('M11 AC5: empty space is brighter at the top center than in each corner, in both looks', async () => {
    for (const look of LOOKS) {
      for (const wall of [0, 0.35, 1]) {
        const pixels = await emptyPicture(look, wall);
        const center = topCenter(pixels);
        const corners = [
          patchLuminance(pixels, width, 0, 0, 4, 2),
          patchLuminance(pixels, width, width - 4, 0, 4, 2),
          patchLuminance(pixels, width, 0, height - 2, 4, 2),
          patchLuminance(pixels, width, width - 4, height - 2, 4, 2),
        ];
        corners.forEach((corner, i) => expect(center - corner, `${look}, wall ${wall}, corner ${i}`).toBeGreaterThan(1.5));
      }
    }
  });

  it('M11 AC5: empty space is brighter with wall 1 than by default, and than with wall 0, in both looks', async () => {
    for (const look of LOOKS) {
      const dark = topCenter(await emptyPicture(look, 0));
      const normal = topCenter(await emptyPicture(look));
      const lit = topCenter(await emptyPicture(look, 1));
      expect(normal, `${look}: default against wall 0`).toBeGreaterThan(dark + 5);
      expect(lit, `${look}: wall 1 against the default`).toBeGreaterThan(normal + 5);
    }
  });

  it('M11 AC5: the two looks draw the same wall', async () => {
    const finished = await emptyPicture('finished');
    const cells = await emptyPicture('cells');
    // The finished look's round trip through linear light may land a value on the other side of a rounding boundary.
    finished.forEach((value, i) => expect(Math.abs(value - cells[i]), `byte ${i}`).toBeLessThanOrEqual(1));
  });
});
