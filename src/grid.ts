import { MAX_FLUID_CELLS } from './fluid-params';
import { CELL_BYTES } from './shaders/cell.wgsl';

export interface Grid {
  width: number;
  height: number;
  // CSS pixels per cell edge; 1 unless the window is too large for the GPU's buffer limits.
  scale: number;
}

// The widest per-cell fluid buffer must fit one binding as well: the face weights (a vec4f) of every multigrid level,
// which together are about 4/3 of the fine level's.
const WIDEST_FLUID_CELL_BYTES = 22;

// Largest cell count the cell buffers and the per-cell fluid buffers can hold on this device, and the rasterization
// keys can index.
export function maxCellsForDevice(device: GPUDevice): number {
  const { maxStorageBufferBindingSize, maxBufferSize } = device.limits;
  const limit = Math.min(maxStorageBufferBindingSize, maxBufferSize);
  return Math.min(Math.floor(limit / CELL_BYTES), Math.floor(limit / WIDEST_FLUID_CELL_BYTES), MAX_FLUID_CELLS);
}

// One cell per CSS pixel, or the smallest integer cells-per-pixel scale that fits maxCells.
export function computeGrid(cssWidth: number, cssHeight: number, maxCells: number): Grid {
  if (maxCells < 1) throw new RangeError('maxCells must be at least 1');
  let scale = 1;
  for (;;) {
    const width = Math.max(1, Math.ceil(cssWidth / scale));
    const height = Math.max(1, Math.ceil(cssHeight / scale));
    if (width * height <= maxCells) return { width, height, scale };
    scale++;
  }
}
