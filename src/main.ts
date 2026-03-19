import { initGPU } from './gpu';
import { Simulation } from './simulation';
import { Display } from './display';
import { InputHandler, type Vec2 } from './input';
import { PARTICLE_TYPES } from './particles';

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const TOOLBAR_HEIGHT = 48;
  const simWidth = window.innerWidth;
  const simHeight = window.innerHeight - TOOLBAR_HEIGHT;
  canvas.width = simWidth;
  canvas.height = simHeight;

  let gpu;
  try {
    gpu = await initGPU(canvas);
  } catch (err) {
    document.body.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.style.cssText =
      'color:#fff;background:#111;display:flex;align-items:center;justify-content:center;' +
      'height:100vh;font:18px sans-serif;text-align:center;padding:2rem;';
    errDiv.textContent = err instanceof Error ? err.message : 'WebGPU initialization failed.';
    document.body.appendChild(errDiv);
    return;
  }

  const { device, context, format } = gpu;
  const simulation = new Simulation(device, simWidth, simHeight);
  const display = new Display(device, format, simWidth, simHeight, simulation.bufferA, simulation.bufferB);
  const input = new InputHandler(canvas, simWidth, simHeight);

  const SPEED_STEPS = [1, 2, 4, 8, 16, 24, 32];
  const SPEED_LABELS = ['1/4x', '1/2x', '1x', '2x', '4x', '6x', '8x'];
  let speedIndex = 2;
  let stepsPerFrame = SPEED_STEPS[speedIndex];

  let lastDrawPos: Vec2 = { x: -1, y: -1 };

  // --- UI wiring ---
  const fpsEl = document.getElementById('fps')!;
  const brushEl = document.getElementById('brush-size')!;
  const gridEl = document.getElementById('grid-info')!;
  const helpHint = document.getElementById('help-hint') as HTMLElement;
  const speedDisplay = document.getElementById('speed-display')!;
  const particleCountEl = document.getElementById('particle-count')!;

  function updateSpeedDisplay(): void {
    speedDisplay.textContent = `Speed: ${SPEED_LABELS[speedIndex]}`;
  }
  updateSpeedDisplay();

  gridEl.textContent = `${simWidth}×${simHeight} (${((simWidth * simHeight) / 1e6).toFixed(1)}M cells)`;

  setTimeout(() => { helpHint.style.opacity = '0'; }, 4000);

  const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-type]');
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      input.particleType = Number(btn.dataset.type);
    });
  });

  const typeMap: Record<string, number> = { '1': PARTICLE_TYPES.SAND, '2': PARTICLE_TYPES.WALL, '3': PARTICLE_TYPES.WATER, '4': PARTICLE_TYPES.SMOKE, '5': PARTICLE_TYPES.OIL, '6': PARTICLE_TYPES.FIRE };
  document.addEventListener('keydown', (e) => {
    if (typeMap[e.key] !== undefined) {
      toolButtons.forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.type) === typeMap[e.key]);
      });
    }
    if (e.key === '[' && speedIndex > 0) {
      speedIndex--;
      stepsPerFrame = SPEED_STEPS[speedIndex];
      updateSpeedDisplay();
    }
    if (e.key === ']' && speedIndex < SPEED_STEPS.length - 1) {
      speedIndex++;
      stepsPerFrame = SPEED_STEPS[speedIndex];
      updateSpeedDisplay();
    }
  });

  document.getElementById('speed-down')!.addEventListener('click', () => {
    if (speedIndex > 0) {
      speedIndex--;
      stepsPerFrame = SPEED_STEPS[speedIndex];
      updateSpeedDisplay();
    }
  });
  document.getElementById('speed-up')!.addEventListener('click', () => {
    if (speedIndex < SPEED_STEPS.length - 1) {
      speedIndex++;
      stepsPerFrame = SPEED_STEPS[speedIndex];
      updateSpeedDisplay();
    }
  });

  document.getElementById('clear-btn')!.addEventListener('click', () => {
    simulation.clear();
  });

  // --- FPS tracking ---
  let lastFpsTime = performance.now();
  let frameCount = 0;
  let lastCountTime = performance.now();

  // --- Resize handling (keeps sim resolution fixed, reconfigures swap chain) ---
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - TOOLBAR_HEIGHT;
    context.configure({ device, format, alphaMode: 'opaque' });
  });

  // --- Async particle counting (fire-and-forget with stale display) ---
  function updateParticleDisplay(count: number): void {
    if (count >= 1_000_000) {
      particleCountEl.textContent = `${(count / 1_000_000).toFixed(2)}M particles`;
    } else if (count >= 1_000) {
      particleCountEl.textContent = `${(count / 1_000).toFixed(1)}K particles`;
    } else {
      particleCountEl.textContent = `${count} particles`;
    }
  }

  // --- Animation loop ---
  function animate(): void {
    requestAnimationFrame(animate);

    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 500) {
      const fps = Math.round(frameCount / ((now - lastFpsTime) / 1000));
      fpsEl.textContent = `${fps} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }

    brushEl.textContent = `Brush: ${input.brushSize}`;

    const mouseActive = input.mouseActive;
    const erasing = input.erasing;

    const prevMousePos = mouseActive && lastDrawPos.x >= 0
      ? lastDrawPos
      : input.mousePos;

    simulation.simulate(stepsPerFrame, {
      mousePos: input.mousePos,
      prevMousePos,
      mouseActive,
      erasing,
      replacing: input.shiftDown && !erasing,
      brushSize: input.brushSize,
      particleType: input.particleType,
    });

    if (mouseActive) {
      lastDrawPos = { x: input.mousePos.x, y: input.mousePos.y };
    } else {
      lastDrawPos = { x: -1, y: -1 };
    }

    // Async particle counting
    if (now - lastCountTime >= 2000 && !mouseActive) {
      lastCountTime = now;
      simulation.requestParticleCount();
    }

    const encoder = device.createCommandEncoder();
    const targetView = context.getCurrentTexture().createView();
    display.render(encoder, targetView, simulation.currentBuffer, canvas.width, canvas.height, {
      mousePos: input.mousePos,
      brushSize: input.brushSize,
      showBrush: true,
      erasing,
      replacing: input.shiftDown && !erasing,
    });

    device.queue.submit([encoder.finish()]);

    // Read back particle count (non-blocking)
    simulation.readParticleCount().then(updateParticleDisplay).catch(() => {});
  }

  animate();
}

main();
