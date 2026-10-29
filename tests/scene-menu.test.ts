import { describe, expect, it } from 'vitest';
import { sceneMenuGroups, sceneSearch } from '../src/scene-menu';
import { SCENE_GROUPS, SCENE_INFO, type SceneInfo } from '../src/scenes';

describe('scene menu', () => {
  it('I31 AC2: list the groups in SCENE_GROUPS order, scenarios last, empty groups left out, each scene once in registry order', () => {
    const info: Record<string, SceneInfo> = {
      first: { label: 'First', group: 'scenarios', description: 'a' },
      second: { label: 'Second', group: 'heat', description: 'b' },
      third: { label: 'Third', group: 'scenarios', description: 'c' },
      fourth: { label: 'Fourth', group: 'liquids', description: 'd' },
    };
    const groups = sceneMenuGroups(info);
    expect(groups.map((g) => g.id)).toEqual(['liquids', 'heat', 'scenarios']);
    expect(groups.map((g) => g.scenes.map((s) => s.key))).toEqual([['fourth'], ['second'], ['first', 'third']]);
    expect(groups[2].scenes[0]).toEqual({ key: 'first', label: 'First', description: 'a' });
  });

  it('I31 AC2: place every real scene in exactly one group, scenarios last', () => {
    const groups = sceneMenuGroups(SCENE_INFO);
    const keys = groups.flatMap((g) => g.scenes.map((s) => s.key));
    expect(keys).toHaveLength(Object.keys(SCENE_INFO).length);
    expect(new Set(keys)).toEqual(new Set(Object.keys(SCENE_INFO)));
    expect(groups.at(-1)!.id).toBe(SCENE_GROUPS.at(-1)!.id);
    expect(SCENE_GROUPS.at(-1)!.id).toBe('scenarios');
  });

  it('I31 AC3: set the scene and keep every other parameter', () => {
    const params = new URLSearchParams(sceneSearch('?air=2&scene=old&wall=0.5', 'iceCup'));
    expect(params.get('scene')).toBe('iceCup');
    expect(params.get('air')).toBe('2');
    expect(params.get('wall')).toBe('0.5');
    expect(new URLSearchParams(sceneSearch('', 'iceCup')).get('scene')).toBe('iceCup');
  });

  it('I31 AC3: remove the scene and keep the rest', () => {
    const params = new URLSearchParams(sceneSearch('?air=2&scene=old', null));
    expect(params.has('scene')).toBe(false);
    expect(params.get('air')).toBe('2');
    expect(sceneSearch('?scene=old', null)).toBe('');
    expect(sceneSearch('', null)).toBe('');
  });
});
