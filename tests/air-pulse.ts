import type { Simulation } from '../src/simulation';

// A pressure pulse: a Gaussian of `sigma` grid cells around the center of the air cell (i0, j0), as pressure per air
// cell (the array `air.load` takes), scaled to `peak`. Cells for which `keep` is false get 0.
export function gaussian(
  sim: Simulation,
  i0: number,
  j0: number,
  sigma: number,
  keep: (x: number, y: number) => boolean = () => true,
  peak = 1,
): Float32Array {
  const { columns, rows, cellSize } = sim.air;
  const pressure = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const d2 = ((i - i0) * cellSize) ** 2 + ((j - j0) * cellSize) ** 2;
      const x = i * cellSize + cellSize / 2;
      const y = j * cellSize + cellSize / 2;
      if (keep(x, y)) pressure[j * columns + i] = peak * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
  return pressure;
}

// Where the line of values has its highest point, in samples from the start, refined by a parabola through the three
// samples around it.
export function peakAt(line: number[], from: number): number {
  let best = from;
  for (let k = from; k < line.length - 1; k++) if (line[k] > line[best]) best = k;
  const [a, b, c] = [line[best - 1], line[best], line[best + 1]];
  const curve = a - 2 * b + c;
  return curve < 0 ? best + (0.5 * (a - c)) / curve : best;
}
