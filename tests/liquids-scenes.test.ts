import { describe, expect, it } from 'vitest';
import { PARTICLE_TYPES as T } from '../src/particles';
import { SAND_POOL, SCENES } from '../src/scenes';
import { load, LONG, makeModel } from './liquid-acceptance';
import { observe } from './liquid-model';
import { chamberLevel, columnLevel, flatness, LIQUIDS } from './metrics';

describe('liquid acceptance (CPU reference): single scenes', () => {
  it('AC6: the basin is flat after 3000 steps', () => {
    const model = makeModel();
    const scene = load(model, SCENES.basin());
    model.step(3000);
    expect(flatness(model.cells(), scene.width, scene.height, scene.chambers[0], scene.floorY)).toBeLessThanOrEqual(1);
  }, LONG);

  it('AC7: a dam break reaches the far wall and climbs at least 5 cells above the rest level', () => {
    const model = makeModel();
    const scene = load(model, SCENES.damBreak());
    const farWall = scene.chambers[0].x1 - 1;
    let peak = 0;
    observe(model, 3000, 5, (cells) => {
      peak = Math.max(peak, columnLevel(cells, scene.width, scene.height, farWall, scene.floorY));
    });
    expect(peak - scene.expectedLevel!, 'run-up above rest level').toBeGreaterThanOrEqual(5);
  }, LONG);

  it('AC8: a sealed full chamber stays at rest', () => {
    const model = makeModel();
    load(model, SCENES.sealedChamber());
    const before = Uint32Array.from(model.cells());
    observe(model, 500, 25, (cells) => {
      expect(cells).toEqual(before);
      expect(model.maxSpeed()).toBeLessThanOrEqual(1e-3);
    });
  }, LONG);

  it.each(['droplet', 'film'])('AC9: the %s stays in place', (name) => {
    const model = makeModel();
    load(model, SCENES[name]());
    const before = Uint32Array.from(model.cells());
    observe(model, 500, 25, (cells) => {
      expect(cells, name).toEqual(before);
    });
  }, LONG);

  it('AC10: sand dropped into a pool reaches the bottom and raises the surface by its volume', () => {
    const model = makeModel();
    const scene = load(model, SCENES.sandIntoPool());
    const water = model.volume(T.WATER);
    model.step(2500);
    const cells = model.cells();
    expect(model.volume(T.WATER)).toBe(water);
    expect(model.volume(T.SAND)).toBe(SAND_POOL.sandSize ** 2);
    for (let y = scene.floorY; y < scene.height; y++) {
      for (let x = 0; x < scene.width; x++) {
        if ((cells[y * scene.width + x] & 0xff) !== T.SAND) continue;
        const below = cells[(y - 1) * scene.width + x] & 0xff;
        expect([T.SAND, T.WALL], `sand at ${x},${y} is unsupported`).toContain(below);
      }
    }
    const level = chamberLevel(cells, scene.width, scene.height, scene.chambers[0], scene.floorY, [...LIQUIDS, T.SAND]);
    expect(Math.abs(level - scene.expectedLevel!)).toBeLessThanOrEqual(1);
  }, LONG);
});
