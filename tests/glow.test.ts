import { describe, expect, it } from 'vitest';
import { ELEMENTS, type ElementDef } from '../src/elements';
import { coverSize, glowLevelSizes } from '../src/glow';
import { ABSOLUTE_ZERO, EMISSION_REFERENCE, GLOW_START, emissionShare } from '../src/heat';
import { LOOK, lookSettings } from '../src/look';
import { displayWGSL } from '../src/shaders/display.wgsl';
import { COVER_CELLS, coverageWGSL } from '../src/shaders/glow.wgsl';
import { GRAPHICS } from '../src/shaders/graphics.wgsl';
import { shadowWGSL } from '../src/shaders/shadow.wgsl';

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

  it('the coverage pass writes the cover texture beside the emission one and the gas one, within the default limit of 4 storage textures', () => {
    const wgsl = coverageWGSL(ELEMENTS, GRAPHICS, 64, 32);
    expect(wgsl).toContain('var cover: texture_storage_2d<rgba8unorm, write>');
    expect([...wgsl.matchAll(/texture_storage_2d/g)]).toHaveLength(3);
  });

  it('the shadow pass marches the set length toward the light, and the composite shades empty space and gas only', () => {
    const wgsl = shadowWGSL(24, [-Math.SQRT1_2, Math.SQRT1_2]);
    expect(wgsl).toContain('const LENGTH: i32 = 24;');
    expect(wgsl).toContain('TOWARD_LIGHT: vec2f = vec2f(-0.70710');
    const display = displayWGSL(ELEMENTS, GRAPHICS);
    expect(display).toContain('(pType == EL_EMPTY || elState(pType) == ST_GAS)');
    expect(display).toContain('color *= 1.0 - u.shadow * shade;');
  });
});

describe('M11.5 soft gases', () => {
  it('keeps the gas opacity in 0..1', () => {
    expect(lookSettings().gasOpacity).toBe(LOOK.gasOpacity);
    expect(lookSettings({ gasOpacity: -1 }).gasOpacity).toBe(0);
    expect(lookSettings({ gasOpacity: 3 }).gasOpacity).toBe(1);
    expect(lookSettings({ gasOpacity: 0.3 }).gasOpacity).toBe(0.3);
  });

  it('the coverage pass writes the gas share into the cover texture and the gas cells\' color into the gas texture', () => {
    const wgsl = coverageWGSL(ELEMENTS, GRAPHICS, 64, 32);
    expect(wgsl).toContain('var gasCloud: texture_storage_2d<rgba16float, write>');
    expect(wgsl).toContain('vec4f(opacity / 16.0, liquid / 16.0, gas.a, 0.0)');
    expect(wgsl).toContain('textureStore(gasCloud, gid.xy, gas);');
  });

  it('the composite draws gas cells as a cloud in the finished look only, over empty space and gas', () => {
    const wgsl = displayWGSL(ELEMENTS, GRAPHICS);
    expect(wgsl).toContain('let softGas = u.cellsLook < 0.5 && !heatView && !airView && u.gas > 0.0');
    expect(wgsl).toContain('if (pType != EL_EMPTY && !softGas) {');
    expect(wgsl).toContain('if (u.gas > 0.0 && (pType == EL_EMPTY || softGas)) {');
    expect(wgsl).toContain('light = light * (1.0 - gas.a * u.gas) + gas.rgb * u.gas;');
  });

  it('the cell color path is shared by the display and the coverage pass, and the display stays within 8 storage buffers', () => {
    expect(displayWGSL(ELEMENTS, GRAPHICS)).toContain('color = litColor(cell, color);');
    expect(coverageWGSL(ELEMENTS, GRAPHICS, 64, 32)).toContain('litColor(c, elColor(id))');
    expect([...displayWGSL(ELEMENTS, GRAPHICS).matchAll(/var<storage/g)]).toHaveLength(6);
  });
});

describe('M11.6 liquid depth and surface', () => {
  it('keeps the surface in 0..1 and the depth scale at 0 or more', () => {
    expect(lookSettings().liquidSurface).toBe(LOOK.liquidSurface);
    expect(lookSettings({ liquidSurface: 3 }).liquidSurface).toBe(1);
    expect(lookSettings({ liquidSurface: -1 }).liquidSurface).toBe(0);
    expect(lookSettings().depthScale).toBe(LOOK.depthScale);
    expect(lookSettings({ depthScale: -5 }).depthScale).toBe(0);
    expect(lookSettings({ depthScale: Number.NaN }).depthScale).toBe(LOOK.depthScale);
    expect(lookSettings({ depthScale: 7 }).depthScale).toBe(7);
  });

  it('the coverage pass counts the liquid cells into the green channel of the cover texture', () => {
    const wgsl = coverageWGSL(ELEMENTS, GRAPHICS, 64, 32);
    expect(wgsl).toContain('elState(loadKind(y * WIDTH + x) & 0xffu) == ST_LIQUID');
    expect(wgsl).toContain('liquid += liquidAt(');
  });

  it('the composite tints and brightens liquids with an absorption in the finished look only, and reads four sampled textures', () => {
    const wgsl = displayWGSL(ELEMENTS, GRAPHICS);
    expect(wgsl).toContain('if (u.cellsLook < 0.5 && !airView && elState(pType) == ST_LIQUID) {');
    expect(wgsl).toContain('color = liquidColor(pType, color, cellX, cellY, w, h);');
    expect(wgsl).toContain('const SURFACE_ROWS: u32 = 3u;');
    expect(wgsl).toContain('const DEPTH_TEXELS: i32 = 32;');
    expect([...wgsl.matchAll(/texture_2d<f32>/g)]).toHaveLength(4);
  });

  it('water absorbs red first and blue least, and oil is estimated, darker and more opaque', () => {
    const row = (key: string): ElementDef => (ELEMENTS as readonly ElementDef[]).find((e) => e.key === key)!;
    const [r, g, b] = row('WATER').look!.absorption!;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    expect(r / b).toBeCloseTo(0.340 / 0.00922, 6);
    expect(row('OIL').look!.opacity).toBe(0.9);
    // Lava and molten metal are opaque and take no tint or surface line.
    for (const key of ['LAVA', 'MOLTEN_METAL']) {
      expect(row(key).look?.opacity, key).toBe(1);
      expect(row(key).look?.absorption, key).toBeUndefined();
    }
  });
});
