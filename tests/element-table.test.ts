import { describe, expect, it } from 'vitest';
import { ELEMENT as T, ELEMENTS, type ElementDef } from '../src/elements';
import { Simulation } from '../src/simulation';
import { cell, cellType, countTypes, createSim, device, loadScene, readCells, runMany } from './gpu';
import { columnsWithAbove } from './metrics';

// A table with one extra row and no other change: the CA reads the row's state and density, nothing else. Test rows sit
// far from the game's IDs, which grow with the table.
const MUD = 200;
const MUD_ROW: ElementDef = {
  key: 'MUD',
  id: MUD,
  label: 'Mud',
  color: [0.4, 0.3, 0.2],
  state: 'powder',
  // Between water (1000) and sand (1600).
  density: 1300,
};
const withMud: ElementDef[] = [...ELEMENTS, MUD_ROW];

// A tank with 2-cell walls on both sides and the floor; the grid edge closes the top.
function tank(width: number, height: number): Uint32Array<ArrayBuffer> {
  const cells = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < 2 || x < 2 || x >= width - 2) cells[y * width + x] = cell(T.WALL);
    }
  }
  return cells;
}

function fill(cells: Uint32Array, width: number, type: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1; y++) cells.fill(cell(type), y * width + x0, y * width + x1);
}

describe.skipIf(!device)('element table in the simulation', () => {
  it('AC12: a powder row added to the table falls', async () => {
    const width = 9;
    const height = 33;
    const sim = createSim(width, height, 1, { elements: withMud });
    const cells = new Uint32Array(width * height);
    cells[29 * width + 4] = cell(MUD);
    loadScene(sim, cells);

    await runMany(sim, 12);

    const at = (await readCells(sim)).indexOf(cell(MUD));
    expect(at, 'the grain is still in the grid').toBeGreaterThanOrEqual(0);
    // It starts from rest and speeds up: about 8 cells in 12 supersteps.
    expect(Math.floor(at / width), 'its row after 12 supersteps').toBeLessThan(29 - 5);
  });

  it('AC12: a powder row added to the table piles up instead of staying a column', async () => {
    const width = 60;
    const height = 40;
    const sim = createSim(width, height, 2, { elements: withMud });
    const cells = tank(width, height);
    fill(cells, width, MUD, 25, 35, 2, 22);
    loadScene(sim, cells);

    await runMany(sim, 400);

    const after = await readCells(sim);
    expect(countTypes(after).get(MUD), 'mud cells').toBe(200);
    let tallest = 0;
    for (let x = 2; x < width - 2; x++) {
      let top = 0;
      for (let y = 2; y < height; y++) {
        const t = cellType(after[y * width + x]);
        if (t === MUD) top = y - 1;
        // Resting on something: mud never floats over empty space.
        if (t === T.EMPTY) {
          for (let above = y + 1; above < height; above++) {
            expect(cellType(after[above * width + x]), `column ${x}, row ${above}, above empty row ${y}`).not.toBe(MUD);
          }
          break;
        }
      }
      tallest = Math.max(tallest, top);
    }
    expect(tallest, 'height of the highest column (the block started 20 high)').toBeLessThan(16);
  });

  it('AC12: a powder row added to the table sinks through water and stays on top of sand', async () => {
    const width = 40;
    const height = 50;
    const sim = createSim(width, height, 3, { elements: withMud });
    const cells = tank(width, height);
    // Water on the left half of the floor, sand on the right half, a block of mud hanging over each.
    fill(cells, width, T.WATER, 2, 20, 2, 14);
    fill(cells, width, T.SAND, 20, width - 2, 2, 8);
    fill(cells, width, MUD, 6, 12, 24, 28);
    fill(cells, width, MUD, 24, 30, 24, 28);
    loadScene(sim, cells);
    const before = countTypes(cells);

    await runMany(sim, 600);

    const after = await readCells(sim);
    expect(columnsWithAbove(after, width, height, MUD, T.WATER), 'columns with water below mud').toBe(0);
    expect(columnsWithAbove(after, width, height, T.SAND, MUD), 'columns with mud below sand').toBe(0);
    for (const type of [MUD, T.WATER, T.SAND]) expect(countTypes(after).get(type), `type ${type}`).toBe(before.get(type));
    // The mud over the water lies in a low mound on the floor under it, far below the water's surface (row 14 or so).
    let highest = 0;
    for (let y = 2; y < height; y++) for (let x = 2; x < 20; x++) if (cellType(after[y * width + x]) === MUD) highest = y;
    expect(highest, 'highest mud row under the water').toBeLessThan(8);
  });

  it('AC13: an element with a rule runs it for cells of that element only', async () => {
    const GLOW = 201;
    const table: ElementDef[] = [
      ...ELEMENTS,
      { key: 'GLOW', id: GLOW, label: 'Glow', color: [1, 1, 0], state: 'solid', density: 2000, rule: 'count' },
    ];
    // Counts the dispatches the cell has been in a block for, in its life field.
    const rules = { count: 'fn rule_count(i: u32, block: ptr<function, array<Cell, 4>>) { (*block)[i].life = (*block)[i].life + 1u; }' };
    const width = 12;
    const height = 12;
    const sim = createSim(width, height, 4, { elements: table, rules });
    const kind = tank(width, height);
    fill(kind, width, T.SAND, 4, 8, 2, 4);
    kind[5 * width + 5] = cell(GLOW);
    kind[9 * width + 9] = cell(GLOW);
    loadScene(sim, kind);

    await runMany(sim, 5);

    const life = await sim.fields.read('life');
    const after = await readCells(sim);
    for (let i = 0; i < after.length; i++) {
      // 5 supersteps are 10 dispatches, and every cell is in exactly one block per dispatch.
      expect(life[i], `life of cell ${i} (type ${cellType(after[i])})`).toBe(cellType(after[i]) === GLOW ? 10 : 0);
    }
    expect(countTypes(after).get(GLOW)).toBe(2);
  });

  it('ages a solid with a lifetime alone in empty space: the CA skips only blocks that cannot change', async () => {
    const EMBER = 201;
    const table: ElementDef[] = [
      ...ELEMENTS,
      { key: 'EMBER', id: EMBER, label: 'Ember', color: [1, 0.4, 0], state: 'solid', density: 2000, life: { start: 6, decay: 1, becomes: 'EMPTY' } },
    ];
    const width = 12;
    const height = 12;
    const sim = createSim(width, height, 5, { elements: table });
    const kind = new Uint32Array(width * height);
    const life = new Uint32Array(width * height);
    kind[5 * width + 5] = cell(EMBER);
    life[5 * width + 5] = 6;
    loadScene(sim, kind, life);

    await runMany(sim, 1);
    expect((await sim.fields.read('life'))[5 * width + 5], 'life after 2 dispatches').toBe(4);

    await runMany(sim, 2);
    expect(countTypes(await readCells(sim)).get(EMBER), 'embers left after 6 dispatches').toBeUndefined();
  });

  it('rejects an element whose rule does not exist', () => {
    const table: ElementDef[] = [...ELEMENTS, { ...MUD_ROW, rule: 'nope' }];
    expect(() => new Simulation(device!, 8, 8, { elements: table })).toThrow(/unknown rule "nope"/);
  });
});
