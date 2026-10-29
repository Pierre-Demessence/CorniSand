import { initGPU, showBanner, showReloadOverlay, type GPUContext } from './gpu';
import { computeGrid, maxCellsForDevice, type Grid } from './grid';
import { AIR_CELL_SIZES, AIR_LEGEND_PRESSURES, PRESSURE_RAMP } from './air';
import { Simulation, type CellProbe } from './simulation';
import { Display } from './display';
import { parseWall, type Look } from './look';
import { InputHandler, type Vec2 } from './input';
import { ELEMENTS, type ElementDef } from './elements';
import { findScene, SCENE_INFO, type Scene } from './scenes';
import { renderSceneMenu, sceneSearch } from './scene-menu';
import { HEAT_LEGEND_TEMPS, heatRampCSS } from './heat';
import { formatProbe } from './readout';
import { entryForKey, pickerTabs, renderAirViewToggle, renderHeatViewToggle, renderPicker, toggleView, type PickerEntry, type Tool, type Views } from './toolbar';

interface GpuState {
  gpu: GPUContext;
  simulation: Simulation;
  display: Display;
}

// A device that keeps getting lost is not coming back; stop retrying.
const MAX_RECOVERIES = 3;
/** The height of the picker and status bar at the bottom, set by the stylesheet. */
function toolbarHeight(): number {
  return document.getElementById('toolbar')!.offsetHeight;
}

const TOUCH_TIP_MS = 1500;
const PROBE_INTERVAL_MS = 100;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight - toolbarHeight();
  canvas.width = cssWidth;
  canvas.height = cssHeight;

  // `?scene=<name>` replaces the empty world with a test scene and sizes the grid to it.
  const sceneName = new URLSearchParams(window.location.search).get('scene');
  let pendingScene: Scene | undefined;
  if (sceneName !== null) {
    pendingScene = findScene(sceneName);
    if (!pendingScene) console.warn(`Unknown scene "${sceneName}", starting with an empty world.`);
  }
  // The key of the scene that opened, or null for the empty world (also when the key is unknown).
  const currentScene = pendingScene ? sceneName : null;
  const sceneLabel = currentScene === null ? undefined : SCENE_INFO[currentScene].label;

  // `?air=<size>` sets the grid cells per air cell (1, 2, 4 or 8) to compare resolutions; the default is the simulation's.
  const airParam = new URLSearchParams(window.location.search).get('air');
  const airSize = AIR_CELL_SIZES.find((size) => String(size) === airParam);
  if (airParam !== null && airSize === undefined) console.warn(`Unknown air size "${airParam}", use one of ${AIR_CELL_SIZES.join(', ')}.`);

  // `?wall=<0..1>` sets the wall's brightness, from near black (only hot things shine) to a lit room.
  const wallParam = new URLSearchParams(window.location.search).get('wall');
  const wall = parseWall(wallParam);
  if (wallParam !== null && wall === undefined) console.warn(`Unknown wall "${wallParam}", use a number from 0 to 1.`);

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
    const simulation = new Simulation(gpu.device, grid.width, grid.height, { airCellSize: airSize });
    // Only the first device gets the scene; after a device loss the world is cleared, as the banner says.
    if (pendingScene) {
      simulation.load(pendingScene.fields);
      pendingScene = undefined;
    }
    const display = new Display(gpu.device, gpu.format, grid.width, grid.height, simulation.fields, simulation.elements, simulation.flyers.overlay, {
      air: simulation.air,
      ...(wall !== undefined && { settings: { wall } }),
    });
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
  const probeEl = document.getElementById('probe-info')!;

  function changeSpeed(delta: number): void {
    speedIndex = Math.min(SPEED_STEPS.length - 1, Math.max(0, speedIndex + delta));
    stepsPerFrame = SPEED_STEPS[speedIndex];
    speedDisplay.textContent = `Speed: ${SPEED_LABELS[speedIndex]}`;
  }
  changeSpeed(0);

  const cells = `${((simWidth * simHeight) / 1e6).toFixed(1)}M cells`;
  gridEl.textContent = `${simWidth}×${simHeight} (${cells}${scale > 1 ? `, ${scale}px each` : ''})${sceneLabel ? ` · scene ${sceneLabel}` : ''}`;

  setTimeout(() => { helpHint.style.opacity = '0'; }, 4000);

  // Picking a scene reloads the page at its URL, so the link stays shareable and Back works.
  const sceneMenuEl = document.getElementById('scene-menu')!;
  renderSceneMenu(
    document.getElementById('scenes-btn') as HTMLButtonElement,
    sceneMenuEl,
    SCENE_INFO,
    currentScene,
    (key) => { window.location.search = sceneSearch(window.location.search, key); },
  );
  // The picker: a tab per category, the selected entry's name and the search; the entries of the shown tab below them.
  // Degrees per frame the held Heat or Cool tool applies; 0 while an element is selected.
  let heating = 0;
  // Whether the Wind tool is selected.
  let wind = false;
  function select(entry: PickerEntry): void {
    if (entry.kind === 'element') {
      heating = 0;
      wind = false;
      input.particleType = entry.id;
    } else {
      const tool: Tool = entry.tool;
      heating = tool.heating;
      wind = tool.air === 'wind';
    }
  }
  const tabs = pickerTabs(ELEMENTS);
  const initial = tabs[0].entries[0];
  const picker = renderPicker(
    {
      tabs: document.getElementById('picker-tabs')!,
      entries: document.getElementById('picker-entries')!,
      selected: document.getElementById('picker-selected')!,
      search: document.getElementById('picker-search') as HTMLInputElement,
    },
    tabs,
    initial,
    select,
  );
  select(initial);
  const viewButtonsEl = document.getElementById('view-buttons')!;

  // The heat view draws each cell that holds heat in its temperature's color; the legend explains the colors.
  const heatViewButton = renderHeatViewToggle(viewButtonsEl);
  const legend = document.getElementById('heat-legend')!;
  document.getElementById('heat-legend-bar')!.style.background = heatRampCSS();
  const legendLabels = document.getElementById('heat-legend-labels')!;
  const legendFirst = HEAT_LEGEND_TEMPS[0];
  const legendSpan = HEAT_LEGEND_TEMPS[HEAT_LEGEND_TEMPS.length - 1] - legendFirst;
  for (const t of HEAT_LEGEND_TEMPS) {
    const label = document.createElement('span');
    label.textContent = String(t);
    label.style.left = `${((t - legendFirst) / legendSpan) * 100}%`;
    legendLabels.appendChild(label);
  }
  // The air view draws the air's pressure and wind; it and the heat view each replace the materials' colors, so one is on at a time.
  const airViewButton = renderAirViewToggle(viewButtonsEl);
  const airLegend = document.getElementById('air-legend')!;
  document.getElementById('air-legend-bar')!.style.background = heatRampCSS(PRESSURE_RAMP);
  const airLegendLabels = document.getElementById('air-legend-labels')!;
  const airLegendFirst = AIR_LEGEND_PRESSURES[0];
  const airLegendSpan = AIR_LEGEND_PRESSURES[AIR_LEGEND_PRESSURES.length - 1] - airLegendFirst;
  for (const p of AIR_LEGEND_PRESSURES) {
    const label = document.createElement('span');
    label.textContent = p > 0 ? `+${p}` : String(p);
    label.style.left = `${((p - airLegendFirst) / airLegendSpan) * 100}%`;
    airLegendLabels.appendChild(label);
  }
  let views: Views = { heat: false, air: false };
  // The finished look is the default; C draws each cell as itself.
  let look: Look = 'finished';
  function toggle(which: keyof Views): void {
    views = toggleView(views, which);
    heatViewButton.setAttribute('aria-pressed', String(views.heat));
    legend.hidden = !views.heat;
    airViewButton.setAttribute('aria-pressed', String(views.air));
    airLegend.hidden = !views.air;
  }
  heatViewButton.addEventListener('click', () => toggle('heat'));
  airViewButton.addEventListener('click', () => toggle('air'));

  document.addEventListener('keydown', (e) => {
    // Typing in a search field, or any key while the Scenes menu is open, is not a game hotkey (C, H, A, /, digits, brackets).
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || !sceneMenuEl.hidden) return;
    if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key.toLowerCase() === 'h') toggle('heat');
      if (e.key.toLowerCase() === 'a') toggle('air');
      if (e.key.toLowerCase() === 'c') look = look === 'finished' ? 'cells' : 'finished';
      if (e.key === '/') {
        e.preventDefault();
        picker.focusSearch();
      }
    }
    // Keys 1-9 pick the n-th entry shown; with Ctrl, Alt or Meta they belong to the browser.
    const entry = entryForKey(picker.shown(), e);
    if (entry) picker.choose(entry);
    if (e.key === '[') changeSpeed(-1);
    if (e.key === ']') changeSpeed(1);
  });

  document.getElementById('speed-down')!.addEventListener('click', () => changeSpeed(-1));
  document.getElementById('speed-up')!.addEventListener('click', () => changeSpeed(1));

  // Touch has no hover or focus ring, so a tap shows the tooltip for a moment. One listener covers the picker's entries too, which are re-created.
  const tipTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !(e.target instanceof Element)) return;
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    el.classList.add('tip-visible');
    clearTimeout(tipTimers.get(el));
    tipTimers.set(el, setTimeout(() => el.classList.remove('tip-visible'), TOUCH_TIP_MS));
  });

  document.getElementById('clear-btn')!.addEventListener('click', () => {
    state?.simulation.clear();
  });

  // --- FPS tracking ---
  let lastFpsTime = performance.now();
  let frameCount = 0;
  let lastCountTime = performance.now();
  let lastProbeTime = 0;

  // --- Resize handling (keeps sim resolution fixed, reconfigures swap chain) ---
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - toolbarHeight();
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

  // --- Readout of the cell under the pointer ---
  // A drag that started on the canvas keeps the pointer captured outside it, so `pointerInside` alone is not enough.
  function overGrid(): boolean {
    const { x, y } = input.mousePos;
    return input.pointerInside && x >= 0 && x < simWidth && y >= 0 && y < simHeight;
  }
  const elementById = new Map<number, ElementDef>(ELEMENTS.map((e) => [e.id, e]));
  function updateProbeDisplay(probe: CellProbe | undefined): void {
    const element = elementById.get(probe?.type ?? -1);
    if (!probe || !element || !overGrid()) return;
    probeEl.textContent = formatProbe(element, probe);
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
    // The flyer brush removes flyers whenever `replacing` is set, so a heating or wind stroke never sets it.
    const replacing = input.shiftDown && !erasing && heating === 0 && !wind;

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
      heating,
      wind,
    });
    simulation.recordOverlay(encoder);
    display.render(encoder, context.getCurrentTexture().createView(), canvas.width, canvas.height, {
      mousePos: input.mousePos,
      brushSize: input.brushSize,
      showBrush: true,
      erasing,
      replacing,
      heatView: views.heat,
      airView: views.air,
      look,
      time: now / 1000,
    });
    // The probe copies the cell under the pointer at the end of the frame's encoder; an earlier one still in flight skips this frame.
    let probed = false;
    if (!overGrid()) {
      probeEl.textContent = '';
    } else if (now - lastProbeTime >= PROBE_INTERVAL_MS) {
      probed = simulation.probe(encoder, input.mousePos.x, input.mousePos.y);
      if (probed) lastProbeTime = now;
    }
    device.queue.submit([encoder.finish()]);
    if (probed) simulation.readProbe().then(updateProbeDisplay).catch(() => {});

    // Read back particle count (non-blocking)
    simulation.readParticleCount().then(updateParticleDisplay).catch(() => {});
  }

  animate();
}

void main();
