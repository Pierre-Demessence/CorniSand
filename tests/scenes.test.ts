import { describe, expect, it } from 'vitest';
import { CELL_FIELDS } from '../src/cell-fields';
import { ELEMENT as T } from '../src/elements';
import { unpackHalf2 } from '../src/half';
import { BLAST, BLAST_CENTER, BLAST_MARK, findScene, packCell, SCENES, uTube } from '../src/scenes';
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
      for (const life of scene.fields.life) expect(life, name).toBe(0);
    }
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
