import { describe, expect, it } from 'vitest';
import { sceneMenuFilter, sceneMenuGroups, sceneSearch, WAITING_CATEGORY } from '../src/scene-menu';
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
    // The scenarios come last of the groups; the category of those that wait for a mechanic follows them.
    expect(SCENE_GROUPS.at(-1)!.id).toBe('scenarios');
    expect(groups.map((g) => g.id)).toEqual([...SCENE_GROUPS.map((g) => g.id), WAITING_CATEGORY.id]);
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

  const family: Record<string, SceneInfo> = {
    plain: { label: 'Plain water', group: 'liquids', description: 'Sits in a cup.' },
    cup: { label: 'Cup', group: 'scenarios', description: 'Été: ice melts in a cup.', version: 'full' },
    'cup-fast': { label: 'Cup (chips)', group: 'scenarios', description: 'Ice chips melt sooner.', family: 'cup', version: 'fast' },
    bar: { label: 'Bar', group: 'scenarios', description: 'A hot bar cools.', waitsFor: ['I26'] },
    'bar-long': { label: 'Long bar', group: 'scenarios', description: 'A longer bar.', family: 'bar', version: 'long', waitsFor: ['I26'] },
  };

  it('I31 AC16: move the scenarios that wait for a mechanic into their own last category, out of the real-world scenarios', () => {
    const groups = sceneMenuGroups(family);
    expect(groups.map((g) => g.id)).toEqual(['liquids', 'scenarios', 'waiting']);
    expect(groups[1].scenes.map((s) => s.key)).toEqual(['cup', 'cup-fast']);
    expect(groups[2].scenes.map((s) => s.key)).toEqual(['bar', 'bar-long']);
    expect(groups[2].label).toBe('Waiting for a mechanic');
    expect(sceneMenuFilter(family, '', 'scenarios').map((r) => r.key)).toEqual(['cup']);
    expect(sceneMenuFilter(family, '', 'waiting').map((r) => r.key)).toEqual(['bar']);
    expect(sceneMenuFilter(family, '', 'waiting')[0].waitsFor).toEqual(['I26']);
    expect(sceneMenuFilter(family, 'bar', null)[0]).toMatchObject({ category: 'waiting', waitsFor: ['I26'] });
  });

  it('I31 AC11: keep every scene for an empty query, by category, in registry order', () => {
    expect(sceneMenuFilter(family, '', null).map((r) => r.key)).toEqual(['plain', 'cup', 'bar']);
    expect(sceneMenuFilter(family, '  ', null)).toHaveLength(3);
    expect(sceneMenuFilter(family, '', 'liquids').map((r) => r.key)).toEqual(['plain']);
    expect(sceneMenuFilter(family, '', 'air')).toEqual([]);
  });

  it('I31 AC11: match every word of the query in the label, description or group label, ignoring case and accents', () => {
    expect(sceneMenuFilter(family, 'ETE ice', null).map((r) => r.key)).toEqual(['cup']);
    expect(sceneMenuFilter(family, 'real-world cup', null).map((r) => r.key)).toEqual(['cup']);
    expect(sceneMenuFilter(family, 'ice zzz', null)).toEqual([]);
    expect(sceneMenuFilter(family, 'liquids', null).map((r) => r.key)).toEqual(['plain']);
  });

  it('I31 AC11: search every category when the query is not empty, whichever is selected', () => {
    expect(sceneMenuFilter(family, 'cup', 'waiting').map((r) => r.key)).toEqual(['plain', 'cup']);
  });

  it('I31 AC11: fold the variants under the main version, whose chip comes first', () => {
    const rows = sceneMenuFilter(family, '', null);
    expect(rows[1]).toMatchObject({ key: 'cup', label: 'Cup' });
    expect(rows[1].versions).toEqual([
      { key: 'cup', version: 'full', waitsFor: [] },
      { key: 'cup-fast', version: 'fast', waitsFor: [] },
    ]);
    expect(rows[0].versions).toEqual([]);
    expect(rows[2].versions.map((v) => v.version)).toEqual(['bar', 'long']);
    // Only the members in the result share the row; a variant alone is a row of its own, without chips.
    const chips = sceneMenuFilter(family, 'chips', null);
    expect(chips.map((r) => r.key)).toEqual(['cup-fast']);
    expect(chips[0].versions).toEqual([]);
    expect(sceneMenuFilter(family, 'melt', null)[0].versions.map((v) => v.key)).toEqual(['cup', 'cup-fast']);
  });

  it('I31 AC11: fold the real scenes into one row per family', () => {
    const rows = sceneMenuFilter(SCENE_INFO, '', null);
    const keys = rows.flatMap((r) => (r.versions.length > 0 ? r.versions.map((v) => v.key) : [r.key]));
    expect(keys).toEqual(Object.keys(SCENE_INFO));
    expect(rows.find((r) => r.key === 'sealedBars')!.versions.map((v) => v.version)).toEqual(['steel', 'stone', 'ice']);
    expect(rows.find((r) => r.key === 'iceCup')!.versions.map((v) => v.version)).toEqual(['full', 'fast']);
  });
});
