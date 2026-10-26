import { describe, expect, it } from 'vitest';
import { Display } from '../src/display';
import { ELEMENT as T } from '../src/elements';
import { cell, createSim, device, loadScene } from './gpu';

// One grid cell per pixel: 64 pixels of 4 bytes are one 256-byte row, the alignment a texture copy needs.
const WIDTH = 64;

async function renderRow(kind: Uint32Array<ArrayBuffer>, life: Uint32Array<ArrayBuffer>): Promise<Uint8Array> {
  const dev = device!;
  const sim = createSim(WIDTH, 1);
  loadScene(sim, kind, life);
  const display = new Display(dev, 'rgba8unorm', WIDTH, 1, sim.fields, sim.elements, sim.flyers.overlay);
  const target = dev.createTexture({
    size: [WIDTH, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const staging = dev.createBuffer({ size: WIDTH * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = dev.createCommandEncoder();
  display.render(encoder, target.createView(), WIDTH, 1, {
    mousePos: { x: 0, y: 0 },
    brushSize: 0,
    showBrush: false,
    erasing: false,
    replacing: false,
  });
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: WIDTH * 4 }, [WIDTH, 1]);
  dev.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  target.destroy();
  return pixels;
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
