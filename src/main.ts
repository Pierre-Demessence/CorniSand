import { initGPU, showBanner, showReloadOverlay, type GPUContext } from './gpu';
import { computeGrid, maxCellsForDevice, type Grid } from './grid';
import { Simulation } from './simulation';
import { Display } from './display';
import { InputHandler, type Vec2 } from './input';
import { findScene, type Scene } from './scenes';

interface GpuState {
  gpu: GPUContext;
  simulation: Simulation;
  display: Display;
}

const TOOLBAR_HEIGHT = 48;
// A device that keeps getting lost is not coming back; stop retrying.
const MAX_RECOVERIES = 3;
const TOUCH_TIP_MS = 1500;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight - TOOLBAR_HEIGHT;
  canvas.width = cssWidth;
  canvas.height = cssHeight;

  // `?scene=<name>` replaces the empty world with a test scene and sizes the grid to it.
  const sceneName = new URLSearchParams(window.location.search).get('scene');
  let pendingScene: Scene | undefined;
  if (sceneName !== null) {
    pendingScene = findScene(sceneName);
    if (!pendingScene) console.warn(`Unknown scene "${sceneName}", starting with an empty world.`);
  }
  const sceneLabel = pendingScene?.name;

  // Sized once from the first device's limits (or the scene's size); a re-created device keeps the same grid.
  let grid: Grid | undefined;
  let state: GpuState | null = null;
  let recoveries = 0;
  // Each recovery attempt gets a number; a result from an older attempt is dropped.
  let attempt = 0;

  async function createGpuState(): Promise<GpuState> {
    const gpu = await initGPU(canvas, onDeviceLost);
    grid ??= pendingScene
      ? { width: pendingScene.width, height: pendingScene.height, scale: 1 }
      : computeGrid(cssWidth, cssHeight, maxCellsForDevice(gpu.device));
    const simulation = new Simulation(gpu.device, grid.width, grid.height);
    // Only the first device gets the scene; after a device loss the world is cleared, as the banner says.
    if (pendingScene) {
      simulation.load(pendingScene.fields);
      pendingScene = undefined;
    }
    const display = new Display(gpu.device, gpu.format, grid.width, grid.height, simulation.fields);
    return { gpu, simulation, display };
  }

  function onDeviceLost(): void {
    state = null; // the frame loop idles until the new device is ready
    if (recoveries >= MAX_RECOVERIES) {
      showReloadOverlay();
      return;
    }
    recoveries++;
    const mine = ++attempt;
    createGpuState().then((next) => {
      if (mine !== attempt) return;
      state = next;
      showBanner('The GPU device was lost and has been re-created. The world was cleared.');
    }).catch((err: unknown) => {
      if (mine !== attempt) return;
      console.error('GPU recovery failed:', err);
      showReloadOverlay();
    });
  }

  try {
    state = await createGpuState();
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

  const { width: simWidth, height: simHeight, scale } = grid!;
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

  function changeSpeed(delta: number): void {
    speedIndex = Math.min(SPEED_STEPS.length - 1, Math.max(0, speedIndex + delta));
    stepsPerFrame = SPEED_STEPS[speedIndex];
    speedDisplay.textContent = `Speed: ${SPEED_LABELS[speedIndex]}`;
  }
  changeSpeed(0);

  const cells = `${((simWidth * simHeight) / 1e6).toFixed(1)}M cells`;
  gridEl.textContent = `${simWidth}×${simHeight} (${cells}${scale > 1 ? `, ${scale}px each` : ''})${sceneLabel ? ` · scene ${sceneLabel}` : ''}`;

  setTimeout(() => { helpHint.style.opacity = '0'; }, 4000);

  const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-type]');
  function selectTool(button: HTMLButtonElement): void {
    toolButtons.forEach((b) => b.classList.toggle('active', b === button));
    input.particleType = Number(button.dataset.type);
  }
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => selectTool(btn));
  });

  document.addEventListener('keydown', (e) => {
    // Keys 1-6 pick the n-th toolbar button.
    const button = toolButtons[Number(e.key) - 1] as HTMLButtonElement | undefined;
    if (button) selectTool(button);
    if (e.key === '[') changeSpeed(-1);
    if (e.key === ']') changeSpeed(1);
  });

  document.getElementById('speed-down')!.addEventListener('click', () => changeSpeed(-1));
  document.getElementById('speed-up')!.addEventListener('click', () => changeSpeed(1));

  // Touch has no hover or focus ring, so a tap shows the tooltip for a moment.
  document.querySelectorAll<HTMLElement>('[data-tip]').forEach((el) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      el.classList.add('tip-visible');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('tip-visible'), TOUCH_TIP_MS);
    });
  });

  document.getElementById('clear-btn')!.addEventListener('click', () => {
    state?.simulation.clear();
  });

  // --- FPS tracking ---
  let lastFpsTime = performance.now();
  let frameCount = 0;
  let lastCountTime = performance.now();

  // --- Resize handling (keeps sim resolution fixed, reconfigures swap chain) ---
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - TOOLBAR_HEIGHT;
    if (state) {
      const { device, context, format } = state.gpu;
      context.configure({ device, format, alphaMode: 'opaque' });
    }
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
    if (!state) return;
    const { gpu: { device, context }, simulation, display } = state;

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
    const replacing = input.shiftDown && !erasing;

    const prevMousePos = mouseActive && lastDrawPos.x >= 0
      ? lastDrawPos
      : input.mousePos;

    if (mouseActive) {
      lastDrawPos = { x: input.mousePos.x, y: input.mousePos.y };
    } else {
      lastDrawPos = { x: -1, y: -1 };
    }

    // Async particle counting (own submit, ordered before this frame's work)
    if (now - lastCountTime >= 2000 && !mouseActive) {
      lastCountTime = now;
      simulation.requestParticleCount();
    }

    // Brush, CA steps and render share one encoder and one submit.
    const encoder = device.createCommandEncoder();
    simulation.simulate(encoder, stepsPerFrame, {
      mousePos: input.mousePos,
      prevMousePos,
      mouseActive,
      erasing,
      replacing,
      brushSize: input.brushSize,
      particleType: input.particleType,
    });
    display.render(encoder, context.getCurrentTexture().createView(), canvas.width, canvas.height, {
      mousePos: input.mousePos,
      brushSize: input.brushSize,
      showBrush: true,
      erasing,
      replacing,
    });
    device.queue.submit([encoder.finish()]);

    // Read back particle count (non-blocking)
    simulation.readParticleCount().then(updateParticleDisplay).catch(() => {});
  }

  animate();
}

void main();
