import { describe, expect, it } from 'vitest';
import { tempView } from '../src/cell-fields';
import { Display } from '../src/display';
import { ELEMENT as T } from '../src/elements';
import { AIR, AIR_VIEW, PRESSURE_RAMP } from '../src/air';
import { GLOW_RAMP, HEAT_LEGEND_TEMPS, HEAT_RAMP, heatRampCSS, type RampKnot } from '../src/heat';
import type { Simulation } from '../src/simulation';
import { toggleView } from '../src/toolbar';
import { cell, createSim, device, runMany } from './gpu';

// One grid cell per pixel: 64 pixels of 4 bytes are one 256-byte row, the alignment a texture copy needs.
const WIDTH = 64;

interface RowOptions {
  /** Stored temperature per cell; the element's own when absent. */
  temps?: readonly number[];
  heatView?: boolean;
}

// Renders a sim `WIDTH` columns wide, one pixel per cell, flyers included; 64 pixels are one 256-byte row, the alignment a copy needs.
async function renderSim(sim: Simulation, height: number, heatView = false, airView = false): Promise<Uint8Array> {
  const dev = device!;
  const display = new Display(dev, 'rgba8unorm', WIDTH, height, sim.fields, sim.elements, sim.flyers.overlay, sim.air);
  const target = dev.createTexture({
    size: [WIDTH, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const staging = dev.createBuffer({ size: WIDTH * 4 * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = dev.createCommandEncoder();
  sim.recordOverlay(encoder);
  display.render(encoder, target.createView(), WIDTH, height, {
    mousePos: { x: 0, y: 0 },
    brushSize: 0,
    showBrush: false,
    erasing: false,
    replacing: false,
    heatView,
    airView,
  });
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: WIDTH * 4 }, [WIDTH, height]);
  dev.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  target.destroy();
  return pixels;
}

async function renderRow(kind: Uint32Array<ArrayBuffer>, life: Uint32Array<ArrayBuffer>, options: RowOptions = {}): Promise<Uint8Array> {
  const sim = createSim(WIDTH, 1);
  const temp = new Uint32Array(WIDTH);
  if (options.temps) tempView({ temp }).set(options.temps);
  sim.load({ kind, life, ...(options.temps && { temp }) });
  return renderSim(sim, 1, options.heatView);
}

describe.skipIf(!device)('display colors', () => {
  it('draw each element in the color of its table row, and fire from bright to ember with its life', async () => {
    const kind = new Uint32Array(WIDTH);
    const life = new Uint32Array(WIDTH);
    const cases: [number, [number, number, number]][] = [
      [T.SAND, [0.80, 0.70, 0.48]],
      [T.WALL, [0.43, 0.45, 0.47]],
      [T.WATER, [0.18, 0.42, 0.72]],
      [T.SMOKE, [0.72, 0.72, 0.74]],
      [T.OIL, [0.22, 0.16, 0.10]],
      [T.FIRE, [1.0, 0.72, 0.12]],
      [T.FIRE, [0.90, 0.45, 0.08]],
      [T.FIRE, [0.80, 0.18, 0.04]],
    ];
    cases.forEach(([type], i) => { kind[i] = cell(type); });
    // Fire life 200 is full brightness, 100 halfway between the ember and the bright color, 0 the ember color.
    life[5] = 200;
    life[6] = 100;
    life[7] = 0;

    const pixels = await renderRow(kind, life);

    cases.forEach(([, rgb], i) => {
      rgb.forEach((channel, c) => {
        expect(pixels[i * 4 + c], `cell ${i}, channel ${c}`).toBeGreaterThanOrEqual(Math.round(channel * 255) - 1);
        expect(pixels[i * 4 + c], `cell ${i}, channel ${c}`).toBeLessThanOrEqual(Math.round(channel * 255) + 1);
      });
    });
  });
});

// Rec. 709 luminance of the pixel at cell i, 0 to 255.
function luminance(pixels: Uint8Array, i: number): number {
  return 0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];
}

function pixel(pixels: Uint8Array, i: number): number[] {
  return [...pixels.slice(i * 4, i * 4 + 3)];
}

// A row of one element with one temperature per cell.
function rowOf(type: number, temps: readonly number[]): { kind: Uint32Array<ArrayBuffer>; life: Uint32Array<ArrayBuffer>; temps: number[] } {
  const kind = new Uint32Array(WIDTH);
  temps.forEach((_, i) => { kind[i] = cell(type); });
  return { kind, life: new Uint32Array(WIDTH), temps: [...temps] };
}

describe.skipIf(!device)('M5.5b heat on the display', () => {
  it('AC19: an element without its own graphics glows brighter the hotter it is above 525 °C, and not below', async () => {
    // Metal at 800 and 1,500 stays under its 1,538 °C melting point; lava has no upper threshold.
    const metal = rowOf(T.METAL, [20, 500, 525, 800, 1500]);
    const metalPixels = await renderRow(metal.kind, metal.life, { temps: metal.temps });
    expect(pixel(metalPixels, 1), 'metal at 500 °C is its plain color').toEqual(pixel(metalPixels, 0));
    expect(pixel(metalPixels, 2), 'metal at 525 °C is its plain color').toEqual(pixel(metalPixels, 0));
    expect(luminance(metalPixels, 3)).toBeGreaterThan(luminance(metalPixels, 2));
    expect(luminance(metalPixels, 4)).toBeGreaterThan(luminance(metalPixels, 3));

    // The glow is at full weight from 2,000 °C, as the heat view's ramp ends there.
    const lava = rowOf(T.LAVA, [1000, 1300, 1700, 2000]);
    const lavaPixels = await renderRow(lava.kind, lava.life, { temps: lava.temps });
    for (let i = 1; i < lava.temps.length; i++) {
      expect(luminance(lavaPixels, i), `lava at ${lava.temps[i]} °C`).toBeGreaterThan(luminance(lavaPixels, i - 1));
    }
  });

  it('AC19: the glow never darkens a light base color, and fire keeps its own graphics', async () => {
    const smoke = rowOf(T.SMOKE, [20, 1500]);
    const smokePixels = await renderRow(smoke.kind, smoke.life, { temps: smoke.temps });
    for (let c = 0; c < 3; c++) expect(smokePixels[4 + c], `hot smoke, channel ${c}`).toBeGreaterThanOrEqual(smokePixels[c]);

    const fire = rowOf(T.FIRE, [20, 1000, 3000]);
    fire.life.fill(200);
    const firePixels = await renderRow(fire.kind, fire.life, { temps: fire.temps });
    expect(pixel(firePixels, 1), 'fire at 1,000 °C').toEqual(pixel(firePixels, 0));
    expect(pixel(firePixels, 2), 'fire at 3,000 °C').toEqual(pixel(firePixels, 0));
  });

  it('AC17: in the heat view the luminance of a cell that holds heat strictly increases from -50 to 2,000 °C', async () => {
    const temps = [-50, 0, 20, 100, 300, 600, 1000, 1500, 2000];
    const sand = rowOf(T.SAND, temps);
    const pixels = await renderRow(sand.kind, sand.life, { temps, heatView: true });
    for (let i = 1; i < temps.length; i++) {
      expect(luminance(pixels, i), `${temps[i]} °C against ${temps[i - 1]} °C`).toBeGreaterThan(luminance(pixels, i - 1));
    }
  });

  it('AC17: in the heat view the colors come from the temperature, not the element, and empty space and walls ignore it', async () => {
    const kind = new Uint32Array(WIDTH);
    kind[0] = cell(T.SAND);
    kind[1] = cell(T.WATER);
    kind[2] = cell(T.METAL);
    kind[3] = cell(T.WALL);
    kind[4] = cell(T.WALL);
    // Cells 5 and 6 stay empty, with unrelated temp words.
    // 50 °C lies inside every element's range: a cell shows its stored temperature clamped to its thresholds.
    const temps = [50, 50, 50, 0, 1500, 0, 1500];
    const pixels = await renderRow(kind, new Uint32Array(WIDTH), { temps, heatView: true });

    expect(pixel(pixels, 1), 'water at 50 °C looks like sand at 50 °C').toEqual(pixel(pixels, 0));
    expect(pixel(pixels, 2), 'metal at 50 °C looks like sand at 50 °C').toEqual(pixel(pixels, 0));
    expect(pixel(pixels, 4), 'a wall ignores its temp word').toEqual(pixel(pixels, 3));
    // The background is dithered per pixel (about one level), so empty cells match within 2 levels.
    pixel(pixels, 5).forEach((channel, c) => expect(Math.abs(channel - pixels[6 * 4 + c])).toBeLessThanOrEqual(2));
    // A wall is dimmed to 30% of its table color (0.43, 0.45, 0.47).
    [0.43, 0.45, 0.47].forEach((channel, c) => expect(Math.abs(pixels[3 * 4 + c] - Math.round(channel * 0.3 * 255))).toBeLessThanOrEqual(1));
  });

  it('AC17: a flyer over empty space keeps its element color in both views, while a resting cell takes its heat color', async () => {
    const height = 200;
    const sim = createSim(WIDTH, height);
    const kind = new Uint32Array(WIDTH * height);
    const temp = new Uint32Array(WIDTH * height);
    kind[190 * WIDTH + 4] = cell(T.SAND);
    // A resting grain on the floor (row 0) at the same temperature, to tell the heat color from the element color.
    kind[20] = cell(T.SAND);
    tempView({ temp }).fill(1500);
    sim.load({ kind, temp });
    // The grain launches after 48 supersteps (drag slows the fall in the grid) and is in the air until the 81st.
    await runMany(sim, 60);
    const flyers = await sim.flyers.read();
    expect(flyers, 'the grain is in the air').toHaveLength(1);
    // Row 0 of the world is the bottom of the picture.
    const at = (height - 1 - Math.floor(flyers[0].y)) * WIDTH + Math.floor(flyers[0].x);
    const sand = [0.80, 0.70, 0.48].map((c) => Math.round(c * 255));

    for (const heatView of [false, true]) {
      const pixels = await renderSim(sim, height, heatView);
      pixel(pixels, at).forEach((channel, c) => expect(Math.abs(channel - sand[c]), `flyer, channel ${c}, heat view ${heatView}`).toBeLessThanOrEqual(1));
    }
    const rest = await renderSim(sim, height, true);
    const resting = pixel(rest, (height - 1) * WIDTH + 20);
    expect(resting.some((channel, c) => Math.abs(channel - sand[c]) > 20), 'the resting grain is drawn in its heat color').toBe(true);
  });
});

describe('M5.5b heat ramp', () => {
  const lum = (k: RampKnot): number => 0.2126 * k.color[0] + 0.7152 * k.color[1] + 0.0722 * k.color[2];

  it.each([['heat view', HEAT_RAMP], ['glow', GLOW_RAMP]])('AC17: the %s ramp has rising temperatures and strictly rising luminance', (_, ramp) => {
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i].temp, `knot ${i}`).toBeGreaterThan(ramp[i - 1].temp);
      expect(lum(ramp[i]), `knot ${i}`).toBeGreaterThan(lum(ramp[i - 1]));
    }
  });

  it('AC17: the legend spans the ramp and its gradient has one stop per knot, from 0% to 100%', () => {
    expect(HEAT_LEGEND_TEMPS[0]).toBe(HEAT_RAMP[0].temp);
    expect(HEAT_LEGEND_TEMPS[HEAT_LEGEND_TEMPS.length - 1]).toBe(HEAT_RAMP[HEAT_RAMP.length - 1].temp);
    const css = heatRampCSS();
    expect(css.match(/rgb\(/g)).toHaveLength(HEAT_RAMP.length);
    expect(css).toMatch(/ 0\.00%/);
    expect(css).toMatch(/ 100\.00%\)$/);
  });

  it('AC17: the legend labels sit far enough apart to be read side by side', () => {
    // The legend is 360 px wide and a three-digit label about 24 px, so 7% of the range keeps neighbors clear.
    const span = HEAT_LEGEND_TEMPS[HEAT_LEGEND_TEMPS.length - 1] - HEAT_LEGEND_TEMPS[0];
    for (let i = 1; i < HEAT_LEGEND_TEMPS.length; i++) {
      expect((HEAT_LEGEND_TEMPS[i] - HEAT_LEGEND_TEMPS[i - 1]) / span, `labels ${HEAT_LEGEND_TEMPS[i - 1]} and ${HEAT_LEGEND_TEMPS[i]}`).toBeGreaterThanOrEqual(0.07);
    }
  });
});

// The ramp's color at position t: linear between knots, flat beyond the first and last.
function rampColor(ramp: readonly RampKnot[], t: number): number[] {
  if (t <= ramp[0].temp) return [...ramp[0].color];
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i].temp) {
      const f = (t - ramp[i - 1].temp) / (ramp[i].temp - ramp[i - 1].temp);
      return ramp[i].color.map((c, k) => ramp[i - 1].color[k] + (c - ramp[i - 1].color[k]) * f);
    }
  }
  return [...ramp[ramp.length - 1].color];
}

// An empty sim of `WIDTH` columns and `height` rows with the default air (cells of 4 x 4).
function airSim(height: number): { sim: Simulation; columns: number; rows: number } {
  const sim = createSim(WIDTH, height);
  return { sim, columns: sim.air.columns, rows: sim.air.rows };
}

// The pixel (RGB) of the picture at column x of the world row y (the picture's first row is the world's top).
const pixelAt = (pixels: Uint8Array, height: number, x: number, y: number): number[] => pixel(pixels, (height - 1 - y) * WIDTH + x);

const luminanceOf = ([r, g, b]: number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe.skipIf(!device)('M6.6b air view', () => {
  it('M6 AC21: the luminance of empty space strictly increases with the pressure, from -viewRange to +viewRange', async () => {
    const height = 8;
    const { sim, columns, rows } = airSim(height);
    const pressure = new Float32Array(columns * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) pressure[j * columns + i] = -AIR.viewRange + (2 * AIR.viewRange * i) / (columns - 1);
    }
    sim.air.load({ pressure });
    const pixels = await renderSim(sim, height, false, true);
    const lum = (i: number): number => luminanceOf(pixelAt(pixels, height, 4 * i + 2, 4));
    // The last air cell is left out: its right half blends toward the ghost air beyond the edge.
    for (let i = 1; i < columns - 1; i++) expect(lum(i), `air cell ${i} against ${i - 1}`).toBeGreaterThan(lum(i - 1));
  });

  it('M6 AC21: air at rest is the ramp\'s middle, and a material is drawn at 30% over it', async () => {
    const height = 8;
    const { sim } = airSim(height);
    const kind = new Uint32Array(WIDTH * height);
    kind[3 * WIDTH + 20] = cell(T.SAND);
    sim.load({ kind });
    const pixels = await renderSim(sim, height, false, true);
    const grey = rampColor(PRESSURE_RAMP, 0);
    const sand = [0.80, 0.70, 0.48];
    pixelAt(pixels, height, 40, 5).forEach((channel, c) => expect(Math.abs(channel - grey[c] * 255), `empty, channel ${c}`).toBeLessThanOrEqual(2));
    pixelAt(pixels, height, 20, 3).forEach((channel, c) => {
      expect(Math.abs(channel - (0.7 * grey[c] + 0.3 * sand[c]) * 255), `sand, channel ${c}`).toBeLessThanOrEqual(2);
    });
  });

  // The light pixels (luminance above 200) of the wind mark in the bottom left tile, as the [x, y] of their centers.
  async function lightPixels(velocityX: number): Promise<number[][]> {
    const height = 32;
    const { sim, columns, rows } = airSim(height);
    sim.air.load({ velocityX: new Float32Array(columns * rows).fill(velocityX) });
    const pixels = await renderSim(sim, height, false, true);
    const lit: number[][] = [];
    for (let y = 0; y < AIR_VIEW.spacing; y++) {
      for (let x = 0; x < AIR_VIEW.spacing; x++) {
        if (luminanceOf(pixelAt(pixels, height, x, y)) > 200) lit.push([x + 0.5, y + 0.5]);
      }
    }
    return lit;
  }

  it('M6 AC21: wind is drawn as marks that grow with its speed and are absent in still air', async () => {
    const counts: number[] = [];
    for (const v of [0, 0.02, 0.2, 1, 2]) counts.push((await lightPixels(v)).length);
    expect(counts[0], 'still air').toBe(0);
    expect(counts[1], 'a breath of wind is below the shortest mark').toBe(0);
    expect(counts[2], 'wind 0.2').toBeGreaterThan(0);
    expect(counts[3], 'wind 1').toBeGreaterThan(counts[2]);
    expect(counts[4], 'wind 2').toBeGreaterThan(counts[3]);
  });

  it('M6 AC21: the arrowhead of a mark is on its downwind end', async () => {
    const center = AIR_VIEW.spacing / 2;
    for (const [v, sign] of [[1, 1], [-1, -1]]) {
      const lit = await lightPixels(v);
      const head = lit.filter(([, y]) => Math.abs(y - center) > 1);
      expect(head.length, `wind ${v}: pixels off the line`).toBeGreaterThan(0);
      for (const [x] of head) expect((x - center) * sign, `wind ${v}, pixel at ${x}`).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!device)('M6.6b heat view of the air', () => {
  it('M6 AC22: in the heat view empty space is the heat ramp\'s color of its air temperature at half brightness', async () => {
    const height = 8;
    for (const temperature of [20, 300, 1200]) {
      const { sim, columns, rows } = airSim(height);
      sim.air.load({ temperature: new Float32Array(columns * rows).fill(temperature) });
      const pixels = await renderSim(sim, height, true);
      const expected = rampColor(HEAT_RAMP, temperature);
      pixelAt(pixels, height, 30, 4).forEach((channel, c) => {
        expect(Math.abs(channel - expected[c] * 0.5 * 255), `${temperature} °C, channel ${c}`).toBeLessThanOrEqual(2);
      });
    }
  });

  it('M6 AC22: the luminance of empty space strictly increases with its air temperature', async () => {
    const height = 8;
    const { sim, columns, rows } = airSim(height);
    const temperature = new Float32Array(columns * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) temperature[j * columns + i] = -50 + (2050 * i) / (columns - 1);
    }
    sim.air.load({ temperature });
    const pixels = await renderSim(sim, height, true);
    const lum = (i: number): number => luminanceOf(pixelAt(pixels, height, 4 * i + 2, 4));
    // The last air cell is left out: its right half blends toward the ghost air beyond the edge.
    for (let i = 1; i < columns - 1; i++) expect(lum(i), `air cell ${i} against ${i - 1}`).toBeGreaterThan(lum(i - 1));
  });

  it('M6 AC22: without air the heat view leaves empty space as the background', async () => {
    const sim = createSim(WIDTH, 1, 1, { air: false });
    const pixels = await renderSim(sim, 1, true);
    // The heat color of room temperature at half brightness has a green channel of 6; the background's is about 20.
    expect(pixels[1]).toBeGreaterThan(14);
  });
});

describe('M6.6b air view ramp and toggle', () => {
  const lum = (k: RampKnot): number => 0.2126 * k.color[0] + 0.7152 * k.color[1] + 0.0722 * k.color[2];

  it('M6 AC21: the pressure ramp runs from -viewRange to +viewRange through 0 with strictly rising luminance', () => {
    expect(PRESSURE_RAMP[0].temp).toBe(-AIR.viewRange);
    expect(PRESSURE_RAMP[PRESSURE_RAMP.length - 1].temp).toBe(AIR.viewRange);
    expect(PRESSURE_RAMP.map((k) => k.temp)).toContain(0);
    for (let i = 1; i < PRESSURE_RAMP.length; i++) {
      expect(PRESSURE_RAMP[i].temp, `knot ${i}`).toBeGreaterThan(PRESSURE_RAMP[i - 1].temp);
      expect(lum(PRESSURE_RAMP[i]), `knot ${i}`).toBeGreaterThan(lum(PRESSURE_RAMP[i - 1]));
    }
  });

  it('M6 AC21: the legend gradient has one stop per knot, from 0% to 100%', () => {
    const css = heatRampCSS(PRESSURE_RAMP);
    expect(css.match(/rgb\(/g)).toHaveLength(PRESSURE_RAMP.length);
    expect(css).toMatch(/ 0\.00%/);
    expect(css).toMatch(/ 100\.00%\)$/);
  });

  it('M6 AC21: turning a view on turns the other off, and toggling it again turns it off', () => {
    const off = { heat: false, air: false };
    const heat = toggleView(off, 'heat');
    expect(heat).toEqual({ heat: true, air: false });
    const air = toggleView(heat, 'air');
    expect(air).toEqual({ heat: false, air: true });
    expect(toggleView(air, 'heat')).toEqual({ heat: true, air: false });
    expect(toggleView(air, 'air')).toEqual(off);
  });
});
