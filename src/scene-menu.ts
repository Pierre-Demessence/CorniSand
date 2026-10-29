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

/** One listed row: a scene, a family folded under its first member, or the empty world (`key` and `category` are `null`). */
interface MenuItem {
  key: string | null;
  label: string;
  description: string;
  waitsFor: string[];
  versions: SceneMenuVersion[];
  category: string | null;
}

function plural(count: number): string {
  return count === 1 ? '1 scene' : `${count} scenes`;
}

function waitsText(ids: string[]): string {
  return `Waits for ${ids.join(', ')}`;
}

/**
 * Fills `panel` (the dimmed backdrop, which starts hidden) with the Scenes menu: a search field, the category list
 * and the rows. Empty world comes first when nothing is searched or filtered. `current` is the key of the scene that
 * is open, or `null` for the empty world. `onPick` gets the key of the scene picked, or `null` for the empty world.
 * Opening and closing (`button`, Escape, a click on the backdrop) is wired here; Escape first clears the search.
 * Focus stays in the search field while the arrow keys move the highlighted row.
 */
export function renderSceneMenu(
  button: HTMLButtonElement,
  panel: HTMLElement,
  info: Readonly<Record<string, SceneInfo>>,
  current: string | null,
  onPick: (key: string | null) => void,
): void {
  const doc = panel.ownerDocument;

  function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const groups = sceneMenuGroups(info);
  const totalScenes = groups.reduce((sum, group) => sum + group.scenes.length, 0);
  const categoryOrder = CATEGORIES.map((c) => c.id);
  const categoryLabel = new Map(CATEGORIES.map((c) => [c.id, c.label]));

  let query = '';
  let category: string | null = null;
  let items: MenuItem[] = [];
  let rowEls: HTMLElement[] = [];
  let opens: HTMLButtonElement[] = [];
  let active = -1;

  const dialog = make('div', 'scene-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Scenes');

  const search = make('input', 'scene-search');
  search.type = 'search';
  search.placeholder = 'Search scenes';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-label', 'Search scenes');
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-controls', 'scene-rows');
  search.setAttribute('aria-autocomplete', 'list');
  const count = make('span', 'scene-count');
  count.setAttribute('role', 'status');
  const header = make('div', 'scene-header');
  header.append(search, count);

  const cats = make('div', 'scene-cats');
  cats.setAttribute('role', 'group');
  cats.setAttribute('aria-label', 'Categories');
  const catButtons = new Map<string | null, HTMLButtonElement>();
  const catEntries: { id: string | null; label: string; scenes: number }[] = [
    { id: null, label: 'All', scenes: totalScenes },
    ...groups.map((g) => ({ id: g.id, label: g.label, scenes: g.scenes.length })),
  ];
  for (const entry of catEntries) {
    const catButton = make('button', 'scene-cat');
    catButton.type = 'button';
    catButton.append(make('span', 'scene-cat-label', entry.label), make('span', 'scene-cat-count', String(entry.scenes)));
    catButton.addEventListener('click', () => {
      query = '';
      search.value = '';
      category = entry.id;
      refresh();
      search.focus();
    });
    catButtons.set(entry.id, catButton);
    cats.appendChild(catButton);
  }

  const rowsEl = make('div', 'scene-rows');
  rowsEl.id = 'scene-rows';
  rowsEl.setAttribute('role', 'listbox');
  rowsEl.setAttribute('aria-label', 'Scenes');
  const body = make('div', 'scene-body');
  body.append(cats, rowsEl);

  // The full text of the highlighted row, since a row cuts its description at one line.
  const detail = make('div', 'scene-detail');
  dialog.append(header, body, detail);
  panel.replaceChildren(dialog);

  function isCurrent(item: MenuItem): boolean {
    return item.key === current || item.versions.some((v) => v.key === current);
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-pressed', String(open));
  }

  function pick(key: string | null): void {
    setOpen(false);
    onPick(key);
  }

  function setActive(index: number, scroll: boolean): void {
    if (active >= 0 && active < rowEls.length) {
      rowEls[active].classList.remove('active');
      opens[active].setAttribute('aria-selected', 'false');
    }
    active = index;
    if (index < 0 || index >= rowEls.length) {
      search.removeAttribute('aria-activedescendant');
      detail.textContent = '';
      return;
    }
    rowEls[index].classList.add('active');
    opens[index].setAttribute('aria-selected', 'true');
    search.setAttribute('aria-activedescendant', opens[index].id);
    if (scroll) rowEls[index].scrollIntoView({ block: 'nearest' });
    const item = items[index];
    detail.textContent = `${item.label}: ${item.description}${item.waitsFor.length > 0 ? ` (${waitsText(item.waitsFor)})` : ''}`;
  }

  function buildRow(item: MenuItem, index: number): HTMLElement {
    const row = make('div', 'scene-row');
    row.setAttribute('role', 'presentation');
    const rowCurrent = isCurrent(item);
    // Border and bold label as well as the word: the current scene is not marked by color alone.
    if (rowCurrent) row.classList.add('current');

    const open = make('button', 'scene-open');
    open.type = 'button';
    open.id = `scene-row-${index}`;
    open.setAttribute('role', 'option');
    open.setAttribute('aria-selected', 'false');
    const head = make('span', 'scene-head');
    head.appendChild(make('span', 'scene-label', item.label));
    // A row with version chips carries the word on its current chip.
    if (rowCurrent && item.versions.length === 0) head.appendChild(make('span', 'scene-current', 'current'));
    if (item.waitsFor.length > 0) head.appendChild(make('span', 'scene-waits', waitsText(item.waitsFor)));
    open.append(head, make('span', 'scene-description', item.description));
    open.setAttribute(
      'aria-label',
      `${item.label}${rowCurrent ? ', current' : ''}${item.waitsFor.length > 0 ? `, ${waitsText(item.waitsFor)}` : ''}: ${item.description}`,
    );
    open.addEventListener('click', () => { pick(item.key); });
    row.appendChild(open);

    if (item.versions.length > 0) {
      const chips = make('span', 'scene-chips');
      for (const version of item.versions) {
        const chip = make('button', 'scene-chip', version.version);
        chip.type = 'button';
        const isThis = version.key === current;
        const waits = version.waitsFor.length > 0 ? `, ${waitsText(version.waitsFor)}` : '';
        chip.setAttribute('aria-label', `${item.label}, ${version.version}${isThis ? ', current' : ''}${waits}`);
        if (isThis) {
          chip.classList.add('current');
          chip.setAttribute('aria-current', 'true');
          chip.appendChild(make('span', 'scene-current', 'current'));
        }
        chip.addEventListener('click', () => { pick(version.key); });
        chips.appendChild(chip);
      }
      row.appendChild(chips);
    }
    row.addEventListener('pointerenter', () => {
      if (active !== index) setActive(index, false);
    });
    return row;
  }

  function refresh(): void {
    const rows = sceneMenuFilter(info, query, category)
      .map((row, position) => ({ row, position }))
      .sort((a, b) => categoryOrder.indexOf(a.row.category) - categoryOrder.indexOf(b.row.category) || a.position - b.position)
      .map(({ row }) => row);
    items = rows.map((row) => ({
      key: row.key,
      label: row.label,
      description: row.description,
      waitsFor: row.waitsFor,
      versions: row.versions,
      category: row.category,
    }));
    const words = fold(query).split(/\s+/).filter((word) => word !== '');
    const emptyHaystack = fold(`${EMPTY_WORLD.label} ${EMPTY_WORLD.description}`);
    const showEmpty = words.length > 0 ? words.every((word) => emptyHaystack.includes(word)) : category === null;
    if (showEmpty) items.unshift({ key: null, ...EMPTY_WORLD, waitsFor: [], versions: [], category: null });

    for (const [id, catButton] of catButtons) catButton.setAttribute('aria-pressed', String(query === '' && id === category));
    count.textContent = plural(rows.reduce((sum, row) => sum + Math.max(1, row.versions.length), 0));

    rowEls = [];
    opens = [];
    const nodes: HTMLElement[] = [];
    // Headings between categories only where the list holds several (all, or a search).
    let lastCategory: string | null = null;
    items.forEach((item, index) => {
      if (category === null && item.category !== null && item.category !== lastCategory) {
        nodes.push(make('div', 'scene-group', categoryLabel.get(item.category)));
      }
      lastCategory = item.category;
      const rowEl = buildRow(item, index);
      rowEls.push(rowEl);
      opens.push(rowEl.querySelector<HTMLButtonElement>('.scene-open')!);
      nodes.push(rowEl);
    });
    if (items.length === 0) nodes.push(make('div', 'scene-empty', 'No scene matches'));
    rowsEl.replaceChildren(...nodes);
    rowsEl.scrollTop = 0;
    active = -1;
    setActive(items.length > 0 ? 0 : -1, false);
  }

  setOpen(false);

  button.addEventListener('click', () => {
    const open = panel.hidden === true;
    if (open) {
      query = '';
      category = null;
      search.value = '';
      refresh();
    }
    setOpen(open);
    if (open) search.focus();
  });

  search.addEventListener('input', () => {
    query = search.value;
    refresh();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      setActive(e.key === 'ArrowDown' ? Math.min(active + 1, items.length - 1) : Math.max(active - 1, 0), true);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active].key);
    }
  });

  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // Tab stays inside the dialog: it is modal, and the toolbar behind it is not part of it.
    const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    if (query !== '') {
      query = '';
      search.value = '';
      refresh();
      search.focus();
      return;
    }
    setOpen(false);
    button.focus();
  });
  doc.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && e.target === panel) setOpen(false);
  });
}
