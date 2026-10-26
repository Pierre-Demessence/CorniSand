import { FIELD_BYTES } from './cell-fields';

export interface Grid {
  width: number;
  height: number;
  // CSS pixels per cell edge; 1 unless the window is too large for the GPU's buffer limits.
  scale: number;
}

// Largest cell count the cell field buffers can hold on this device (the limits apply to each buffer on its own).
export function maxCellsForDevice(device: GPUDevice): number {
  const { maxStorageBufferBindingSize, maxBufferSize } = device.limits;
  return Math.floor(Math.min(maxStorageBufferBindingSize, maxBufferSize) / FIELD_BYTES);
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
