import { describe, expect, it } from 'vitest';
import { ELEMENT as T, ELEMENTS, cellName, elementByKey, type ElementDef } from '../src/elements';
import { formatPressure, formatProbe } from '../src/readout';
import { paintPreview } from '../src/toolbar';
import { MOLTEN_TABLE } from './molten-table';

const element = (id: number): ElementDef => ELEMENTS.find((e) => e.id === id)!;

describe('M6 AC23: the readout line', () => {
  it('shows the air temperature and pressure for empty space', () => {
    expect(formatProbe(element(T.EMPTY), { type: T.EMPTY, temp: 0, pressure: 1.2, airTemp: 23.4 })).toBe('Air · 23 °C · pressure +1.20');
  });

  it('shows the pressure after a material\'s own temperature', () => {
    expect(formatProbe(element(T.SAND), { type: T.SAND, temp: 25, pressure: -0.34, airTemp: 400 })).toBe('Sand · 25 °C · pressure -0.34');
  });

  it('shows the label alone for a wall', () => {
    expect(formatProbe(element(T.WALL), { type: T.WALL, temp: 0, pressure: 1, airTemp: 20 })).toBe('Wall');
  });

  it('ends after the temperature without air', () => {
    expect(formatProbe(element(T.SAND), { type: T.SAND, temp: 25 })).toBe('Sand · 25 °C');
    expect(formatProbe(element(T.EMPTY), { type: T.EMPTY, temp: 0 })).toBe('Air');
  });

  it('writes a pressure that rounds to zero without a sign', () => {
    expect(formatPressure(0.004)).toBe('0.00');
    expect(formatPressure(-0.004)).toBe('0.00');
    expect(formatPressure(0.2)).toBe('+0.20');
    expect(formatPressure(-0.2)).toBe('-0.20');
  });
});

describe('M8.1 AC13: a cell is named by its row label', () => {
  const name = (id: number): string => cellName(MOLTEN_TABLE, id);

  it('names each liquid of a melt after its material', () => {
    expect(name(T.LAVA), 'melted basalt').toBe('Lava');
    expect(name(T.MOLTEN_GLASS)).toBe('Molten glass');
    expect(name(T.MOLTEN_GOLD)).toBe('Molten gold');
    expect(name(T.MOLTEN_METAL)).toBe('Molten steel');
    expect(name(T.MOLTEN_AEROGEL)).toBe('Molten aerogel');
  });

  it('leaves every other cell its label, and an unknown ID none', () => {
    expect(name(T.SAND)).toBe('Sand');
    expect(name(T.WATER)).toBe('Water');
    expect(name(250)).toBe('');
  });

  it('shows in the readout line, with the temperature clamped at the threshold of the row', () => {
    const glass = elementByKey(MOLTEN_TABLE, 'MOLTEN_GLASS');
    const lava = elementByKey(MOLTEN_TABLE, 'LAVA');
    // Stored 1,300 °C under glass's 1,400 °C setting point: molten glass reads 1,400, lava (setting at 1,200) 1,300.
    expect(formatProbe(glass, { type: T.MOLTEN_GLASS, temp: 1300 }, MOLTEN_TABLE)).toBe('Molten glass · 1400 °C');
    expect(formatProbe(lava, { type: T.LAVA, temp: 1300 }, MOLTEN_TABLE)).toBe('Lava · 1300 °C');
    expect(formatProbe(lava, { type: T.LAVA, temp: 1100 }, MOLTEN_TABLE)).toBe('Lava · 1200 °C');
  });

  it('shows in the paint preview', () => {
    expect(paintPreview(MOLTEN_TABLE, T.STONE, 1300)).toBe('→ Lava');
    expect(paintPreview(MOLTEN_TABLE, T.SAND, 1800)).toBe('→ Molten glass');
    expect(paintPreview(MOLTEN_TABLE, T.GOLD, 1200)).toBe('→ Molten gold');
    expect(paintPreview(MOLTEN_TABLE, T.METAL, 1600)).toBe('→ Molten steel');
    expect(paintPreview(MOLTEN_TABLE, T.SAND, 20)).toBe('→ Sand');
  });
});
