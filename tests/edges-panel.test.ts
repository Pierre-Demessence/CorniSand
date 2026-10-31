import { describe, expect, it } from 'vitest';
import { ALL_CLOSED, ALL_OPEN, DEFAULT_EDGES, SIDES, formatEdges, parseEdges, type Edges } from '../src/edges';
import { SIDE_LABELS, edgeLabel, edgesSearch } from '../src/edges-panel';
import { sceneSearch } from '../src/scene-menu';

describe('?edges= (I41 AC6, AC7)', () => {
  it('uses the default when there is no parameter, and writes none for it', () => {
    expect(parseEdges(null)).toEqual(DEFAULT_EDGES);
    expect(formatEdges(DEFAULT_EDGES)).toBeNull();
  });

  it('lists the closed sides, `none` for all open', () => {
    expect(formatEdges(ALL_OPEN)).toBe('none');
    expect(formatEdges(ALL_CLOSED)).toBe('left,right,bottom,top');
    expect(formatEdges({ ...ALL_OPEN, left: 'closed' })).toBe('left');
    expect(parseEdges('none')).toEqual(ALL_OPEN);
    expect(parseEdges('left,right,bottom,top')).toEqual(ALL_CLOSED);
    expect(parseEdges('left')).toEqual({ ...ALL_OPEN, left: 'closed' });
    expect(parseEdges('top, bottom')).toEqual({ ...ALL_OPEN, top: 'closed', bottom: 'closed' });
  });

  it('round-trips all sixteen combinations', () => {
    for (let word = 0; word < 16; word++) {
      const edges = Object.fromEntries(SIDES.map((side, i) => [side, (word >> i) & 1 ? 'closed' : 'open'])) as Edges;
      const value = formatEdges(edges);
      expect(parseEdges(value), `word ${word}`).toEqual(edges);
    }
  });

  it('rejects an unknown side, an empty value and none among sides', () => {
    expect(parseEdges('floor')).toBeUndefined();
    expect(parseEdges('left,sky')).toBeUndefined();
    expect(parseEdges('')).toBeUndefined();
    expect(parseEdges('none,left')).toBeUndefined();
  });
});

describe('Edges panel text and URL (I41 AC7)', () => {
  it('names each toggle by its side and state, the bottom being the floor', () => {
    expect(SIDE_LABELS.bottom).toBe('Floor');
    expect(edgeLabel('bottom', 'closed')).toBe('Floor: closed');
    expect(edgeLabel('top', 'open')).toBe('Top: open');
    expect(edgeLabel('left', 'closed')).toBe('Left: closed');
    expect(edgeLabel('right', 'open')).toBe('Right: open');
  });

  it('writes the choice and keeps the other parameters', () => {
    const params = new URLSearchParams(edgesSearch('?air=2&scene=iceCup', ALL_OPEN));
    expect(params.get('edges')).toBe('none');
    expect(params.get('air')).toBe('2');
    expect(params.get('scene')).toBe('iceCup');
  });

  it('drops the parameter for the default', () => {
    expect(edgesSearch('?edges=none', DEFAULT_EDGES)).toBe('');
    expect(edgesSearch('?edges=none&air=2', DEFAULT_EDGES)).toBe('?air=2');
  });

  it('survives a scene pick', () => {
    const search = edgesSearch('', ALL_CLOSED);
    const params = new URLSearchParams(sceneSearch(search, 'iceCup'));
    expect(parseEdges(params.get('edges'))).toEqual(ALL_CLOSED);
    expect(params.get('scene')).toBe('iceCup');
  });
});
