import { DISPLAY_FIELDS } from '../display-table';
import { MAX_ELEMENTS, type ElementDef } from '../elements';
import { ABSOLUTE_ZERO, EMISSION_REFERENCE, GLOW_START } from '../heat';
import { wgslFloat } from '../movement';

// What the display and the coverage pass share: the graphics functions of the table, the display table's binding, the
// conversions between display values and linear light, and the light a cell radiates.

/** The WGSL of the graphics functions the table names (each once) and the elements that use one. */
export function graphicsWGSL(elements: readonly ElementDef[], graphics: Readonly<Record<string, string>>): { styled: ElementDef[]; source: string } {
  const styled = elements.filter((e) => e.graphics !== undefined);
  for (const e of styled) if (!(e.graphics! in graphics)) throw new Error(`element ${e.key}: unknown graphics "${e.graphics}"`);
  const names = [...new Set(styled.map((e) => e.graphics!))];
  return { styled, source: names.map((n) => graphics[n]).join('\n') };
}

// The visual properties of the elements (src/display-table.ts), one row per element ID, at binding 2 of group 0 in the
// display and in the coverage pass.
export const displayPropsWGSL = /* wgsl */`
struct DisplayProps {
${DISPLAY_FIELDS.map((f) => `  ${f.name}: f32,`).join('\n')}
};

@group(0) @binding(2) var<uniform> displayProps: array<DisplayProps, ${MAX_ELEMENTS}>;
`;

// Needs the `Cell` type, the element table, `cellTemp`, `glowColor`, `glowWeight`, the graphics functions and `displayProps`.
//
// The finished look computes in linear light and encodes at the end (the canvas is not an sRGB format). A table color is a
// display value, so the round trip leaves it as it was.
//
// `cellEmission` is the light a cell radiates, in linear light: only an element that holds heat radiates. A cell above
// GLOW_START shines in its `glowColor`, as bright as the fourth power of its absolute temperature says (`blackbodyShare`,
// 1 at EMISSION_REFERENCE; twin of `emissionShare` in src/heat.ts). An element with a lifetime and its own graphics (fire)
// shines in its graphics color, twice as bright while young and fading with its life. A flyer is a cell like any other.
export const lightWGSL = (styled: readonly ElementDef[]): string => /* wgsl */`
fn srgbToLinear(c: vec3f) -> vec3f {
  let v = max(c, vec3f(0.0));
  return select(pow((v + 0.055) / 1.055, vec3f(2.4)), v / 12.92, v <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055, v * 12.92, v <= vec3f(0.0031308));
}

const KELVIN_START: f32 = ${wgslFloat(GLOW_START - ABSOLUTE_ZERO)};
const KELVIN_REFERENCE: f32 = ${wgslFloat(EMISSION_REFERENCE - ABSOLUTE_ZERO)};
const POWER_START: f32 = KELVIN_START * KELVIN_START * KELVIN_START * KELVIN_START;
const POWER_REFERENCE: f32 = KELVIN_REFERENCE * KELVIN_REFERENCE * KELVIN_REFERENCE * KELVIN_REFERENCE;

fn blackbodyShare(temp: f32) -> f32 {
  let k = temp - ${wgslFloat(ABSOLUTE_ZERO)};
  let k2 = k * k;
  return max((k2 * k2 - POWER_START) / (POWER_REFERENCE - POWER_START), 0.0);
}

fn cellEmission(c: Cell) -> vec3f {
  let t = cellType(c);
  if (!elHoldsHeat(t)) { return vec3f(0.0); }
  let scale = displayProps[t].emission;
  switch (t) {
${styled.filter((e) => e.life !== undefined).map((e) => `    case EL_${e.key}: {
      let young = clamp(f32(cellLife(c)) / f32(elLifeStart(t)), 0.0, 1.0);
      return srgbToLinear(graphics_${e.graphics}(c, elColor(t))) * (2.0 * young * scale);
    }`).join('\n')}
    default: {}
  }
  let temp = cellTemp(c);
  return srgbToLinear(glowColor(temp)) * (blackbodyShare(temp) * scale);
}

// The color a cell is drawn in as a cell, from its base color (the table color, with its grain): its graphics function, or
// else the glow a cell that holds heat adds to its own color. The cells look draws every cell so; the finished look draws
// gas so, into the cloud layer.
fn litColor(c: Cell, base: vec3f) -> vec3f {
  let t = cellType(c);
  var color = base;
  var hasGraphics = false;
  switch (t) {
${styled.map((e) => `    case EL_${e.key}: { color = graphics_${e.graphics}(c, color); hasGraphics = true; }`).join('\n')}
    default: {}
  }
  if (elHoldsHeat(t) && !hasGraphics) {
    let temp = cellTemp(c);
    color += glowColor(temp) * glowWeight(temp);
  }
  return color;
}
`;
