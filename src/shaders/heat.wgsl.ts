import { CONDUCTION, GLOW_FULL, GLOW_RAMP, GLOW_START, HEAT_RAMP, type RampKnot } from '../heat';
import { wgslFloat } from '../movement';

// Heat in the CA: the WGSL for conduction between the cells of a block. Needs the `Cell` type and the element table.

export const heatWGSL = /* wgsl */`
// The temperature a cell conducts at: its stored temperature clamped to its element's thresholds. The two differ only
// while the cell takes in or gives out the latent heat of a transition; an element without a threshold has one at
// +-3e38, so the clamp changes nothing for it.
fn cellTemp(c: Cell) -> f32 {
  let t = cellType(c);
  return clamp(cellStoredTemp(c), elBelowTemp(t), elAboveTemp(t));
}

// One heat exchange between two cells of a block; returns their new stored temperatures. The pair meets at the
// harmonic mean of their conductivities, 2 ka kb / (ka + kb), which is 0 when either is 0 (the plain formula is 0/0 for
// two cells that hold no heat). Each cell moves toward the capacity-weighted mean of the two by a share of the way
// (\`heatShare\` in src/heat.ts: the heat equation on the physical scale, at most 1), so any conductivity is stable and
// never goes past the mean, and the heat gained by one is the heat lost by the other. A pair that exchanges nothing gets
// its own words back, so a cell that holds no heat keeps its \`temp\` word.
const CONDUCTION: f32 = ${wgslFloat(CONDUCTION)};

fn exchangeHeat(a: Cell, b: Cell) -> vec2f {
  let ka = elConductivity(cellType(a));
  let kb = elConductivity(cellType(b));
  if (ka <= 0.0 || kb <= 0.0) { return vec2f(a.temp, b.temp); }
  let d = cellTemp(a) - cellTemp(b);
  if (d == 0.0) { return vec2f(a.temp, b.temp); }
  let ca = elHeatCapacity(cellType(a));
  let cb = elHeatCapacity(cellType(b));
  let share = min(1.0, CONDUCTION * (2.0 * ka * kb / (ka + kb)) * (ca + cb) / (ca * cb));
  let flow = share * d / (ca + cb);
  return vec2f(a.temp - flow * cb, b.temp + flow * ca);
}
`;

const f32Literal = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));
const vec3Literal = (c: readonly number[]): string => `vec3f(${c.map(f32Literal).join(', ')})`;

// `fn <name>(t: f32) -> vec3f`: the ramp's color at temperature t, linear between knots and flat beyond the first and
// last. Each knot mixes in by a factor clamped to [0, 1], so the mixes of the knots below t have finished and those above
// have not started.
export function rampWGSL(name: string, ramp: readonly RampKnot[]): string {
  const steps = ramp.slice(1).map((k, i) => {
    const from = ramp[i].temp;
    return `  c = mix(c, ${vec3Literal(k.color)}, clamp((t - ${f32Literal(from)}) / ${f32Literal(k.temp - from)}, 0.0, 1.0));`;
  });
  return `fn ${name}(t: f32) -> vec3f {
  var c = ${vec3Literal(ramp[0].color)};
${steps.join('\n')}
  return c;
}`;
}

// The display's use of heat: the heat view's color of a temperature, and the glow a hot cell adds to its own color in the
// normal view (`glowColor` scaled by `glowWeight`, which is 0 up to the start and 1 from the full point).
export const heatDisplayWGSL = /* wgsl */`
${rampWGSL('heatColor', HEAT_RAMP)}
${rampWGSL('glowColor', GLOW_RAMP)}
fn glowWeight(t: f32) -> f32 {
  return clamp((t - ${f32Literal(GLOW_START)}) / ${f32Literal(GLOW_FULL - GLOW_START)}, 0.0, 1.0);
}
`;
