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

const TOOLBAR_HEIGHT = 48;
const simWidth = window.innerWidth;
const simHeight = window.innerHeight - TOOLBAR_HEIGHT;
renderer.setSize(simWidth, simHeight);

const simulation = new Simulation(renderer, simWidth, simHeight);
const display = new Display(simWidth, simHeight);
const input = new InputHandler(canvas, simWidth, simHeight);

const SPEED_STEPS = [1, 2, 4, 8, 16, 24, 32];
const SPEED_LABELS = ['1/16x', '1/8x', '1/4x', '1/2x', '1x', '1.5x', '2x'];
let speedIndex = 4;
let stepsPerFrame = SPEED_STEPS[speedIndex];

let lastDrawPos: Vec2 = { x: -1, y: -1 };

// --- UI wiring ---
const fpsEl = document.getElementById('fps')!;
const brushEl = document.getElementById('brush-size')!;
const gridEl = document.getElementById('grid-info')!;
const helpHint = document.getElementById('help-hint') as HTMLElement;
const speedDisplay = document.getElementById('speed-display')!;

function updateSpeedDisplay(): void {
  speedDisplay.textContent = `Speed: ${SPEED_LABELS[speedIndex]}`;
}
updateSpeedDisplay();

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

const typeMap: Record<string, number> = { '1': PARTICLE_TYPES.SAND, '2': PARTICLE_TYPES.WALL, '3': PARTICLE_TYPES.WATER };
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

// --- Resize handling (keeps sim resolution fixed, scales display) ---
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight - TOOLBAR_HEIGHT);
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

  simulation.simulate(stepsPerFrame, {
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
