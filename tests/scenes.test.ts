import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { findScene, packCell, SCENES, uTube } from '../src/scenes';
import { cell } from './gpu';
import { chamberLevel, liquidVolume } from './metrics';

describe('scenes', () => {
  it('pack cells the same way as the shaders and the GPU test helper', () => {
    for (const [type, variant, life] of [[T.SAND, 0, 0], [T.WATER, 17, 0], [T.FIRE, 255, 200], [T.WALL, 1, 65535]]) {
      expect(packCell(type, variant, life)).toBe(cell(type, variant, life));
    }
  });

  it('build every scene with consistent sizes and only known particle types', () => {
    for (const [name, build] of Object.entries(SCENES)) {
      const scene = build();
      expect(scene.cells, name).toHaveLength(scene.width * scene.height);
      for (const c of scene.cells) expect(c >>> 8, name).toBe(0);
      for (const c of scene.cells) expect(Object.values(T), name).toContain(c & 0xff);
    }
  });

  it('look scenes up by their registered name only', () => {
    for (const name of Object.keys(SCENES)) expect(findScene(name), name).toBeDefined();
    expect(findScene('damBreak')?.name).toBe('damBreak');
    for (const name of ['', 'nope', 'constructor', 'toString', '__proto__']) expect(findScene(name), name).toBeUndefined();
  });

  it('size the U-tube as specified', () => {
    expect([uTube().width, uTube().height]).toEqual([68, 80]);
  });

  it('lay out the U-tube: floor, partition from y = 10, passage, left arm filled to y = 70', () => {
    const { cells, width, floorY, chambers } = uTube();
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
    const { cells, width, height, floorY, chambers } = uTube();
    expect(chamberLevel(cells, width, height, chambers[0], floorY)).toBe(68);
    expect(chamberLevel(cells, width, height, chambers[1], floorY)).toBe(8);
  });

  it('size the basin and the dam break to hold their volume', () => {
    const basin = SCENES.basin();
    expect([basin.width, basin.height]).toEqual([200, 60]);
    expect(liquidVolume(basin.cells)).toBe(40 * 49);
    expect(liquidVolume(SCENES.damBreak().cells)).toBe(30 * 40);
  });
});
