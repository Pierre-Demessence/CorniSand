import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { packCell, SCENES, uTube } from '../src/scenes';
import { cell } from './gpu';
import { bubbleCount, chamberLevel, countType, expectedLevel, liquidVolume } from './metrics';

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

  it('size the U-tubes as specified', () => {
    expect([uTube().width, uTube().height]).toEqual([68, 80]);
    expect([uTube({ scale: 3 }).width, uTube({ scale: 3 }).height]).toEqual([204, 240]);
    expect([uTube({ leftArm: 8, rightArm: 32 }).width, uTube({ leftArm: 8, rightArm: 32 }).height]).toEqual([76, 80]);
  });

  it('lay out the small U-tube: floor, partition from y = 10, passage, left arm filled to y = 70', () => {
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

  it('know the analytic rest level of each U-tube', () => {
    expect(uTube().expectedLevel).toBe(38);
    expect(uTube({ scale: 3 }).expectedLevel).toBe(114);
    expect(uTube({ leftArm: 8, rightArm: 32 }).expectedLevel).toBe(20);
  });

  it('agree with the geometric expected level computed from the cells', () => {
    for (const build of Object.values(SCENES)) {
      const { cells, width, height, floorY, expectedLevel: analytic, name } = build();
      if (analytic === undefined || name === 'sandIntoPool') continue;
      expect(expectedLevel(cells, width, height, floorY, liquidVolume(cells)), name).toBeCloseTo(analytic, 6);
    }
  });

  it('start the U-tube left arm above the level and the right arm empty', () => {
    const { cells, width, height, floorY, chambers } = uTube();
    expect(chamberLevel(cells, width, height, chambers[0], floorY)).toBe(68);
    expect(chamberLevel(cells, width, height, chambers[1], floorY)).toBe(8);
  });

  it('fill the oil U-tube with oil only', () => {
    const { cells } = uTube({ liquid: T.OIL });
    expect(countType(cells, T.WATER)).toBe(0);
    expect(countType(cells, T.OIL)).toBe(1472);
  });

  it('size the basin and the dam break to hold their volume at the documented levels', () => {
    const basin = SCENES.basin();
    expect([basin.width, basin.height]).toEqual([200, 60]);
    expect(liquidVolume(basin.cells)).toBe(40 * 49);
    expect(basin.expectedLevel).toBeCloseTo(10, 9);
    expect(SCENES.damBreak().expectedLevel).toBeCloseTo(1200 / 196, 9);
  });

  it('start with no sealed air pocket in any scene', () => {
    for (const [name, build] of Object.entries(SCENES)) {
      const { cells, width, height } = build();
      expect(bubbleCount(cells, width, height), name).toBe(0);
    }
  });

  it('fill the sealed chamber completely', () => {
    const { cells } = SCENES.sealedChamber();
    expect(countType(cells, T.WATER)).toBe(20 * 20);
    expect(countType(cells, T.EMPTY)).toBe(0);
  });
});
