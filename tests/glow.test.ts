import { describe, expect, it } from 'vitest';
import { ELEMENTS } from '../src/elements';
import { glowLevelSizes } from '../src/glow';
import { ABSOLUTE_ZERO, EMISSION_REFERENCE, GLOW_START, emissionShare } from '../src/heat';
import { LOOK, lookSettings } from '../src/look';
import { displayWGSL } from '../src/shaders/display.wgsl';
import { coverageWGSL } from '../src/shaders/glow.wgsl';
import { GRAPHICS } from '../src/shaders/graphics.wgsl';

// M11.3 without a GPU: the emission law, the settings and the generated shaders (docs/plans/m11-rendering.md).

describe('M11.3 emission', () => {
  it('radiates nothing up to GLOW_START, the reference amount at EMISSION_REFERENCE and more the hotter', () => {
    expect(emissionShare(ABSOLUTE_ZERO)).toBe(0);
    expect(emissionShare(20)).toBe(0);
    expect(emissionShare(GLOW_START)).toBe(0);
    expect(emissionShare(EMISSION_REFERENCE)).toBeCloseTo(1, 12);
    let previous = 0;
    for (const temp of [GLOW_START + 1, 700, 1000, 1300, 1700, 2000, 9999]) {
      expect(emissionShare(temp), `${temp} °C`).toBeGreaterThan(previous);
      previous = emissionShare(temp);
    }
  });

  it('grows as the fourth power of the absolute temperature', () => {
    // Above the start, the share plus the start's own power is proportional to T^4: doubling the kelvin multiplies it by 16.
    const power = (celsius: number): number => emissionShare(celsius) * ((EMISSION_REFERENCE - ABSOLUTE_ZERO) ** 4 - (GLOW_START - ABSOLUTE_ZERO) ** 4) + (GLOW_START - ABSOLUTE_ZERO) ** 4;
    const kelvin = 1000;
    expect(power(2 * kelvin + ABSOLUTE_ZERO) / power(kelvin + ABSOLUTE_ZERO)).toBeCloseTo(16, 9);
  });
});

describe('M11.3 settings', () => {
  it('keeps the glow strength in 0..1 and the glow levels a whole number in 1..6', () => {
    expect(lookSettings().glowStrength).toBe(LOOK.glowStrength);
    expect(lookSettings().glowLevels).toBe(LOOK.glowLevels);
    expect(lookSettings({ glowStrength: -1 }).glowStrength).toBe(0);
    expect(lookSettings({ glowStrength: 3 }).glowStrength).toBe(1);
    expect(lookSettings({ glowLevels: 0 }).glowLevels).toBe(1);
    expect(lookSettings({ glowLevels: 99 }).glowLevels).toBe(6);
    expect(lookSettings({ glowLevels: 2.6 }).glowLevels).toBe(3);
  });

  it('halves the glow levels from the emission texture, at one cell per two texels, never under 1 texel', () => {
    expect(glowLevelSizes(2560, 1340, 4)).toEqual([
      { width: 1280, height: 670 },
      { width: 640, height: 335 },
      { width: 320, height: 168 },
      { width: 160, height: 84 },
      { width: 80, height: 42 },
    ]);
    expect(glowLevelSizes(3, 1, 3)).toEqual([{ width: 2, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }]);
  });
});

describe('M11.3 shaders', () => {
  const storageBuffers = (wgsl: string): number => [...wgsl.matchAll(/var<storage/g)].length;

  it('the coverage pass binds five fields and the overlay, within the default limit of 8 storage buffers', () => {
    const wgsl = coverageWGSL(ELEMENTS, GRAPHICS, 64, 32);
    expect(storageBuffers(wgsl)).toBe(6);
    expect(wgsl).toContain('const WIDTH: u32 = 64u;');
    expect(wgsl).toContain('const HEIGHT: u32 = 32u;');
  });

  it('fire shines by its graphics color and life, in the coverage pass and the display', () => {
    expect(coverageWGSL(ELEMENTS, GRAPHICS, 64, 32)).toContain('case EL_FIRE:');
    expect(displayWGSL(ELEMENTS, GRAPHICS)).toContain('graphics_fire(c, elColor(t))');
  });

  it('the display reads the overlay as two words per cell and keeps within the default limit', () => {
    const wgsl = displayWGSL(ELEMENTS, GRAPHICS);
    expect(wgsl).toContain('flyerWords[2u * idx + 1u]');
    // Five fields and the overlay; the air state is the seventh with air.
    expect(storageBuffers(wgsl)).toBe(6);
  });
});
