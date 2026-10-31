import { EDGE_BITS } from '../edges';

// What lies beyond the grid, from the edges word (one bit per open side, `edgesWord` in src/edges.ts). The including
// shader declares the grid size as `W` and `H` (u32).
export const edgesWGSL = /* wgsl */`
const EDGE_LEFT: u32 = ${EDGE_BITS.left}u;
const EDGE_RIGHT: u32 = ${EDGE_BITS.right}u;
const EDGE_BOTTOM: u32 = ${EDGE_BITS.bottom}u;
const EDGE_TOP: u32 = ${EDGE_BITS.top}u;

// Whether the position (x, y) outside the grid is a wall: it lies beyond a closed side, so a position beyond two sides
// (a corner) is closed when either is. Past an open side it is empty space that deletes what enters it.
fn outsideIsWall(x: i32, y: i32, edges: u32) -> bool {
  return (x < 0 && (edges & EDGE_LEFT) == 0u)
    || (x >= i32(W) && (edges & EDGE_RIGHT) == 0u)
    || (y < 0 && (edges & EDGE_BOTTOM) == 0u)
    || (y >= i32(H) && (edges & EDGE_TOP) == 0u);
}
`;
