import { describe, expect, it } from 'vitest';
import { CELL_FIELDS, tempView } from '../src/cell-fields';
import { ELEMENT as T, ELEMENTS, elementByKey, elementTemperature } from '../src/elements';
import { unpackHalf2 } from '../src/half';
import { packCell, WALL } from '../src/scene-canvas';
import { HOURGLASS, SCENARIO_SCENES, crucible, freeFall, heatedLayer, hourglass, iceCup, insulationWall, metalBars, sealedBars, steamBurn } from '../src/scenarios';
import {
  BLAST, BLAST_CENTER, BLAST_MARK, EXPLOSION, explosion, findScene, HEAT_BARS, heatBars, ICE_LAVA, iceLava, MOLTEN_METAL, moltenMetal, PHYSICS, PHYSICS_ROOMS, physicsRooms, PLUME, plume, DESCRIPTION_MAX, SCENE_GROUPS, SCENE_INFO, SCENES, SHOWCASE, STEAM_CEILING, steamCeiling, uTube,
  type PhysicsRoom,
} from '../src/scenes';
import { chamberLevel, liquidVolume } from './metrics';

describe('scenes', () => {
  // `tests/gpu.ts` is not imported here: it creates a GPU device when it loads, and this file needs none.
  it('pack the kind word the way the shaders do: the type in bits 0 to 7, the variant in bits 8 to 15', () => {
    for (const [type, variant] of [[T.SAND, 0], [T.WATER, 17], [T.FIRE, 255], [T.WALL, 1]]) {
      expect(packCell(type, variant)).toBe(type + variant * 256);
    }
  });

  it('M8.9 AC2: register the scenario scenes in SCENES and find them by name', () => {
    for (const [name, build] of Object.entries(SCENARIO_SCENES)) {
      expect(SCENES[name], name).toBe(build);
      expect(findScene(name)?.name, name).toBe(name);
    }
  });

  it('I31 AC1: give every scene a menu entry with a label, a known group and a description, and no entry without a scene', () => {
    expect(Object.keys(SCENE_INFO)).toEqual(Object.keys(SCENES));
    const groups: string[] = SCENE_GROUPS.map((g) => g.id);
    for (const [name, info] of Object.entries(SCENE_INFO)) {
      expect(info.label.trim(), name).not.toBe('');
      expect(info.description.trim(), name).not.toBe('');
      expect(groups, name).toContain(info.group);
    }
    for (const name of Object.keys(SCENARIO_SCENES)) expect(SCENE_INFO[name].group, name).toBe('scenarios');
  });

  it('I31 AC10: keep every description to one sentence on one line, at most 110 characters', () => {
    expect(DESCRIPTION_MAX).toBe(110);
    for (const [name, { description }] of Object.entries(SCENE_INFO)) {
      expect([...description].length, name).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(description, name).not.toMatch(/[\r\n]/);
      // One sentence: no full stop followed by another sentence ("2.2 cm" and "0.3 mm" have a digit after the dot).
      expect(description, name).not.toMatch(/[.!?]\s+\S/);
      expect(description, name).toBe(description.trim());
    }
  });

  it('I31 AC15: allow waitsFor on scenarios only, with IDs of the roadmap or backlog', () => {
    const waiting = Object.entries(SCENE_INFO).filter(([, info]) => info.waitsFor !== undefined);
    for (const [name, info] of waiting) {
      expect(info.group, name).toBe('scenarios');
      expect(info.waitsFor!.length, name).toBeGreaterThan(0);
      for (const id of info.waitsFor!) expect(id, name).toMatch(/^[BDIM]\d+(\.\d+[a-z]?)?$/);
    }
  });

  it('I31 AC7: register each version a scenario test builds through a builder parameter, the main one under the bare name and the others as <name>-<version>', () => {
    const versions = {
      iceCup: iceCup('full'),
      'iceCup-fast': iceCup('fast'),
      steamBurn: steamBurn('steam'),
      'steamBurn-water': steamBurn('water'),
      heatedLayer: heatedLayer('above'),
      'heatedLayer-below': heatedLayer('below'),
      hourglass: hourglass(),
      'hourglass-wide': hourglass(2 * HOURGLASS.outlet),
      freeFall: freeFall(),
      'freeFall-pebble': freeFall(T.GRAVEL),
      sealedBars: sealedBars('METAL'),
      'sealedBars-stone': sealedBars('STONE'),
      'sealedBars-ice': sealedBars('ICE'),
      metalBars: metalBars('METAL'),
      'metalBars-aluminium': metalBars('ALUMINIUM'),
      'metalBars-copper': metalBars('COPPER'),
      'metalBars-gold': metalBars('GOLD'),
      'metalBars-titanium': metalBars('TITANIUM'),
      'metalBars-diamond': metalBars('DIAMOND'),
      insulationWall: insulationWall(T.INSULATION),
      'insulationWall-basalt': insulationWall(T.STONE),
      crucible: crucible(T.CERAMIC),
      'crucible-tungsten': crucible(T.TUNGSTEN, 20),
      'crucible-cold': crucible(T.CERAMIC, 20),
    };
    for (const [key, built] of Object.entries(versions)) {
      expect(SCENE_INFO[key], key).toBeDefined();
      const found = findScene(key)!;
      expect(found.name, key).toBe(key);
      expect([found.width, found.height, found.floorY], key).toEqual([built.width, built.height, built.floorY]);
      for (const field of CELL_FIELDS) expect(found.fields[field.name], `${key} ${field.name}`).toEqual(built.fields[field.name]);
    }
  });

  it('I31 AC14: tie each variant to a main scene of its family, and give both a chip label', () => {
    for (const [name, info] of Object.entries(SCENE_INFO)) {
      if (info.family === undefined) continue;
      const main = SCENE_INFO[info.family];
      expect(main, name).toBeDefined();
      expect(main.family, name).toBeUndefined();
      expect(info.version?.trim(), name).toBeTruthy();
      expect(main.version?.trim(), name).toBeTruthy();
      expect(name.startsWith(`${info.family}-`), name).toBe(true);
    }
    // The variants AC7 registers.
    expect(Object.values(SCENE_INFO).filter((info) => info.family !== undefined)).toHaveLength(15);
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
    const { pond } = physicsRooms().rooms;
    for (const [name, build] of Object.entries(SCENES)) {
      // The scenario scenes set their own temperatures (M8.9).
      if (name === 'heatBars' || Object.hasOwn(SCENARIO_SCENES, name)) continue;
      const { fields, width } = build();
      const temp = tempView(fields);
      for (let i = 0; i < temp.length; i++) {
        // The cold ceiling is the one place `steamCeiling` sets its own temperatures.
        if (name === 'steamCeiling' && (fields.kind[i] & 0xff) === T.METAL) continue;
        // The hot plate is the one place `plume` does.
        if (name === 'plume' && (fields.kind[i] & 0xff) === T.METAL) continue;
        // The hot bar and the hot plate are in `showcase`.
        if (name === 'showcase' && (fields.kind[i] & 0xff) === T.METAL) continue;
        // In `physics` the hot plate and the freezing ceiling are, and so is the pond's water (at 10 °C).
        if (name === 'physics') {
          const type = fields.kind[i] & 0xff;
          const x = i % width;
          if (type === T.METAL || (type === T.WATER && x >= pond.x0 && x < pond.x1)) continue;
        }
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

  it('M8.8 AC17: lay out the physics scene as eight walled rooms side by side, every cell inside the grid', () => {
    const { fields, width, height } = findScene('physics')!;
    const { rooms, width: expected } = physicsRooms();
    const { pot, dam, hopper, fire, pond } = PHYSICS;
    expect([width, height]).toEqual([expected, PHYSICS.height]);
    const temp = tempView(fields);
    const at = (x: number, y: number): number => fields.kind[y * width + x] & 0xff;
    const count = (name: PhysicsRoom, type: number): number => {
      let n = 0;
      for (let y = 0; y < height; y++) for (let x = rooms[name].x0; x < rooms[name].x1; x++) if (at(x, y) === type) n++;
      return n;
    };
    const w = (name: PhysicsRoom): number => PHYSICS.widths[name];

    // A wall floor, a wall at each side of the lab and between two rooms, up to the top.
    expect(PHYSICS_ROOMS).toHaveLength(8);
    for (let y = 0; y < height; y++) {
      expect(at(0, y), `left wall at row ${y}`).toBe(T.WALL);
      for (const name of PHYSICS_ROOMS) expect(at(rooms[name].x1, y), `wall after ${name} at row ${y}`).toBe(T.WALL);
    }
    expect(at(width - 1, height - 1), 'the right wall').toBe(T.WALL);

    expect([count('pot', T.METAL), count('pot', T.WATER)]).toEqual([w('pot') * pot.plate, w('pot') * pot.depth]);
    expect(temp[WALL * width + rooms.pot.x0], 'the plate').toBe(pot.temp);
    for (const [name, type] of [['damWater', T.WATER], ['damOil', T.OIL], ['damLava', T.LAVA]] as const) {
      expect(count(name, type), name).toBe(dam.width * dam.height);
      expect([at(rooms[name].x0, WALL), at(rooms[name].x0 + dam.width, WALL)], `${name} against its left wall`).toEqual([type, T.EMPTY]);
    }
    for (const [name, type] of [['sand', T.SAND], ['gunpowder', T.GUNPOWDER]] as const) {
      const row = (y: number): number => {
        let n = 0;
        for (let x = rooms[name].x0; x < rooms[name].x1; x++) if (at(x, y) === type) n++;
        return n;
      };
      const outletY = WALL + hopper.outletY;
      expect(row(outletY), `${name} at the outlet`).toBe(hopper.outlet);
      expect(row(outletY + hopper.height - 1), `${name} at the top of the hopper`).toBeGreaterThan(30);
      expect(count(name, type), name).toBeGreaterThan(300);
      let below = 0;
      for (let y = WALL; y < outletY; y++) below += row(y);
      expect(below, `${name} under the outlet`).toBe(0);
      expect(at((rooms[name].x0 + rooms[name].x1) >> 1, outletY - 1), 'open under the outlet').toBe(T.EMPTY);
      expect(at(rooms[name].x0, outletY), 'the hopper wall').toBe(T.WALL);
    }
    expect([count('fire', T.OIL), count('fire', T.FIRE), count('fire', T.METAL)]).toEqual([w('fire') * fire.oil, 1, w('fire') * fire.ceiling]);
    expect(count('pond', T.WATER)).toBe(w('pond') * pond.depth);
    expect(count('pond', T.METAL)).toBe(w('pond') * pond.ceiling);
    expect(temp[(WALL + pond.depth) * width + rooms.pond.x0], 'the pond ceiling').toBe(pond.ceilingTemp);
    expect(temp[WALL * width + rooms.pond.x0], 'the pond water').toBe(pond.temp);
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

  it('M11 AC6: open the showcase scene with a sand pile, a water pool with oil on it, lava beside stone, a hot metal bar, a fire on gunpowder and smoke over a hot plate', () => {
    expect(findScene('showcase')?.name).toBe('showcase');
    const { fields, width, height } = SCENES.showcase();
    expect([width, height]).toEqual([SHOWCASE.width, SHOWCASE.height]);
    const temp = tempView(fields);
    const at = (x: number, y: number): number => fields.kind[y * width + x] & 0xff;
    const tempAt = (x: number, y: number): number => temp[y * width + x];
    const { sand, pool, lava, bar, gunpowder, plate, smoke } = SHOWCASE;

    expect(at(sand.x, WALL), 'sand pile').toBe(T.SAND);
    expect(at(sand.x, WALL + sand.height), 'above the pile').toBe(T.EMPTY);
    expect(at(pool.water.x0 + 5, pool.water.y1 - 1), 'water').toBe(T.WATER);
    expect(at(pool.water.x0 + 5, pool.oil.y0), 'oil on the water').toBe(T.OIL);
    expect(at(pool.walls[0].x0, WALL), 'the pool is walled').toBe(T.WALL);
    expect(at(lava.pool.x1 - 1, lava.pool.y0), 'lava').toBe(T.LAVA);
    expect(at(lava.stone.x0, lava.pool.y0), 'stone beside the lava').toBe(T.STONE);
    expect(at(bar.x0, bar.y0), 'metal bar').toBe(T.METAL);
    expect(tempAt(bar.x0, bar.y0), 'the bar is hot').toBe(bar.temp);
    expect(at(gunpowder.x, WALL), 'gunpowder').toBe(T.GUNPOWDER);
    expect(at(gunpowder.x, WALL + gunpowder.height), 'fire on the gunpowder tip').toBe(T.FIRE);
    expect(at(gunpowder.x, WALL + gunpowder.height - 1), 'under the fire').toBe(T.GUNPOWDER);
    expect(at(plate.x0, plate.y0), 'hot plate').toBe(T.METAL);
    expect(tempAt(plate.x0, plate.y0), 'the plate is hot').toBe(plate.temp);
    expect(at(smoke.x0, smoke.y0), 'smoke over the plate').toBe(T.SMOKE);
    expect(smoke.y0, 'the smoke rests on the plate').toBe(plate.y1);
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
