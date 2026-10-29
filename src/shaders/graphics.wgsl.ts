// WGSL color functions of the elements that are not one flat color, by the name an `ElementDef.graphics` carries. Each
// source defines `fn graphics_<name>(c: Cell, color: vec3f) -> vec3f`, given the cell and the element's table color.
export const GRAPHICS: Readonly<Record<string, string>> = {
  // Bright while young, dim embers as the life runs out.
  fire: /* wgsl */`
fn graphics_fire(c: Cell, color: vec3f) -> vec3f {
  let t = clamp(f32(cellLife(c)) / f32(elLifeStart(cellType(c))), 0.0, 1.0);
  let dim = vec3f(0.80, 0.18, 0.04);
  return mix(dim, color, t);
}
`,
  // A molten cell: its row's color pulled toward the color of the element it sets into and darkened, so what it melted from
  // shows through and the glow of its temperature, added after, still makes it brighter as it heats. One with no ctype keeps its
  // table color.
  molten: /* wgsl */`
fn graphics_molten(c: Cell, color: vec3f) -> vec3f {
  let k = kindMelt(c.kind);
  if (k == 0u) { return color; }
  return mix(color, elColor(k), 0.6) * 0.65;
}
`,
};
