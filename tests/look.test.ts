import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { Display } from '../src/display';
import { ELEMENT as T, ELEMENTS, type ElementDef } from '../src/elements';
import { effectiveTemp, GLOW_START, ROOM_TEMP } from '../src/heat';
import type { Look, LookSettings } from '../src/look';
import type { Simulation } from '../src/simulation';
import { gaussian } from './air-pulse';
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
  /** The frame's time in seconds. */
  time?: number;
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
    time: options.time,
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

  // A cell that radiates (fire, and what is hot at room temperature: lava and molten metal sit at their thresholds) has a halo
  // around it, so it is drawn alone; the others stand side by side.
  const radiates = (e: ElementDef): boolean => (e.life !== undefined && e.graphics !== undefined) || effectiveTemp(e, ROOM_TEMP) >= GLOW_START;

  // A gas is a soft cloud in the finished look (M11.5), not a cell: it is not drawn in its cells-look color.
  const cloud = (e: ElementDef): boolean => e.state === 'gas';

  it('M11 AC3: a cell with nothing around it is drawn in its cells-look color, for every element of the table', async () => {
    const width = 64;
    const row = everyElementRow(width);
    ROWS.filter((e) => radiates(e) || cloud(e)).forEach((e) => { row.kind[ROWS.indexOf(e)] = 0; });
    const sim = createSim(width, 1);
    sim.load(row);
    const finished = await render(sim, width, 1, { look: 'finished' });
    const cells = await render(sim, width, 1, { look: 'cells' });
    ROWS.filter((e) => !radiates(e) && !cloud(e)).forEach((e) => {
      const i = ROWS.indexOf(e);
      pixelAt(finished, width, i, 0).forEach((channel, c) => {
        expect(Math.abs(channel - cells[i * 4 + c]), `${e.key}, channel ${c}`).toBeLessThanOrEqual(1);
      });
    });

    for (const e of ROWS.filter(radiates)) {
      const alone = everyElementRow(width);
      alone.kind.fill(0);
      alone.life.fill(0);
      alone.kind[10] = cell(e.id);
      alone.life[10] = e.life?.start ?? 0;
      const lone = createSim(width, 1);
      lone.load(alone);
      const finishedAlone = await render(lone, width, 1, { look: 'finished' });
      const cellsAlone = await render(lone, width, 1, { look: 'cells' });
      pixelAt(finishedAlone, width, 10, 0).forEach((channel, c) => {
        expect(Math.abs(channel - cellsAlone[10 * 4 + c]), `${e.key} alone, channel ${c}`).toBeLessThanOrEqual(1);
      });
    }
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

// A block of one element, `w` by `h` cells with its lower left cell at (x, y), world rows counted from the bottom.
interface Block { x: number; y: number; w: number; h: number; type: number; temp: number; life?: number }

function blockSim(width: number, height: number, blocks: readonly Block[]): Simulation {
  const kind = new Uint32Array(width * height);
  const life = new Uint32Array(width * height);
  const temp = new Uint32Array(width * height);
  const temps = tempView({ temp });
  temps.fill(ROOM_TEMP);
  for (const b of blocks) {
    for (let j = 0; j < b.h; j++) {
      for (let i = 0; i < b.w; i++) {
        const at = (b.y + j) * width + b.x + i;
        kind[at] = cell(b.type);
        life[at] = b.life ?? 0;
        temps[at] = b.temp;
      }
    }
  }
  const sim = createSim(width, height);
  sim.load({ kind, life, temp });
  return sim;
}

// The finished look's picture with the halo and the same picture without it (`glowStrength` 0): their difference is the
// halo alone, the dither and every other effect cancel.
async function withAndWithoutHalo(sim: Simulation, width: number, height: number): Promise<{ lit: Uint8Array; dark: Uint8Array }> {
  return {
    lit: await render(sim, width, height),
    dark: await render(sim, width, height, { settings: { glowStrength: 0 } }),
  };
}

// How much brighter pixel (x, y) is in `lit`, y counted from the bottom of the world.
const gainAt = (lit: Uint8Array, dark: Uint8Array, width: number, height: number, x: number, y: number): number => {
  const i = (height - 1 - y) * width + x;
  return luminanceOf(lit.slice(i * 4, i * 4 + 3)) - luminanceOf(dark.slice(i * 4, i * 4 + 3));
};

describe.skipIf(!device)('M11.3 glow', () => {
  const width = 128;
  const height = 64;
  const pool = { x: 48, y: 24, w: 32, h: 16 };
  const poolSim = (temp: number): Simulation => blockSim(width, height, [{ ...pool, type: T.LAVA, temp }]);

  // The summed brightness the halo adds outside the pool.
  async function addedAround(sim: Simulation, inside: { x: number; y: number; w: number; h: number }): Promise<number> {
    const { lit, dark } = await withAndWithoutHalo(sim, width, height);
    let sum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= inside.x && x < inside.x + inside.w && y >= inside.y && y < inside.y + inside.h) continue;
        sum += gainAt(lit, dark, width, height, x, y);
      }
    }
    return sum;
  }

  it('M11 AC7: empty cells within 8 cells of a lava pool at 1,300 °C are brighter, more so the nearer, and the cells look is unchanged', async () => {
    const sim = poolSim(1300);
    const { lit, dark } = await withAndWithoutHalo(sim, width, height);
    const middle = pool.y + pool.h / 2;
    const gains = Array.from({ length: 8 }, (_, k) => gainAt(lit, dark, width, height, pool.x + pool.w + k, middle));
    gains.forEach((gain, k) => expect(gain, `${k + 1} cells from the pool`).toBeGreaterThan(1));
    // Brighter the nearer: never rising with the distance by more than a step of rounding, and clearly lower at 8 cells than at 1.
    for (let k = 1; k < gains.length; k++) expect(gains[k], `${k + 1} against ${k} cells`).toBeLessThanOrEqual(gains[k - 1] + 1);
    expect(gains[0]).toBeGreaterThan(gains[7] + 1);
    // Above and to the left too.
    expect(gainAt(lit, dark, width, height, pool.x + 8, pool.y + pool.h + 2)).toBeGreaterThan(1);
    expect(gainAt(lit, dark, width, height, pool.x - 3, middle)).toBeGreaterThan(1);

    const cellsLook = await render(sim, width, height, { look: 'cells' });
    const cellsLookNoGlow = await render(sim, width, height, { look: 'cells', settings: { glowStrength: 0 } });
    expect(cellsLook).toEqual(cellsLookNoGlow);
  });

  it('M11 AC8: the summed brightness the halo adds grows from lava at 1,000 to 1,300 to 1,700 °C', async () => {
    // Lava below its 1,200 °C threshold shines at the threshold: 1,000 °C is the dimmest it can be drawn.
    const added: number[] = [];
    for (const temp of [1000, 1300, 1700]) added.push(await addedAround(poolSim(temp), pool));
    expect(added[0], 'lava at 1,000 °C').toBeGreaterThan(0);
    expect(added[1], '1,300 against 1,000 °C').toBeGreaterThan(added[0]);
    expect(added[2], '1,700 against 1,300 °C').toBeGreaterThan(added[1]);
  });

  it('M11 AC8: metal at 500 °C and every element but fire at 20 °C add no halo', async () => {
    // Lava and molten metal are never colder than their thresholds, which are over 525 °C: they are the glow test above.
    const cases: { label: string; type: number; temp: number; life?: number }[] = [
      { label: 'metal at 500 °C', type: T.METAL, temp: 500 },
      ...ROWS
        .filter((e) => e.key !== 'EMPTY' && e.key !== 'FIRE' && effectiveTemp(e, ROOM_TEMP) < GLOW_START)
        .map((e) => ({ label: `${e.key} at 20 °C`, type: e.id, temp: ROOM_TEMP, life: e.life?.start })),
    ];
    const spacing = 6;
    const worldWidth = Math.ceil((cases.length * spacing + 2) / 64) * 64;
    const worldHeight = 32;
    const sim = blockSim(worldWidth, worldHeight, cases.map((c, i) => ({ x: 2 + i * spacing, y: 14, w: 4, h: 4, type: c.type, temp: c.temp, life: c.life })));
    const { lit, dark } = await withAndWithoutHalo(sim, worldWidth, worldHeight);
    cases.forEach((c, i) => {
      // The stretch of the picture from the gap before the block to the gap after it.
      for (let y = 0; y < worldHeight; y++) {
        for (let x = 1 + i * spacing; x < 1 + (i + 1) * spacing; x++) {
          expect(gainAt(lit, dark, worldWidth, worldHeight, x, y), `${c.label} at (${x}, ${y})`).toBe(0);
        }
      }
    });
  });

  describe('M11 AC9: a flying grain', () => {
    const grainWidth = 64;
    const grainHeight = 200;

    // A sand grain dropped from near the top, run until it is in the air (it launches after 48 supersteps and flies until the 81st).
    async function flyingGrain(temp: number): Promise<{ sim: Simulation; x: number; y: number }> {
      const sim = blockSim(grainWidth, grainHeight, [{ x: 4, y: 190, w: 1, h: 1, type: T.SAND, temp }]);
      await runMany(sim, 60);
      const flyers = await sim.flyers.read();
      expect(flyers, 'the grain is in the air').toHaveLength(1);
      return { sim, x: Math.floor(flyers[0].x), y: Math.floor(flyers[0].y) };
    }

    it('adds a halo around itself in the finished look at 1,500 °C and none in the cells look', async () => {
      const { sim, x, y } = await flyingGrain(1500);
      const { lit, dark } = await withAndWithoutHalo(sim, grainWidth, grainHeight);
      // The eight cells two cells from the grain.
      const ring = [-2, 0, 2].flatMap((dx) => [-2, 0, 2]
        .filter((dy) => dx !== 0 || dy !== 0)
        .map((dy) => gainAt(lit, dark, grainWidth, grainHeight, x + dx, y + dy)));
      ring.forEach((gain, i) => expect(gain, `ring cell ${i}`).toBeGreaterThanOrEqual(0));
      expect(ring.reduce((a, b) => a + b, 0) / ring.length, 'the mean gain of the ring').toBeGreaterThan(2);

      const cellsLook = await render(sim, grainWidth, grainHeight, { look: 'cells' });
      const cellsLookNoGlow = await render(sim, grainWidth, grainHeight, { look: 'cells', settings: { glowStrength: 0 } });
      expect(cellsLook).toEqual(cellsLookNoGlow);
    });

    it('adds no halo at 20 °C', async () => {
      const { sim } = await flyingGrain(ROOM_TEMP);
      const { lit, dark } = await withAndWithoutHalo(sim, grainWidth, grainHeight);
      expect(lit).toEqual(dark);
    });
  });
});

describe.skipIf(!device)('M11.4 shadows', () => {
  const width = 192;
  const height = 192;
  // Aligned to the cover texels (4 cells) so the shadow's edges fall on texel boundaries; lower right corner at (56, 152).
  const stone: Block = { x: 24, y: 152, w: 32, h: 16, type: T.STONE, temp: ROOM_TEMP };
  const fireLife = ROWS.find((e) => e.key === 'FIRE')!.life!.start;

  // The picture with the shadows and the same picture without them (`shadowDarkness` 0): their difference is the shadow alone,
  // the dither and every other effect cancel.
  async function withAndWithoutShadows(sim: Simulation): Promise<{ on: Uint8Array; off: Uint8Array }> {
    return {
      on: await render(sim, width, height),
      off: await render(sim, width, height, { settings: { shadowDarkness: 0 } }),
    };
  }

  // How much darker pixel (x, y) is with the shadows, y counted from the bottom of the world.
  const darkening = (p: { on: Uint8Array; off: Uint8Array }, x: number, y: number): number => gainAt(p.off, p.on, width, height, x, y);

  it('M11 AC10: a stone block darkens the empty pixels on its far side by at least 10 steps, fading to 0 beyond 96 cells', async () => {
    const p = await withAndWithoutShadows(blockSim(width, height, [stone]));
    // Beside the block (2 cells from its right edge and from its bottom edge), on the side away from the light.
    expect(darkening(p, 58, 160), 'right of the block').toBeGreaterThanOrEqual(10);
    expect(darkening(p, 40, 150), 'below the block').toBeGreaterThanOrEqual(10);
    // Down the diagonal from the lower right corner, the way the light travels: never darker the farther, nothing beyond 96 cells.
    const fade = [6, 20, 40].map((d) => darkening(p, 56 + d, 151 - d));
    expect(fade[0], 'near the corner').toBeGreaterThanOrEqual(5);
    expect(fade[1]).toBeLessThanOrEqual(fade[0] + 1);
    expect(fade[2]).toBeLessThanOrEqual(fade[1] + 1);
    // 84 cells along each axis is 119 cells from the corner, 29.7 cover texels against a length of 24.
    expect(darkening(p, 56 + 84, 151 - 84), 'beyond 96 cells').toBe(0);
  });

  it('M11 AC10: nothing darkens toward the light', async () => {
    const p = await withAndWithoutShadows(blockSim(width, height, [stone]));
    // Left, above and upper left of the block, and above its right: 10 cells from its edges.
    for (const [x, y] of [[14, 160], [40, 178], [14, 178], [66, 178]]) {
      expect(darkening(p, x, y), `(${x}, ${y})`).toBe(0);
    }
  });

  it('M11 AC10: a water block darkens less than a stone block', async () => {
    const stoneShade = darkening(await withAndWithoutShadows(blockSim(width, height, [stone])), 58, 160);
    const waterShade = darkening(await withAndWithoutShadows(blockSim(width, height, [{ ...stone, type: T.WATER }])), 58, 160);
    expect(waterShade, 'water').toBeGreaterThan(0);
    expect(waterShade, 'water against stone').toBeLessThan(stoneShade);
  });

  it('M11 AC10: smoke and fire darken nothing', async () => {
    for (const block of [{ ...stone, type: T.SMOKE }, { ...stone, type: T.FIRE, life: fireLife }]) {
      const p = await withAndWithoutShadows(blockSim(width, height, [block]));
      expect(p.on, ROWS.find((e) => e.id === block.type)!.key).toEqual(p.off);
    }
  });

  it('M11 AC10: no filled cell changes, and the cells look changes nothing', async () => {
    const blocks: Block[] = [
      stone,
      { x: 100, y: 100, w: 16, h: 16, type: T.WATER, temp: ROOM_TEMP },
      { x: 30, y: 60, w: 8, h: 8, type: T.SAND, temp: ROOM_TEMP },
    ];
    const sim = blockSim(width, height, blocks);
    const p = await withAndWithoutShadows(sim);
    expect(p.on, 'the shadows are there').not.toEqual(p.off);
    for (const b of blocks) {
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) {
          const row = height - 1 - y;
          expect(pixelAt(p.on, width, x, row), `(${x}, ${y})`).toEqual(pixelAt(p.off, width, x, row));
        }
      }
    }
    const cellsLook = await render(sim, width, height, { look: 'cells' });
    const cellsLookNoShadow = await render(sim, width, height, { look: 'cells', settings: { shadowDarkness: 0 } });
    expect(cellsLook).toEqual(cellsLookNoShadow);
  });
});

describe.skipIf(!device)('M11.5 soft gases', () => {
  const width = 256;
  const height = 256;
  // Aligned to the cover texels (4 cells) so the block fills whole texels; lower left corner at (112, 112).
  const smoke: Block = { x: 112, y: 112, w: 32, h: 32, type: T.SMOKE, temp: 150 };
  // The block's inside, 6 cells from its edges: the cloud's bilinear edge reaches 2 cells in.
  const inside = { x0: smoke.x + 6, x1: smoke.x + smoke.w - 6, y0: smoke.y + 6, y1: smoke.y + smoke.h - 6 };

  // The luminance of the pixels of the cells x0..x1, y0..y1 (y from the bottom of the world).
  function insideLuminances(pixels: Uint8Array): number[] {
    const lums: number[] = [];
    for (let y = inside.y0; y < inside.y1; y++) {
      for (let x = inside.x0; x < inside.x1; x++) lums.push(luminanceOf(pixelAt(pixels, width, x, height - 1 - y)));
    }
    return lums;
  }
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
  const lumAt = (pixels: Uint8Array, x: number, y: number): number => luminanceOf(pixelAt(pixels, width, x, height - 1 - y));

  it('M11 AC11: the pixels inside a 32×32 block of smoke lie within 4 steps of each other, and the block is a cloud over the wall', async () => {
    const empty = await render(blockSim(width, height, []), width, height);
    const block = await render(blockSim(width, height, [smoke]), width, height);
    expect(spread(insideLuminances(block))).toBeLessThanOrEqual(4);
    expect(mean(insideLuminances(block)) - mean(insideLuminances(empty)), 'brighter than the wall').toBeGreaterThan(20);
  });

  it('M11 AC11: a block of smoke cells in a checkerboard is a smooth layer too, not dots', async () => {
    const dots: Block[] = [];
    for (let j = 0; j < smoke.h; j++) {
      for (let i = 0; i < smoke.w; i++) if ((i + j) % 2 === 0) dots.push({ ...smoke, x: smoke.x + i, y: smoke.y + j, w: 1, h: 1 });
    }
    const pixels = await render(blockSim(width, height, dots), width, height);
    expect(spread(insideLuminances(pixels))).toBeLessThanOrEqual(4);
  });

  it('M11 AC11: a lone smoke cell tints its surroundings less than the center of the block', async () => {
    const empty = await render(blockSim(width, height, []), width, height);
    const block = await render(blockSim(width, height, [smoke]), width, height);
    const lone = await render(blockSim(width, height, [{ ...smoke, x: 128, y: 128, w: 1, h: 1 }]), width, height);
    const blockTint = lumAt(block, 128, 128) - lumAt(empty, 128, 128);
    let loneTint = 0;
    for (let y = 120; y <= 136; y++) {
      for (let x = 120; x <= 136; x++) loneTint = Math.max(loneTint, Math.abs(lumAt(lone, x, y) - lumAt(empty, x, y)));
    }
    expect(loneTint, 'the cell shows').toBeGreaterThan(0);
    expect(loneTint, 'against the block center').toBeLessThan(blockTint);
  });

  it('M11 AC11: smoke at 1,000 °C is brighter than at 150 °C', async () => {
    const cool = await render(blockSim(width, height, [smoke]), width, height);
    const hot = await render(blockSim(width, height, [{ ...smoke, temp: 1000 }]), width, height);
    expect(mean(insideLuminances(hot))).toBeGreaterThan(mean(insideLuminances(cool)) + 1);
  });

  it('M11 AC11: the cells look draws the dots as today, and so does the finished look with gas opacity 0', async () => {
    const dot = blockSim(width, height, [{ ...smoke, x: 128, y: 128, w: 1, h: 1 }]);
    const empty = blockSim(width, height, []);
    const table = ROWS.find((e) => e.id === T.SMOKE)!.color;
    for (const options of [{ look: 'cells' as const }, { look: 'finished' as const, settings: { gasOpacity: 0 } }]) {
      const pixels = await render(dot, width, height, options);
      const wall = await render(empty, width, height, options);
      pixelAt(pixels, width, 128, height - 1 - 128).forEach((channel, c) => {
        expect(Math.abs(channel - table[c] * 255), `${options.look}, channel ${c}`).toBeLessThanOrEqual(1);
      });
      // Nothing around the dot changes.
      for (const [x, y] of [[127, 128], [129, 128], [128, 127], [128, 129], [124, 124]]) {
        expect(pixelAt(pixels, width, x, height - 1 - y), `${options.look} (${x}, ${y})`).toEqual(pixelAt(wall, width, x, height - 1 - y));
      }
    }
    // The setting does not reach the cells look.
    expect(await render(dot, width, height, { look: 'cells', settings: { gasOpacity: 0.3 } })).toEqual(await render(dot, width, height, { look: 'cells' }));
  });
});

describe.skipIf(!device)('M11.6 liquid depth and surface', () => {
  const width = 64;
  const height = 160;
  // A pool 128 cells deep under open air, aligned to the cover texels (4 cells); its top row is y = 135.
  const pool: Block = { x: 16, y: 8, w: 32, h: 128, type: T.WATER, temp: ROOM_TEMP };
  const top = pool.y + pool.h - 1;
  const column = 32;

  // The color of the pool's cell `below` rows under its top row, in the middle of the pool.
  const at = (pixels: Uint8Array, below: number): number[] => pixelAt(pixels, width, column, height - 1 - (top - below));
  const lumAt = (pixels: Uint8Array, below: number): number => luminanceOf(at(pixels, below));
  const redToBlue = (pixels: Uint8Array, below: number): number => at(pixels, below)[0] / at(pixels, below)[2];
  const poolOf = (type: number, temp = ROOM_TEMP): Simulation => blockSim(width, height, [{ ...pool, type, temp }]);

  it('M11 AC12: the surface row is brighter than the row 8 cells below', async () => {
    const pixels = await render(poolOf(T.WATER), width, height);
    expect(lumAt(pixels, 0), 'the surface row against 8 cells below').toBeGreaterThan(lumAt(pixels, 8) + 10);
    // The line fades over the top rows.
    expect(lumAt(pixels, 0)).toBeGreaterThan(lumAt(pixels, 2));
    expect(lumAt(pixels, 2)).toBeGreaterThan(lumAt(pixels, 4));
  });

  it('M11 AC12: below the top 4 rows the luminance and the red-to-blue ratio do not rise with depth and fall over the pool', async () => {
    const pixels = await render(poolOf(T.WATER), width, height);
    // Each channel only darkens with depth, so the luminance of the bytes never rises from one row to the next.
    for (let below = 5; below < pool.h; below++) {
      expect(lumAt(pixels, below), `row ${below} against ${below - 1}`).toBeLessThanOrEqual(lumAt(pixels, below - 1));
    }
    // A byte of rounding moves the ratio by about 0.02 in a row: sampled every 8 rows it is steady.
    for (let below = 12; below < pool.h; below += 8) {
      expect(redToBlue(pixels, below), `ratio at row ${below}`).toBeLessThanOrEqual(redToBlue(pixels, below - 8) + 0.01);
    }
    expect(lumAt(pixels, 4) - lumAt(pixels, pool.h - 1), 'luminance lost over the pool').toBeGreaterThanOrEqual(10);
    expect(redToBlue(pixels, 4) - redToBlue(pixels, pool.h - 1), 'red lost against blue over the pool').toBeGreaterThan(0.1);
  });

  it('M11 AC12: water under a stone ceiling has no surface line', async () => {
    const roofed = blockSim(width, height, [pool, { x: pool.x, y: pool.y + pool.h, w: pool.w, h: 8, type: T.STONE, temp: ROOM_TEMP }]);
    const open = poolOf(T.WATER);
    const withLine = await render(roofed, width, height);
    const withoutLine = await render(roofed, width, height, { settings: { liquidSurface: 0 } });
    for (let below = 0; below < pool.h; below++) expect(at(withLine, below), `row ${below}`).toEqual(at(withoutLine, below));
    // The open pool does have one.
    expect(at(await render(open, width, height), 0)).not.toEqual(at(await render(open, width, height, { settings: { liquidSurface: 0 } }), 0));
  });

  it('M11 AC12: oil is darker than water at the same depth', async () => {
    const water = await render(poolOf(T.WATER), width, height);
    const oil = await render(poolOf(T.OIL), width, height);
    for (const below of [0, 8, 32, 64, pool.h - 1]) expect(lumAt(oil, below), `${below} rows down`).toBeLessThan(lumAt(water, below));
  });

  it('M11 AC12: lava does not change with depth', async () => {
    const lava = ROWS.find((e) => e.key === 'LAVA')!;
    const pixels = await render(poolOf(T.LAVA, lava.temperature), width, height);
    for (let below = 1; below < pool.h; below++) expect(at(pixels, below), `row ${below}`).toEqual(at(pixels, 0));
  });

  it('M11 AC12: the cells look draws the pool flat, and with no surface and no depth the finished look does within a step', async () => {
    const sim = poolOf(T.WATER);
    const cells = await render(sim, width, height, { look: 'cells' });
    for (let below = 1; below < pool.h; below++) expect(at(cells, below), `row ${below}`).toEqual(at(cells, 0));
    const plain = await render(sim, width, height, { settings: { liquidSurface: 0, depthScale: 0 } });
    for (let below = 0; below < pool.h; below++) {
      at(plain, below).forEach((channel, c) => expect(Math.abs(channel - at(cells, below)[c]), `row ${below}, channel ${c}`).toBeLessThanOrEqual(1));
    }
    // The settings do not reach the cells look.
    expect(await render(sim, width, height, { look: 'cells', settings: { liquidSurface: 0, depthScale: 0 } })).toEqual(cells);
  });
});

describe.skipIf(!device)('M11.7 air shimmer', () => {
  const width = 128;
  const height = 64;
  // Without the effects that spread light over the wall, so a shifted pixel is found in the unshifted picture within the
  // wall's own slow gradient.
  const PLAIN: Partial<LookSettings> = { shadowDarkness: 0, glowStrength: 0, gasOpacity: 0, depthScale: 0, liquidSurface: 0 };
  const OFF: Partial<LookSettings> = { ...PLAIN, shimmer: 0, shimmerPressure: 0 };
  const TOLERANCE = 2;

  // A striped backdrop: a 4 cell wide column of WALL at every other 4 cells, over the full height.
  function stripedSim(options: { air?: boolean } = {}): Simulation {
    const kind = new Uint32Array(width * height);
    const temp = new Uint32Array(width * height);
    tempView({ temp }).fill(ROOM_TEMP);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.floor(x / 4) % 2 === 0) kind[y * width + x] = cell(T.WALL);
    const sim = createSim(width, height, 1, options.air === false ? { air: false } : {});
    sim.load({ kind, temp });
    return sim;
  }

  const hotAir = (sim: Simulation, celsius: number): void => {
    sim.air.load({ temperature: new Float32Array(sim.air.columns * sim.air.rows).fill(celsius) });
  };

  // How many pixels of `shifted` have no pixel of `reference` within `radius` cells that has their color within `TOLERANCE`.
  function unmatched(shifted: Uint8Array, reference: Uint8Array, radius: number): number {
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let found = false;
        for (let dy = -radius; dy <= radius && !found; dy++) {
          for (let dx = -radius; dx <= radius && !found; dx++) {
            const sx = Math.min(width - 1, Math.max(0, x + dx));
            const sy = Math.min(height - 1, Math.max(0, y + dy));
            found = [0, 1, 2].every((c) => Math.abs(shifted[(y * width + x) * 4 + c] - reference[(sy * width + sx) * 4 + c]) <= TOLERANCE);
          }
        }
        if (!found) count++;
      }
    }
    return count;
  }

  const differing = (a: Uint8Array, b: Uint8Array): number => a.reduce((n, value, i) => n + (value === b[i] ? 0 : 1), 0);

  it('M11 AC13: air at rest at room temperature gives the same frame at any time, and with the shimmer off', async () => {
    const sim = stripedSim();
    sim.air.load();
    const start = await render(sim, width, height, { time: 0 });
    expect(await render(sim, width, height, { time: 5 })).toEqual(start);
    expect(await render(sim, width, height, { time: 0, settings: { shimmer: 0, shimmerPressure: 0 } })).toEqual(start);
  });

  it('M11 AC13: without air the frame does not depend on time either', async () => {
    const sim = stripedSim({ air: false });
    expect(await render(sim, width, height, { time: 5 })).toEqual(await render(sim, width, height, { time: 0 }));
  });

  it('M11 AC14: over air at 600 °C the frame changes with time, and every pixel is found within 3 cells of its place', async () => {
    const sim = stripedSim();
    hotAir(sim, 600);
    const reference = await render(sim, width, height, { settings: OFF });
    const first = await render(sim, width, height, { time: 0, settings: PLAIN });
    const later = await render(sim, width, height, { time: 0.5, settings: PLAIN });
    expect(differing(first, later), 'bytes that differ between time 0 and 0.5 s').toBeGreaterThan(0);
    // The stripes move: a good part of the picture is not what the unshifted frame shows.
    expect(differing(first, reference), 'bytes that differ from the unshifted frame').toBeGreaterThan(width * height / 10);
    expect(unmatched(first, reference, 3), 'pixels not found within 3 cells (time 0)').toBe(0);
    expect(unmatched(later, reference, 3), 'pixels not found within 3 cells (time 0.5)').toBe(0);
  });

  it('M11 AC14: hotter air shifts more than air a few degrees above room temperature', async () => {
    const warm = stripedSim();
    hotAir(warm, ROOM_TEMP + 20);
    const hot = stripedSim();
    hotAir(hot, 600);
    const reference = await render(warm, width, height, { settings: OFF });
    const warmShift = differing(await render(warm, width, height, { time: 1, settings: PLAIN }), reference);
    const hotShift = differing(await render(hot, width, height, { time: 1, settings: PLAIN }), reference);
    expect(hotShift).toBeGreaterThan(warmShift);
  });

  it('M11 AC14: a pressure pulse shifts pixels too, within 3 cells', async () => {
    const sim = stripedSim();
    sim.air.load({ pressure: gaussian(sim, 16, 8, 6, undefined, 2) });
    const reference = await render(sim, width, height, { settings: OFF });
    const pulsed = await render(sim, width, height, { settings: PLAIN });
    expect(differing(pulsed, reference), 'bytes that differ from the unshifted frame').toBeGreaterThan(0);
    expect(unmatched(pulsed, reference, 3)).toBe(0);
    // It does not move with time: the pulse's shift comes from the gradient alone.
    expect(await render(sim, width, height, { time: 3, settings: PLAIN })).toEqual(pulsed);
  });

  it('M11 AC14: the cells look and the views are not shifted', async () => {
    const sim = stripedSim();
    hotAir(sim, 600);
    for (const options of [{ look: 'cells' as const }, { heatView: true }, { airView: true }]) {
      const off = await render(sim, width, height, { ...options, settings: { shimmer: 0, shimmerPressure: 0 } });
      expect(await render(sim, width, height, { ...options, time: 0.7 }), JSON.stringify(options)).toEqual(off);
    }
  });
});
