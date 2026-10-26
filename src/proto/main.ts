import { showBanner } from '../gpu';
import { MovementProto } from './movement';
import type { MovementModel } from './params';
import { blastScene, pourScene, windScene, type ProtoScene } from './scenes';

// Dev-only page (proto.html) of the M4.1 prototype: movement models A and C side by side on the same scene.

const SUPERSTEPS_PER_FRAME = 4;
const CLICK_RADIUS = 32;
const CLICK_SPEED = 8;
const STATS_INTERVAL_MS = 500;

interface Half {
  model: MovementModel;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  stats: HTMLElement;
  proto: MovementProto | null;
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU is not supported in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Could not find a suitable GPU adapter.');
  const device = await adapter.requestDevice();
  device.onuncapturederror = (event) => {
    console.error('WebGPU error:', event.error.message);
    showBanner(`WebGPU error: ${event.error.message}`);
  };
  void device.lost.then((info) => {
    if (info.reason !== 'destroyed') showBanner(`WebGPU device lost: ${info.message}`);
  });
  const format = navigator.gpu.getPreferredCanvasFormat();

  const halves: Half[] = (['a', 'c'] as const).map((model) => {
    const canvas = element<HTMLCanvasElement>(`canvas-${model}`);
    const context = canvas.getContext('webgpu')!;
    context.configure({ device, format, alphaMode: 'opaque' });
    return { model, canvas, context, stats: element(`stats-${model}`), proto: null };
  });

  const sceneSelect = element<HTMLSelectElement>('scene');
  let scene: ProtoScene;
  let pourLeft = 0;

  function load(): void {
    const name = sceneSelect.value;
    if (name === 'pour') {
      const pour = pourScene();
      pourLeft = pour.pourSupersteps;
      scene = pour;
    } else {
      pourLeft = 0;
      scene = name === 'wind' ? windScene() : blastScene();
    }
    for (const half of halves) {
      // Every scene has the same size, so each half keeps its simulation and only reloads it.
      if (!half.proto) {
        half.canvas.width = scene.width;
        half.canvas.height = scene.height;
        half.proto = new MovementProto(device, scene.width, scene.height, { model: half.model, seed: 11 });
      }
      const proto = half.proto;
      proto.load(scene.cells);
      proto.setSource(scene.source ?? null);
      proto.setWind(...(scene.wind ?? [0, 0]));
      if (scene.blast) proto.blast(scene.blast.x, scene.blast.y, scene.blast.radius, scene.blast.speed);
    }
  }

  sceneSelect.addEventListener('change', load);
  element('reset').addEventListener('click', load);
  for (const half of halves) {
    half.canvas.addEventListener('pointerdown', (event) => {
      const rect = half.canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * scene.width);
      const y = Math.floor((1 - (event.clientY - rect.top) / rect.height) * scene.height);
      for (const other of halves) other.proto!.blast(x, y, CLICK_RADIUS, CLICK_SPEED);
    });
  }

  load();

  let statsDue = 0;
  let readingStats = false;
  function frame(now: number): void {
    const encoder = device.createCommandEncoder();
    for (const half of halves) {
      half.proto!.simulate(encoder, SUPERSTEPS_PER_FRAME);
      half.proto!.render(encoder, half.context.getCurrentTexture().createView(), format);
    }
    device.queue.submit([encoder.finish()]);
    if (pourLeft > 0) {
      pourLeft -= SUPERSTEPS_PER_FRAME;
      if (pourLeft <= 0) for (const half of halves) half.proto!.setSource(null);
    }
    if (now >= statsDue && !readingStats) {
      statsDue = now + STATS_INTERVAL_MS;
      readingStats = true;
      const c = halves[1];
      void c.proto!.readStats().then((stats) => {
        c.stats.textContent = `${stats.live} grains in flight`;
      }).finally(() => {
        readingStats = false;
      });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((error: unknown) => {
  console.error(error);
  showBanner(error instanceof Error ? error.message : String(error));
});
