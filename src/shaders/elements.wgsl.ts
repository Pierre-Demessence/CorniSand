import { PROP_FIELDS } from '../element-table';
import { MAX_ELEMENTS, STATES, type ElementDef } from '../elements';

// The element IDs (`EL_SAND`) and states (`ST_POWDER`) as constants, generated from the table: what a shader needs to
// name an element without touching the table's buffer.
export const elementConstantsWGSL = (elements: readonly ElementDef[]): string => /* wgsl */`
${elements.map((e) => `const EL_${e.key}: u32 = ${e.id}u;`).join('\n')}

${STATES.map((s, i) => `const ST_${s.toUpperCase()}: u32 = ${i}u;`).join('\n')}
`;

// The table as a uniform array (group 2, binding 0) with an accessor per property. Element IDs are 8 bits, so any
// cell's type is a valid index.
export const elementsWGSL = /* wgsl */`
struct ElementProps {
${PROP_FIELDS.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}
};

@group(2) @binding(0) var<uniform> elements: array<ElementProps, ${MAX_ELEMENTS}>;

fn elColor(t: u32) -> vec3f { return vec3f(elements[t].colorR, elements[t].colorG, elements[t].colorB); }
// The density that does not depend on the temperature: a powder's or a solid's, a liquid's nominal one.
fn elDensity(t: u32) -> f32 { return elements[t].density; }
const DENSITY_KNOTS: u32 = 1u;
const DENSITY_GAS: u32 = 2u;
fn elDensityMode(t: u32) -> u32 { return elements[t].densityMode; }
// The density at a temperature in °C (\`densityAt\` in src/elements.ts): a liquid's knots interpolated linearly and flat beyond
// the first and last (each knot mixes in by a factor clamped to [0, 1], as the heat ramps do; unused knots repeat the last
// density), a gas's first knot scaled by the ideal-gas law, and the plain density for everything else.
fn elDensityAt(t: u32, temp: f32) -> f32 {
  let mode = elements[t].densityMode;
  if (mode == DENSITY_GAS) {
    return elements[t].densityKnot0 * (elements[t].densityTemp0 + 273.15) / max(temp + 273.15, 1.0);
  }
  if (mode != DENSITY_KNOTS) { return elements[t].density; }
  var d = elements[t].densityKnot0;
  d = mix(d, elements[t].densityKnot1, clamp((temp - elements[t].densityTemp0) / (elements[t].densityTemp1 - elements[t].densityTemp0), 0.0, 1.0));
  d = mix(d, elements[t].densityKnot2, clamp((temp - elements[t].densityTemp1) / (elements[t].densityTemp2 - elements[t].densityTemp1), 0.0, 1.0));
  d = mix(d, elements[t].densityKnot3, clamp((temp - elements[t].densityTemp2) / (elements[t].densityTemp3 - elements[t].densityTemp2), 0.0, 1.0));
  return d;
}
fn elState(t: u32) -> u32 { return elements[t].state; }
fn elFlammable(t: u32) -> bool { return elements[t].flammable != 0u; }
fn elLifeStart(t: u32) -> u32 { return elements[t].lifeStart; }
fn elLifeDecay(t: u32) -> u32 { return elements[t].lifeRule & 0xffu; }
fn elBecomes(t: u32) -> u32 { return (elements[t].lifeRule >> 8u) & 0xffu; }
fn elGravity(t: u32) -> f32 { return elements[t].gravity; }
fn elDrag(t: u32) -> f32 { return elements[t].drag; }
fn elSpread(t: u32) -> f32 { return elements[t].spread; }
fn elSlide(t: u32) -> f32 { return elements[t].slide; }
fn elInert(t: u32) -> bool { return elements[t].inert != 0u; }
fn elTemperature(t: u32) -> f32 { return elements[t].temperature; }
fn elConductivity(t: u32) -> f32 { return elements[t].conductivity; }
fn elHeatCapacity(t: u32) -> f32 { return elements[t].heatCapacity; }
fn elHoldsHeat(t: u32) -> bool { return elements[t].holdsHeat != 0u; }
fn elBelowTemp(t: u32) -> f32 { return elements[t].belowTemp; }
fn elBelowWidth(t: u32) -> f32 { return elements[t].belowWidth; }
fn elAboveTemp(t: u32) -> f32 { return elements[t].aboveTemp; }
fn elAboveWidth(t: u32) -> f32 { return elements[t].aboveWidth; }
fn elBelowBecomes(t: u32) -> u32 { return elements[t].transitions & 0xffu; }
fn elAboveBecomes(t: u32) -> u32 { return (elements[t].transitions >> 8u) & 0xffu; }
fn elAboveBurst(t: u32) -> f32 { return elements[t].aboveBurst; }
fn elPressureAbove(t: u32) -> f32 { return elements[t].pressureAbove; }
fn elPressureBecomes(t: u32) -> u32 { return (elements[t].transitions >> 16u) & 0xffu; }
// Thermal shock: the temperature difference to a neighbor above which a cell cracks (0: it cannot), and the element it
// cracks into, which is its pressure target.
fn elShockLimit(t: u32) -> f32 { return elements[t].shockLimit; }
`;
