import { describe, expect, it } from 'vitest';
import { ELEMENT as T, ELEMENTS, type ElementDef } from '../src/elements';
import { formatPressure, formatProbe } from '../src/readout';

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
