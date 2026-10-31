import { describe, expect, it } from 'vitest';
import { ALL_CLOSED, ALL_OPEN, EDGE_BITS, SIDES, edgesWord, type Edges, type Side } from '../src/edges';
import { ELEMENT as T } from '../src/elements';
import { packHalf2 } from '../src/half';
import type { Simulation } from '../src/simulation';
import { cell, countTypes, createSim, device, loadScene, readCells, runMany } from './gpu';

// Matter that crosses an open side of the world is gone; a closed side is an endless wall (docs/simulation.md,
// "Boundaries"). Every world here has one side open and the others closed, and no wall drawn, so that the edge setting is
// the only thing that holds or releases the matter. The air is off: a gas under an open top would otherwise also trade
// heat with the air and condense or sink.

const onlyOpen = (...open: Side[]): Edges => ({ ...ALL_CLOSED, ...Object.fromEntries(open.map((side) => [side, 'open'])) });

// The cells of the grid that are not empty space or a wall, plus the flyers in the air.
async function matter(sim: Simulation): Promise<number> {
  const counts = countTypes(await readCells(sim));
  let total = 0;
  for (const [type, n] of counts) if (type !== T.EMPTY && type !== T.WALL) total += n;
  return total + (await sim.flyers.readStats()).live;
}

describe('edges word', () => {
  it('has one bit per open side', () => {
    expect(edgesWord(ALL_CLOSED)).toBe(0);
    expect(edgesWord(ALL_OPEN)).toBe(EDGE_BITS.left | EDGE_BITS.right | EDGE_BITS.bottom | EDGE_BITS.top);
    for (const side of SIDES) expect(edgesWord(onlyOpen(side)), `only ${side} open`).toBe(EDGE_BITS[side]);
  });
});

describe.skipIf(!device)('AC1: matter leaves through an open side', () => {
  const size = 16;

  // Each case: the side that is open, and the matter that is on its way to it.
  const cases: { side: Side; name: string; place: (kind: Uint32Array) => void }[] = [
    {
      side: 'bottom',
      name: 'a column of sand over the floor',
      place: (kind) => { for (let y = 4; y < 10; y++) for (let x = 6; x < 9; x++) kind[y * size + x] = cell(T.SAND); },
    },
    {
      side: 'left',
      name: 'water against the left side',
      place: (kind) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) kind[y * size + x] = cell(T.WATER); },
    },
    {
      side: 'right',
      name: 'water against the right side',
      place: (kind) => { for (let y = 0; y < 4; y++) for (let x = size - 4; x < size; x++) kind[y * size + x] = cell(T.WATER); },
    },
    {
      side: 'top',
      name: 'smoke under the top',
      place: (kind) => { for (let y = 8; y < 12; y++) for (let x = 6; x < 10; x++) kind[y * size + x] = cell(T.SMOKE); },
    },
  ];

  it.each(cases)('$name leaves when $side is open and stays when it is closed', async ({ side, place }) => {
    const kind = new Uint32Array(size * size);
    place(kind);
    const start = kind.filter((word) => word !== 0).length;

    const open = createSim(size, size, 1, { air: false, edges: onlyOpen(side) });
    loadScene(open, kind.slice());
    await runMany(open, 1500);
    expect(await matter(open), `matter left with ${side} open`).toBe(0);

    const closed = createSim(size, size, 1, { air: false, edges: ALL_CLOSED });
    loadScene(closed, kind.slice());
    await runMany(closed, 1500);
    expect(await matter(closed), 'matter left with every side closed').toBe(start);
  });

  it('setEdges opens a side from the next frame on and keeps the world', async () => {
    const kind = new Uint32Array(size * size);
    for (let x = 6; x < 9; x++) kind[x + 4 * size] = cell(T.SAND);
    const sim = createSim(size, size, 1, { air: false, edges: ALL_CLOSED });
    loadScene(sim, kind);
    await runMany(sim, 600);
    expect(await matter(sim), 'sand resting on the closed floor').toBe(3);

    sim.setEdges(onlyOpen('bottom'));
    await runMany(sim, 600);
    expect(await matter(sim), 'sand left through the opened floor').toBe(0);
  });
});

describe.skipIf(!device)('AC2: a corner is closed when either side is', () => {
  it.each([
    ['left', 0],
    ['right', 15],
  ] as const)('sand against the open %s side never falls through the corner of the closed floor', async (side, x) => {
    const size = 16;
    const kind = new Uint32Array(size * size);
    kind[10 * size + x] = cell(T.SAND);
    const sim = createSim(size, size, 1, { air: false, edges: onlyOpen(side) });
    loadScene(sim, kind);
    await runMany(sim, 400);
    const after = await readCells(sim);
    expect(after.indexOf(cell(T.SAND)), 'the grain rests on the floor at the edge').toBe(x);
    expect(await matter(sim)).toBe(1);
  });

  it('sand sliding along a closed floor leaves through an open left side', async () => {
    const size = 16;
    const kind = new Uint32Array(size * size);
    for (let y = 0; y < 10; y++) for (let x = 2; x < 4; x++) kind[y * size + x] = cell(T.SAND);
    const start = countTypes(kind).get(T.SAND)!;

    const open = createSim(size, size, 1, { air: false, edges: onlyOpen('left') });
    loadScene(open, kind.slice());
    await runMany(open, 1500);
    expect(await matter(open), 'grains left in the world').toBeLessThan(start);

    const closed = createSim(size, size, 1, { air: false, edges: ALL_CLOSED });
    loadScene(closed, kind.slice());
    await runMany(closed, 1500);
    expect(await matter(closed), 'grains with every side closed').toBe(start);
  });
});

describe.skipIf(!device)('AC3: a flyer that crosses an open side is removed', () => {
  const size = 64;
  const middle = 32;
  const speed = 8;
  // The velocity that sends the grain at the middle of the grid toward a side, and the column the closed side leaves it in
  // (a grain that hit the left, right or top then falls to the floor, so the row says nothing, and the floor's is 0).
  const toward: Record<Side, { velocity: [number, number]; column: number }> = {
    left: { velocity: [-speed, 0], column: 0 },
    right: { velocity: [speed, 0], column: size - 1 },
    bottom: { velocity: [0, -speed], column: middle },
    top: { velocity: [0, speed], column: middle },
  };

  it.each(SIDES)('the grain thrown toward %s lands against it when closed and is gone when open', async (side) => {
    const { velocity, column } = toward[side];
    const kind = new Uint32Array(size * size);
    const velocityWords = new Uint32Array(size * size);
    kind[middle * size + middle] = cell(T.SAND);
    velocityWords[middle * size + middle] = packHalf2(velocity[0], velocity[1]);

    const closed = createSim(size, size, 1, { air: false, edges: ALL_CLOSED });
    closed.load({ kind: kind.slice(), velocity: velocityWords.slice() });
    await runMany(closed, 60);
    const stats = await closed.flyers.readStats();
    expect(stats.launched, 'it flew').toBeGreaterThan(0);
    expect(stats.landed, 'it landed').toBeGreaterThan(0);
    expect(stats.live, 'it is not in the air').toBe(0);
    const landed = (await readCells(closed)).indexOf(cell(T.SAND));
    expect(landed % size, 'the column it stopped in against the closed side').toBe(column);
    expect(Math.floor(landed / size), 'it came to rest on the floor').toBe(0);
    closed.requestParticleCount();
    expect(await closed.readParticleCount(), 'particle count with the side closed').toBe(1);

    const open = createSim(size, size, 1, { air: false, edges: onlyOpen(side) });
    open.load({ kind: kind.slice(), velocity: velocityWords.slice() });
    await runMany(open, 60);
    const gone = await open.flyers.readStats();
    expect(gone.launched, 'it flew').toBe(1);
    expect(gone.landed, 'it did not land').toBe(0);
    expect(gone.live, 'it is not in the air').toBe(0);
    expect(await matter(open), 'no grain left in the world').toBe(0);
    open.requestParticleCount();
    expect(await open.readParticleCount(), 'particle count with the side open').toBe(0);
  });
});

describe.skipIf(!device)('AC6: with no edges given, the floor is closed and the other sides open', () => {
  const size = 16;
  // A grain that rolls off the pile can slide a few cells along the floor, so the sand pile has room beside it.
  const wide = 48;

  it.each([[{ air: false }], [{}]])('sand dropped on an empty grid piles on the floor, and smoke leaves through the top (options %j)', async (options) => {
    const sand = new Uint32Array(wide * size);
    for (let y = 6; y < 8; y++) for (let x = 23; x < 26; x++) sand[y * wide + x] = cell(T.SAND);
    const pile = createSim(wide, size, 1, options);
    loadScene(pile, sand);
    await runMany(pile, 1500);
    expect(await matter(pile), 'sand kept').toBe(6);
    const after = await readCells(pile);
    expect(after.slice(0, wide).filter((word) => word === cell(T.SAND)).length, 'sand cells on the floor row').toBeGreaterThan(0);

    const smoke = new Uint32Array(size * size);
    for (let y = 8; y < 12; y++) for (let x = 6; x < 10; x++) smoke[y * size + x] = cell(T.SMOKE);
    const plume = createSim(size, size, 1, options);
    loadScene(plume, smoke);
    await runMany(plume, 1500);
    expect(await matter(plume), 'smoke left through the open top').toBe(0);
  });

  it('water against a side leaves through it with no edges given', async () => {
    const water = new Uint32Array(size * size);
    for (let y = 1; y < 4; y++) for (let x = 0; x < 3; x++) water[y * size + x] = cell(T.WATER);
    const sim = createSim(size, size, 1, { air: false });
    loadScene(sim, water);
    await runMany(sim, 1500);
    expect(await matter(sim), 'water left through the open left side').toBeLessThan(9);
  });
});
