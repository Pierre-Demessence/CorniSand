import { describe, expect, it } from 'vitest';
import { CELL_FIELDS, tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementTemperature } from '../src/elements';
import { unpackHalf2 } from '../src/half';
import {
  BLAST, BLAST_CENTER, BLAST_MARK, EXPLOSION, explosion, findScene, HEAT_BARS, heatBars, ICE_LAVA, iceLava, MOLTEN_METAL, moltenMetal, packCell, PLUME, plume, SCENES, STEAM_CEILING, steamCeiling, uTube,
} from '../src/scenes';
import { cell } from './gpu';
import { chamberLevel, liquidVolume } from './metrics';

describe('scenes', () => {
  it('pack the kind word the same way as the shaders and the GPU test helper', () => {
    for (const [type, variant] of [[T.SAND, 0], [T.WATER, 17], [T.FIRE, 255], [T.WALL, 1]]) {
      expect(packCell(type, variant)).toBe(cell(type, variant));
    }
  });

  it('build every scene with consistent sizes and only known particle types', () => {
    for (const [name, build] of Object.entries(SCENES)) {
      const scene = build();
      for (const field of CELL_FIELDS) expect(scene.fields[field.name], `${name} ${field.name}`).toHaveLength(scene.width * scene.height);
      for (const c of scene.fields.kind) expect(c >>> 16, name).toBe(0);
      for (const c of scene.fields.kind) expect(Object.values(T), name).toContain(c & 0xff);
      // Only a lit fire cell starts with a life.
      scene.fields.life.forEach((life, i) => expect(life, name).toBe(scene.fields.kind[i] === packCell(T.FIRE) ? elementByKey(ELEMENTS, 'FIRE').life!.start : 0));
    }
  });

  it('M5 AC3: start every cell of every scene at its element temperature, except where a scene sets its own', () => {
    const temps = new Map(ELEMENTS.map((e) => [e.id as number, Math.fround(elementTemperature(e))]));
    for (const [name, build] of Object.entries(SCENES)) {
      if (name === 'heatBars') continue;
      const { fields } = build();
      const temp = tempView(fields);
      for (let i = 0; i < temp.length; i++) {
        // The cold ceiling is the one place `steamCeiling` sets its own temperatures.
        if (name === 'steamCeiling' && (fields.kind[i] & 0xff) === T.METAL) continue;
        // The hot plate is the one place `plume` does.
        if (name === 'plume' && (fields.kind[i] & 0xff) === T.METAL) continue;
        if (temp[i] !== temps.get(fields.kind[i] & 0xff)) {
          expect.fail(`${name}: cell ${i} (element ${fields.kind[i] & 0xff}) at ${temp[i]} °C`);
        }
      }
    }
  });

  it('M5.3: lay out the heat bars as a metal bar over a stone bar, each in its own wall channel, hot at the left end', () => {
    const { fields, width, height } = heatBars();
    const { x0, x1, hotColumns, hot, cold, metalY0, stoneY0, barHeight } = HEAT_BARS;
    const temp = tempView(fields);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const bar = x >= x0 && x < x1 && ((y >= metalY0 && y < metalY0 + barHeight) || (y >= stoneY0 && y < stoneY0 + barHeight));
        if (!bar) {
          expect(fields.kind[i], `cell (${x}, ${y}) outside the bars`).toBe(packCell(T.WALL));
          continue;
        }
        const type = y < stoneY0 ? T.METAL : T.STONE;
        expect(fields.kind[i], `cell (${x}, ${y})`).toBe(packCell(type));
        expect(temp[i], `temperature of cell (${x}, ${y})`).toBe(x < x0 + hotColumns ? hot : cold);
      }
    }
    expect([x1 - x0, barHeight]).toEqual([48, 4]);
    expect(hotColumns).toBe(6);
  });

  it('M5.4: lay out the ice and lava scene as a 10x10 ice block touching a 30x8 lava pool in an open-topped tank', () => {
    const { fields, width, height } = iceLava();
    const { ice, lava } = ICE_LAVA;
    const at = (x: number, y: number): number => fields.kind[y * width + x] & 0xff;
    expect([ice.x1 - ice.x0, ice.y1 - ice.y0, lava.x1 - lava.x0, lava.y1 - lava.y0]).toEqual([10, 10, 30, 8]);
    expect(ice.x1).toBe(lava.x0);
    expect([at(ice.x0, ice.y0), at(ice.x1 - 1, ice.y1 - 1), at(lava.x0, lava.y0), at(lava.x1 - 1, lava.y1 - 1)]).toEqual([T.ICE, T.ICE, T.LAVA, T.LAVA]);
    expect([at(ice.x0, ice.y1), at(lava.x0, lava.y1), at(width - 3, 40), at(0, height - 1)]).toEqual([T.EMPTY, T.EMPTY, T.EMPTY, T.WALL]);
  });

  it('M5.4: lay out the steam ceiling as a closed wall box with a cold metal ceiling over a layer of steam', () => {
    const { fields, width, height } = steamCeiling();
    const { ceiling, steam } = STEAM_CEILING;
    const temp = tempView(fields);
    const counts = new Map<number, number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const type = fields.kind[i] & 0xff;
        counts.set(type, (counts.get(type) ?? 0) + 1);
        const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
        if (edge) expect(type, `cell (${x}, ${y}) on the box`).toBe(T.WALL);
        if (type === T.METAL) expect([y >= ceiling.y0 && y < ceiling.y1, temp[i]], `ceiling cell (${x}, ${y})`).toEqual([true, ceiling.temp]);
        if (type === T.STEAM) expect([y >= steam.y0 && y < steam.y1, temp[i]], `steam cell (${x}, ${y})`).toEqual([true, 110]);
      }
    }
    expect([counts.get(T.METAL), counts.get(T.STEAM)]).toEqual([320, 40]);
    expect(ceiling.y1, 'the ceiling touches the top wall').toBe(height - 2);
    expect(steam.y1, 'the steam touches the ceiling').toBe(ceiling.y0);
  });

  it('M5.4: lay out the molten metal scene as a pool at 1,600 °C on a metal floor at 20 °C', () => {
    const { fields, width } = moltenMetal();
    const { floor, pool } = MOLTEN_METAL;
    const temp = tempView(fields);
    for (let y = floor.y0; y < pool.y1; y++) {
      for (let x = floor.x0; x < floor.x1; x++) {
        const inPool = y >= pool.y0 && y < pool.y1 && x >= pool.x0 && x < pool.x1;
        const i = y * width + x;
        if (y >= pool.y0 && !inPool) continue;
        expect([fields.kind[i] & 0xff, temp[i]], `cell (${x}, ${y})`).toEqual(inPool ? [T.MOLTEN_METAL, 1600] : [T.METAL, 20]);
      }
    }
    expect([floor.y1 - floor.y0, pool.y0], 'the floor is 8 rows and the pool rests on it').toEqual([8, floor.y1]);
  });

  it('M6.3c: lay out the explosion scene as a 48-cell gunpowder charge on a shelf in a sand layer, lit by one fire cell, beside a stone wall', () => {
    const { fields, width, height } = explosion();
    const { depth, shelf, charge, fire, stone } = EXPLOSION;
    const counts = new Map<number, number>();
    for (const c of fields.kind) counts.set(c & 0xff, (counts.get(c & 0xff) ?? 0) + 1);
    expect([counts.get(T.GUNPOWDER), counts.get(T.FIRE), counts.get(T.STONE)]).toEqual([48, 1, 256]);
    const at = (x: number, y: number): number => fields.kind[y * width + x] & 0xff;
    expect([at(fire.x, fire.y), at(charge.x0, charge.y0), at(charge.x1 - 1, charge.y1 - 1)]).toEqual([T.FIRE, T.GUNPOWDER, T.GUNPOWDER]);
    expect(fire.x, 'the fire touches the left side of the charge').toBe(charge.x0 - 1);
    expect(at(charge.x0, shelf.y1 - 1), 'the charge rests on the shelf').toBe(T.WALL);
    expect(shelf.y1, 'the charge starts at the shelf').toBe(charge.y0);
    expect(at(charge.x0, charge.y1), 'sand over the charge').toBe(T.SAND);
    expect(at(width / 2, depth + 2 + 1), 'open air above the sand').toBe(T.EMPTY);
    expect(at(stone.x0, stone.y1 - 1), 'the stone stands taller than the sand').toBe(T.STONE);
    expect(stone.y1, 'taller than the sand').toBeGreaterThan(depth + 2);
    expect(height).toBeGreaterThan(stone.y1);
  });

  it('M6.4a: lay out the plume scene as a hot metal plate on the floor of a box open at the top, with smoke beside it', () => {
    const { fields, width, height } = plume();
    const { plate, smoke } = PLUME;
    const temp = tempView(fields);
    const counts = new Map<number, number>();
    for (const c of fields.kind) counts.set(c & 0xff, (counts.get(c & 0xff) ?? 0) + 1);
    expect(counts.get(T.METAL), 'plate cells').toBe((plate.x1 - plate.x0) * (plate.y1 - plate.y0));
    expect(counts.get(T.SMOKE), 'smoke cells').toBe(smoke.reduce((n, s) => n + (s.x1 - s.x0) * (s.y1 - s.y0), 0));
    for (let y = plate.y0; y < plate.y1; y++) {
      for (let x = plate.x0; x < plate.x1; x++) expect([fields.kind[y * width + x] & 0xff, temp[y * width + x]], `plate cell (${x}, ${y})`).toEqual([T.METAL, plate.temp]);
    }
    const at = (x: number, y: number): number => fields.kind[y * width + x] & 0xff;
    expect([at(0, height - 1), at(width - 1, height - 1), at(width / 2, height - 1)], 'walls at the sides, open at the top').toEqual([T.WALL, T.WALL, T.EMPTY]);
    expect(at(width / 2, 0), 'a floor').toBe(T.WALL);
    for (const s of smoke) expect(at(s.x0, s.y0), 'smoke rests on the floor').toBe(T.SMOKE);
  });

  it('look scenes up by their registered name only', () => {
    for (const name of Object.keys(SCENES)) expect(findScene(name), name).toBeDefined();
    expect(findScene('damBreak')?.name).toBe('damBreak');
    for (const name of ['', 'nope', 'constructor', 'toString', '__proto__']) expect(findScene(name), name).toBeUndefined();
  });

  it('start the blast scene with outward velocities, fastest at the center, on marked sand only', () => {
    const { fields: { kind, velocity }, width } = SCENES.blast();
    let thrown = 0;
    for (let i = 0; i < kind.length; i++) {
      const [vx, vy] = unpackHalf2(velocity[i]);
      if (velocity[i] === 0) {
        expect(kind[i], 'a cell at rest is not marked').toBe(packCell(kind[i] & 0xff));
        continue;
      }
      thrown++;
      expect(kind[i], 'a thrown cell is marked sand').toBe(packCell(T.SAND, BLAST_MARK));
      const dx = (i % width) + 0.5 - BLAST_CENTER.x;
      const dy = Math.floor(i / width) + 0.5 - BLAST_CENTER.y;
      expect(vx * dx + vy * dy, 'pointing away from the center').toBeGreaterThanOrEqual(0);
      expect(Math.hypot(vx, vy)).toBeLessThanOrEqual(BLAST.speed * 1.01);
    }
    // About the area of the disc, less the part above the sand surface.
    expect(thrown).toBeGreaterThan(1500);
    expect(thrown).toBeLessThan(Math.PI * BLAST.radius ** 2);
  });

  it('start the pile scene at rest', () => {
    const { fields } = SCENES.pile();
    expect(fields.velocity.every((w) => w === 0)).toBe(true);
    expect(fields.remainder.every((w) => w === 0)).toBe(true);
  });

  it('size the U-tube as specified', () => {
    expect([uTube().width, uTube().height]).toEqual([68, 80]);
  });

  it('lay out the U-tube: floor, partition from y = 10, passage, left arm filled to y = 70', () => {
    const { fields: { kind: cells }, width, floorY, chambers } = uTube();
    const at = (x: number, y: number): number => cells[y * width + x] & 0xff;
    expect(floorY).toBe(2);
    expect(chambers).toEqual([{ name: 'left', x0: 2, x1: 18 }, { name: 'right', x0: 50, x1: 66 }]);
    expect(at(10, 1)).toBe(T.WALL);
    expect(at(30, 9)).toBe(T.WATER);
    expect(at(30, 10)).toBe(T.WALL);
    expect(at(30, 79)).toBe(T.WALL);
    expect(at(10, 69)).toBe(T.WATER);
    expect(at(10, 70)).toBe(T.EMPTY);
    expect(at(58, 10)).toBe(T.EMPTY);
    expect(at(0, 40)).toBe(T.WALL);
    expect(at(67, 40)).toBe(T.WALL);
    expect(liquidVolume(cells)).toBe(1472);
  });

  it('start the U-tube left arm above the level and the right arm empty', () => {
    const { fields: { kind: cells }, width, height, floorY, chambers } = uTube();
    expect(chamberLevel(cells, width, height, chambers[0], floorY)).toBe(68);
    expect(chamberLevel(cells, width, height, chambers[1], floorY)).toBe(8);
  });

  it('size the basin and the dam break to hold their volume', () => {
    const basin = SCENES.basin();
    expect([basin.width, basin.height]).toEqual([200, 60]);
    expect(liquidVolume(basin.fields.kind)).toBe(40 * 49);
    expect(liquidVolume(SCENES.damBreak().fields.kind)).toBe(30 * 40);
  });
});
