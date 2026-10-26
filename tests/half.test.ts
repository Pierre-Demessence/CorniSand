import { describe, expect, it } from 'vitest';
import { fromHalf, packHalf2, toHalf, unpackHalf2 } from '../src/half';

describe('binary16 conversion', () => {
  it('encodes the values the movement uses', () => {
    expect(toHalf(0)).toBe(0x0000);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(1 / 32)).toBe(0x2800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(65520)).toBe(0x7c00);
    expect(toHalf(2 ** -24)).toBe(0x0001);
    expect(toHalf(2 ** -25)).toBe(0x0000);
    expect(toHalf(1.5 * 2 ** -24)).toBe(0x0002);
  });

  it('round-trips every finite binary16 value', () => {
    for (let half = 0; half < 0x10000; half++) {
      if (((half >>> 10) & 0x1f) === 31) continue;
      expect(toHalf(fromHalf(half)), `bits ${half.toString(16)}`).toBe(half);
    }
  });

  it('rounds to the nearest value, ties to even', () => {
    // Between 1 (0x3c00) and the next value 1 + 2^-10: the midpoint goes to the even mantissa, 1.
    expect(toHalf(1 + 2 ** -11)).toBe(0x3c00);
    expect(toHalf(1 + 2 ** -11 + 2 ** -20)).toBe(0x3c01);
    expect(toHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });

  it('packs two values with the first in the low half', () => {
    expect(packHalf2(1, -2)).toBe(0xc0003c00);
    expect(unpackHalf2(packHalf2(0.5, -8))).toEqual([0.5, -8]);
  });
});
