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
fn elDensity(t: u32) -> f32 { return elements[t].density; }
fn elState(t: u32) -> u32 { return elements[t].state; }
fn elFlammable(t: u32) -> bool { return elements[t].flammable != 0u; }
fn elLifeStart(t: u32) -> u32 { return elements[t].lifeStart; }
fn elLifeDecay(t: u32) -> u32 { return elements[t].lifeRule & 0xffu; }
fn elBecomes(t: u32) -> u32 { return (elements[t].lifeRule >> 8u) & 0xffu; }
fn elGravity(t: u32) -> f32 { return elements[t].gravity; }
fn elDrag(t: u32) -> f32 { return elements[t].drag; }
fn elInert(t: u32) -> bool { return elements[t].inert != 0u; }
fn elTemperature(t: u32) -> f32 { return elements[t].temperature; }
`;
