// Heat in the CA: the WGSL for conduction between the cells of a block. Needs the `Cell` type and the element table.

export const heatWGSL = /* wgsl */`
// The temperature a cell conducts at: its stored temperature.
fn cellTemp(c: Cell) -> f32 { return cellStoredTemp(c); }

// One heat exchange between two cells of a block; returns their new stored temperatures. The pair meets at the
// harmonic mean of their conductivities, 2 ka kb / (ka + kb), which is 0 when either is 0 (the plain formula is 0/0 for
// two cells that hold no heat). Each cell moves toward the capacity-weighted mean of the two and never past it, so any
// conductivity in [0, 1] is stable, and the heat gained by one is the heat lost by the other. A pair that exchanges
// nothing gets its own words back, so a cell that holds no heat keeps its \`temp\` word.
fn exchangeHeat(a: Cell, b: Cell) -> vec2f {
  let ka = elConductivity(cellType(a));
  let kb = elConductivity(cellType(b));
  if (ka <= 0.0 || kb <= 0.0) { return vec2f(a.temp, b.temp); }
  let d = cellTemp(a) - cellTemp(b);
  if (d == 0.0) { return vec2f(a.temp, b.temp); }
  let ca = elHeatCapacity(cellType(a));
  let cb = elHeatCapacity(cellType(b));
  let flow = (2.0 * ka * kb / (ka + kb)) * d / (ca + cb);
  return vec2f(a.temp - flow * cb, b.temp + flow * ca);
}
`;
