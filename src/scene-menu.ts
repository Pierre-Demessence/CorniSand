import { SCENE_GROUPS, type SceneInfo } from './scenes';

export interface SceneMenuEntry {
  key: string;
  label: string;
  description: string;
}

export interface SceneMenuGroup {
  id: string;
  label: string;
  scenes: SceneMenuEntry[];
}

/**
 * The category of the scenarios whose test waits for a mechanic: virtual, since the scene's `group` stays `scenarios`
 * and it moves back when its `waitsFor` is deleted.
 */
export const WAITING_CATEGORY = { id: 'waiting', label: 'Waiting for a mechanic' } as const;

const CATEGORIES: readonly { id: string; label: string }[] = [...SCENE_GROUPS, WAITING_CATEGORY];

function categoryOf(scene: SceneInfo): string {
  return scene.waitsFor !== undefined && scene.waitsFor.length > 0 ? WAITING_CATEGORY.id : scene.group;
}

/**
 * The categories in `SCENE_GROUPS` order, then "Waiting for a mechanic", with their scenes in the order of `info`; a
 * category with no scene is left out. A scenario with `waitsFor` is in the last one only.
 */
export function sceneMenuGroups(info: Readonly<Record<string, SceneInfo>>): SceneMenuGroup[] {
  return CATEGORIES
    .map((category) => ({
      id: category.id,
      label: category.label,
      scenes: Object.entries(info)
        .filter(([, scene]) => categoryOf(scene) === category.id)
        .map(([key, scene]) => ({ key, label: scene.label, description: scene.description })),
    }))
    .filter((group) => group.scenes.length > 0);
}

export interface SceneMenuVersion {
  key: string;
  /** The chip's label. */
  version: string;
  waitsFor: string[];
}

/** One row of the menu: a scene, or a family of scenes folded under its first member (the main version when it is listed). */
export interface SceneMenuRow {
  key: string;
  label: string;
  description: string;
  waitsFor: string[];
  /** The category of the row's scene. */
  category: string;
  /** One entry per member of the family in the result, the row's own scene first; empty for a scene alone. */
  versions: SceneMenuVersion[];
}

/** Lower case with the accents removed, so that "ete" finds "été". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The rows the menu lists. A non-empty `query` searches every category: a scene matches when its label, description
 * and group label together contain each word of the query (case and accents ignored). With an empty query, `category`
 * (an id of `sceneMenuGroups`, or `null` for all) selects the scenes. Rows come in the order of `info`; the scenes
 * of one family that are in the result share a row.
 */
export function sceneMenuFilter(info: Readonly<Record<string, SceneInfo>>, query: string, category: string | null): SceneMenuRow[] {
  const words = fold(query).split(/\s+/).filter((word) => word !== '');
  const families = new Map<string, [string, SceneInfo][]>();
  for (const entry of Object.entries(info)) {
    const [key, scene] = entry;
    const groupLabel = CATEGORIES.find((c) => c.id === scene.group)?.label ?? '';
    const haystack = fold(`${scene.label} ${scene.description} ${groupLabel}`);
    const matches = words.length > 0
      ? words.every((word) => haystack.includes(word))
      : category === null || categoryOf(scene) === category;
    if (!matches) continue;
    const familyKey = scene.family ?? key;
    families.set(familyKey, [...(families.get(familyKey) ?? []), entry]);
  }
  return [...families.values()].map((members) => {
    const [key, scene] = members[0];
    return {
      key,
      label: scene.label,
      description: scene.description,
      waitsFor: scene.waitsFor ?? [],
      category: categoryOf(scene),
      versions: members.length === 1
        ? []
        : members.map(([memberKey, member]) => ({ key: memberKey, version: member.version ?? memberKey, waitsFor: member.waitsFor ?? [] })),
    };
  });
}

/** The query string (with its `?`, or empty) that opens `key` and keeps every other parameter; `null` removes the scene. */
export function sceneSearch(search: string, key: string | null): string {
  const params = new URLSearchParams(search);
  if (key === null) params.delete('scene');
  else params.set('scene', key);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

const EMPTY_WORLD = { label: 'Empty world', description: 'A blank world to draw in, sized to the window.' };

/**
 * Fills `panel` with the menu: Empty world, then every scene by group. `current` is the key of the scene that is open,
 * or `null` for the empty world. `onPick` gets the key of the scene picked, or `null` for the empty world.
 * Opening and closing the panel (`button`, Escape, a click outside) is wired here; the panel starts closed.
 */
export function renderSceneMenu(
  button: HTMLButtonElement,
  panel: HTMLElement,
  info: Readonly<Record<string, SceneInfo>>,
  current: string | null,
  onPick: (key: string | null) => void,
): void {
  const doc = panel.ownerDocument;

  function item(key: string | null, label: string, description: string): HTMLButtonElement {
    const entry = doc.createElement('button');
    entry.type = 'button';
    entry.className = 'scene-item';
    const head = doc.createElement('span');
    head.className = 'scene-head';
    const name = doc.createElement('span');
    name.className = 'scene-label';
    name.textContent = label;
    head.appendChild(name);
    if (key === current) {
      // Border and bold label as well as the word: the current scene is not marked by color alone.
      entry.classList.add('current');
      entry.setAttribute('aria-current', 'true');
      const mark = doc.createElement('span');
      mark.className = 'scene-current';
      mark.textContent = 'current';
      head.appendChild(mark);
    }
    const text = doc.createElement('span');
    text.className = 'scene-description';
    text.textContent = description;
    entry.append(head, text);
    entry.addEventListener('click', () => {
      close();
      onPick(key);
    });
    return entry;
  }

  panel.replaceChildren(item(null, EMPTY_WORLD.label, EMPTY_WORLD.description));
  for (const group of sceneMenuGroups(info)) {
    const heading = doc.createElement('div');
    heading.className = 'scene-group';
    heading.textContent = group.label;
    panel.appendChild(heading);
    for (const scene of group.scenes) panel.appendChild(item(scene.key, scene.label, scene.description));
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-pressed', String(open));
  }
  function close(): void {
    setOpen(false);
  }
  setOpen(false);

  button.addEventListener('click', () => {
    const open = panel.hidden === true;
    setOpen(open);
    if (open) panel.scrollTop = 0;
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    close();
    button.focus();
  });
  doc.addEventListener('pointerdown', (e) => {
    if (panel.hidden || !(e.target instanceof Node)) return;
    if (!panel.contains(e.target) && !button.contains(e.target)) close();
  });
}
