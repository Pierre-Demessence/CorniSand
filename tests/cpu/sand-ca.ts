import { PARTICLE_TYPES as T } from '../../src/particles';

// CPU port of the Margolus block rules that move sand (src/shaders/solid-ca.wgsl.ts phases 1 and 2). Liquids are
// particles, so they have no CA rule here; sand still swaps with a liquid cell and the particles follow on the
// next fluid step. Smoke and fire rules are not ported: no acceptance scene uses them.

export interface SandState {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint32Array;
}

const c = new Uint32Array(4);
const where = new Int32Array(4);

// Block positions: 0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right.
const COLUMNS = [[2, 0], [3, 1]] as const;

const typeOf = (q: number): number => c[q] & 0xff;

function swap(a: number, b: number): void {
  const cell = c[a];
  c[a] = c[b];
  c[b] = cell;
}

/** Sand displaces anything lighter: empty space, smoke and liquids. */
function canDisplace(mover: number, dest: number): boolean {
  if (typeOf(mover) !== T.SAND) return false;
  const d = typeOf(dest);
  return d === T.EMPTY || d === T.SMOKE || d === T.WATER || d === T.OIL;
}

/** One Margolus pass over the 2x2 blocks at `offset` (0 or 1). Blocks are disjoint, so updating in place is safe. */
export function sandDispatch({ width: W, height: H, cells }: SandState, offset: number): void {
  const blocksX = Math.ceil((W + offset) / 2);
  const blocksY = Math.ceil((H + offset) / 2);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const ox = bx * 2 - offset;
      const oy = by * 2 - offset;
      for (let q = 0; q < 4; q++) {
        const x = ox + (q & 1);
        const y = oy + (q >> 1);
        if (x >= 0 && x < W && y >= 0 && y < H) {
          where[q] = y * W + x;
          c[q] = cells[where[q]];
        } else {
          where[q] = -1;
          c[q] = T.WALL;
        }
      }

      for (const [t, b] of COLUMNS) {
        if (canDisplace(t, b)) swap(t, b);
      }
      if (typeOf(2) === T.SAND && !canDisplace(2, 0) && canDisplace(2, 1)) swap(2, 1);
      if (typeOf(3) === T.SAND && !canDisplace(3, 1) && canDisplace(3, 0)) swap(3, 0);

      for (let q = 0; q < 4; q++) if (where[q] >= 0) cells[where[q]] = c[q];
    }
  }
}
