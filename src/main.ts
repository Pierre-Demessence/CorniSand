import * as THREE from 'three';
import { Simulation } from './simulation';
import { Display } from './display';
import { InputHandler, type Vec2 } from './input';
import { PARTICLE_TYPES } from './particles';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});
renderer.autoClear = false;

const simWidth = window.innerWidth;
const simHeight = window.innerHeight;
renderer.setSize(simWidth, simHeight);

const simulation = new Simulation(renderer, simWidth, simHeight);
const display = new Display(simWidth, simHeight);
const input = new InputHandler(canvas, simWidth, simHeight);

const STEPS_PER_FRAME = 16;

let lastDrawPos: Vec2 = { x: -1, y: -1 };

// --- UI wiring ---
const fpsEl = document.getElementById('fps')!;
const brushEl = document.getElementById('brush-size')!;
const gridEl = document.getElementById('grid-info')!;
const helpHint = document.getElementById('help-hint') as HTMLElement;

gridEl.textContent = `${simWidth}×${simHeight} (${((simWidth * simHeight) / 1e6).toFixed(1)}M cells)`;

setTimeout(() => { helpHint.style.opacity = '0'; }, 4000);

const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-btn');
toolButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    toolButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    input.particleType = Number(btn.dataset.type);
  });
});

const typeMap: Record<string, number> = { '1': PARTICLE_TYPES.SAND, '2': PARTICLE_TYPES.WALL };
document.addEventListener('keydown', (e) => {
  if (typeMap[e.key] !== undefined) {
    toolButtons.forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.type) === typeMap[e.key]);
    });
  }
});

document.getElementById('clear-btn')!.addEventListener('click', () => {
  simulation.clear();
});

// --- FPS tracking ---
let lastFpsTime = performance.now();
let frameCount = 0;

// --- Resize handling (keeps sim resolution fixed, scales display) ---
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
});

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

  simulation.simulate(STEPS_PER_FRAME, {
    mousePos: input.mousePos,
    prevMousePos,
    mouseActive,
    erasing,
    brushSize: input.brushSize,
    particleType: input.particleType,
  });

  if (mouseActive) {
    lastDrawPos = { x: input.mousePos.x, y: input.mousePos.y };
  } else {
    lastDrawPos = { x: -1, y: -1 };
  }

  display.render(renderer, simulation.texture, {
    mousePos: input.mousePos,
    brushSize: input.brushSize,
    showBrush: true,
    erasing,
  });
}

animate();
