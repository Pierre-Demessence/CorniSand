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

/** The groups in `SCENE_GROUPS` order with their scenes in the order of `info`; a group with no scene is left out. */
export function sceneMenuGroups(info: Readonly<Record<string, SceneInfo>>): SceneMenuGroup[] {
  return SCENE_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      scenes: Object.entries(info)
        .filter(([, scene]) => scene.group === group.id)
        .map(([key, scene]) => ({ key, label: scene.label, description: scene.description })),
    }))
    .filter((group) => group.scenes.length > 0);
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
