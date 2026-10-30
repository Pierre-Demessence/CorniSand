import { describe, expect, it } from 'vitest';
import { ELEMENT as T, ELEMENTS, cellName, elementByKey, type ElementDef } from '../src/elements';
import { formatPressure, formatProbe } from '../src/readout';
import { paintPreview } from '../src/toolbar';
import { GOLD, MOLTEN_TABLE } from './molten-table';

const element = (id: number): ElementDef => ELEMENTS.find((e) => e.id === id)!;

describe('M6 AC23: the readout line', () => {
  it('shows the air temperature and pressure for empty space', () => {
    expect(formatProbe(element(T.EMPTY), { type: T.EMPTY, temp: 0, pressure: 1.2, airTemp: 23.4 })).toBe('Empty · 23 °C · pressure +1.20');
  });

  it('shows the pressure after a material\'s own temperature', () => {
    expect(formatProbe(element(T.SAND), { type: T.SAND, temp: 25, pressure: -0.34, airTemp: 400 })).toBe('Sand · 25 °C · pressure -0.34');
  });

  it('shows the label alone for a wall', () => {
    expect(formatProbe(element(T.WALL), { type: T.WALL, temp: 0, pressure: 1, airTemp: 20 })).toBe('Wall');
  });

  it('ends after the temperature without air', () => {
    expect(formatProbe(element(T.SAND), { type: T.SAND, temp: 25 })).toBe('Sand · 25 °C');
    expect(formatProbe(element(T.EMPTY), { type: T.EMPTY, temp: 0 })).toBe('Empty');
  });

  it('writes a pressure that rounds to zero without a sign', () => {
    expect(formatPressure(0.004)).toBe('0.00');
    expect(formatPressure(-0.004)).toBe('0.00');
    expect(formatPressure(0.2)).toBe('+0.20');
    expect(formatPressure(-0.2)).toBe('-0.20');
  });
});

describe('M8.1 AC13: a molten cell is named by what it sets into', () => {
  const name = (id: number, ctype?: number): string => cellName(MOLTEN_TABLE, id, ctype);
  const molten = (key: string): string => `Molten ${elementByKey(MOLTEN_TABLE, key).label.toLowerCase()}`;

  it('uses the meltLabel of the element it sets into, else "Molten" and its label in lower case', () => {
    expect(name(T.LAVA, T.STONE), 'melted basalt').toBe('Lava');
    expect(name(T.LAVA, T.GLASS)).toBe('Molten glass');
    expect(name(T.MOLTEN_METAL, GOLD)).toBe('Molten gold');
    expect(name(T.MOLTEN_METAL, T.METAL)).toBe(molten('METAL'));
  });

  it('names a cell with ctype 0 by the molten row\'s below, and an unknown ctype as none', () => {
    expect(name(T.LAVA, 0)).toBe('Lava');
    expect(name(T.LAVA)).toBe('Lava');
    expect(name(T.MOLTEN_METAL, 0)).toBe(molten('METAL'));
    // Water melts into nothing: it is no ctype of lava. Gold melts into molten steel, not into lava.
    expect(name(T.LAVA, T.WATER)).toBe('Lava');
    expect(name(T.LAVA, GOLD)).toBe('Lava');
    expect(name(T.LAVA, 250)).toBe('Lava');
  });

  it('leaves every other cell its label', () => {
    expect(name(T.SAND)).toBe('Sand');
    expect(name(T.SAND, T.STONE)).toBe('Sand');
    expect(name(T.WATER, 0)).toBe('Water');
  });

  it('shows in the readout line, with the temperature clamped at the threshold of the element it sets into', () => {
    const lava = elementByKey(MOLTEN_TABLE, 'LAVA');
    // Stored 1,300 °C under glass's 1,400 °C setting point: the glass lava reads 1,400, a plain lava 1,300.
    expect(formatProbe(lava, { type: T.LAVA, ctype: T.GLASS, temp: 1300 }, MOLTEN_TABLE)).toBe('Molten glass · 1400 °C');
    expect(formatProbe(lava, { type: T.LAVA, ctype: 0, temp: 1300 }, MOLTEN_TABLE)).toBe('Lava · 1300 °C');
    expect(formatProbe(lava, { type: T.LAVA, ctype: T.STONE, temp: 1100 }, MOLTEN_TABLE)).toBe('Lava · 1200 °C');
    expect(formatProbe(lava, { type: T.LAVA, temp: 1300 })).toBe('Lava · 1300 °C');
  });

  it('shows in the paint preview', () => {
    expect(paintPreview(MOLTEN_TABLE, T.STONE, 1300)).toBe('→ Lava');
    expect(paintPreview(MOLTEN_TABLE, T.SAND, 1800)).toBe('→ Molten glass');
    expect(paintPreview(MOLTEN_TABLE, GOLD, 1200)).toBe('→ Molten gold');
    expect(paintPreview(MOLTEN_TABLE, T.METAL, 1600)).toBe(`→ ${molten('METAL')}`);
    expect(paintPreview(MOLTEN_TABLE, T.SAND, 20)).toBe('→ Sand');
  });
});
