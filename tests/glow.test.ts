import { describe, expect, it } from 'vitest';
import { ELEMENTS, type ElementDef } from '../src/elements';
import { coverSize, glowLevelSizes } from '../src/glow';
import { ABSOLUTE_ZERO, EMISSION_REFERENCE, GLOW_START, emissionShare } from '../src/heat';
import { CELL_SIZE } from '../src/physics';
import { LOOK, lookSettings } from '../src/look';
import { displayWGSL } from '../src/shaders/display.wgsl';
import { COVER_CELLS, coverageWGSL } from '../src/shaders/glow.wgsl';
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
    // (T⁴ − 798.15⁴) / (1273.15⁴ − 798.15⁴), T in kelvin, worked out by hand.
    expect(emissionShare(700)).toBeCloseTo(0.22103, 4);
    expect(emissionShare(1300)).toBeCloseTo(2.57427, 4);
    expect(emissionShare(1700)).toBeCloseTo(6.64053, 4);
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
    expect(storageBuffers(coverageWGSL(ELEMENTS, GRAPHICS, 64, 32))).toBe(6);
  });

  it('the display keeps within the default limit of 8 storage buffers', () => {
    // Five fields and the overlay; the air state is the seventh with air.
    expect(storageBuffers(displayWGSL(ELEMENTS, GRAPHICS))).toBe(6);
    expect(storageBuffers(displayWGSL(ELEMENTS, GRAPHICS, { cellSize: 4, columns: 16, rows: 8 }))).toBe(7);
  });
});

describe('M11.4 shadows', () => {
  it('keeps the shadow darkness in 0..1, the length a whole number in 1..64 and the light direction a unit vector', () => {
    expect(lookSettings().shadowDarkness).toBe(LOOK.shadowDarkness);
    expect(lookSettings().shadowLength).toBe(LOOK.shadowLength);
    expect(lookSettings({ shadowDarkness: -1 }).shadowDarkness).toBe(0);
    expect(lookSettings({ shadowDarkness: 2 }).shadowDarkness).toBe(1);
    expect(lookSettings({ shadowLength: 0 }).shadowLength).toBe(1);
    expect(lookSettings({ shadowLength: 500 }).shadowLength).toBe(64);
    const [x, y] = lookSettings().lightDirection;
    expect(x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(lookSettings({ lightDirection: [0, 3] }).lightDirection).toEqual([0, 1]);
    expect(lookSettings({ lightDirection: [0, 0] }).lightDirection).toEqual(lookSettings().lightDirection);
    expect(lookSettings({ lightDirection: [Number.NaN, 1] }).lightDirection).toEqual(lookSettings().lightDirection);
  });

  it('sizes the cover texture at one texel per 4 cells, rounded up', () => {
    expect(COVER_CELLS).toBe(4);
    expect(coverSize(2560, 1340)).toEqual({ width: 640, height: 335 });
    expect(coverSize(3, 1)).toEqual({ width: 1, height: 1 });
  });

  it('the coverage pass writes three textures, within the default limit of 4 storage textures', () => {
    expect([...coverageWGSL(ELEMENTS, GRAPHICS, 64, 32).matchAll(/texture_storage_2d/g)]).toHaveLength(3);
  });
});

describe('M11.5 soft gases', () => {
  it('keeps the gas opacity in 0..1', () => {
    expect(lookSettings().gasOpacity).toBe(LOOK.gasOpacity);
    expect(lookSettings({ gasOpacity: -1 }).gasOpacity).toBe(0);
    expect(lookSettings({ gasOpacity: 3 }).gasOpacity).toBe(1);
    expect(lookSettings({ gasOpacity: 0.3 }).gasOpacity).toBe(0.3);
  });
});

describe('M11.6 liquid depth', () => {
  it('keeps the depth scale at 0 or more', () => {
    expect(lookSettings().depthScale).toBe(LOOK.depthScale);
    expect(lookSettings({ depthScale: -5 }).depthScale).toBe(0);
    expect(lookSettings({ depthScale: Number.NaN }).depthScale).toBe(LOOK.depthScale);
    expect(lookSettings({ depthScale: 7 }).depthScale).toBe(7);
  });

  it('water absorbs red first and blue least, and oil is estimated, darker and more opaque', () => {
    const row = (key: string): ElementDef => (ELEMENTS as readonly ElementDef[]).find((e) => e.key === key)!;
    const [r, g, b] = row('WATER').look!.absorption!;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    // Pope and Fry's pure water plus the same turbidity on every channel.
    expect((r - b) / CELL_SIZE).toBeCloseTo(0.340 - 0.00922, 9);
    expect((g - b) / CELL_SIZE).toBeCloseTo(0.0565 - 0.00922, 9);
    expect(row('OIL').look!.opacity).toBe(0.9);
    // Lava and molten metal are opaque and take no tint.
    for (const key of ['LAVA', 'MOLTEN_METAL']) {
      expect(row(key).look?.opacity, key).toBe(1);
      expect(row(key).look?.absorption, key).toBeUndefined();
    }
  });
});

describe('M11.7 air shimmer without a GPU', () => {
  const shape = { cellSize: 4, columns: 16, rows: 8 };

  it('keeps the shimmer settings at 0 or more', () => {
    expect(lookSettings().shimmer).toBe(LOOK.shimmer);
    expect(lookSettings().shimmerPressure).toBe(LOOK.shimmerPressure);
    expect(lookSettings().shimmerMax).toBe(LOOK.shimmerMax);
    expect(lookSettings({ shimmer: -1 }).shimmer).toBe(0);
    expect(lookSettings({ shimmerPressure: -1 }).shimmerPressure).toBe(0);
    expect(lookSettings({ shimmerMax: Number.NaN }).shimmerMax).toBe(LOOK.shimmerMax);
    expect(lookSettings({ shimmerMax: 2 }).shimmerMax).toBe(2);
  });

  it('M11 AC13: generates no shimmer code without air', () => {
    expect(displayWGSL(ELEMENTS, GRAPHICS)).not.toContain('fn shimmerShift');
    expect(displayWGSL(ELEMENTS, GRAPHICS, shape)).toContain('fn shimmerShift');
  });
});
