// Fire next to water turns to smoke. Otherwise a burning cell is at least as hot as a flame: burning releases heat, so
// fire heats what it touches however it was lit (oil lit by heat starts at its ignition temperature and is raised here).
// Burning out and igniting its neighbors are table rows (`life`, `flammable`).
// A rule runs for one cell of the block, `i` (0 bottom left, 1 bottom right, 2 top left, 3 top right), and may
// read and change any of the four cells of the block, never a cell outside it. A rule that turns a cell into another
// element uses `retype` (or `withLife`, `withMotion`), which keep the cell's other fields.
export const fireRule = /* wgsl */`
fn rule_fire(i: u32, block: ptr<function, array<Cell, 4>>) {
  for (var j = 0u; j < 4u; j++) {
    if (j != i && cellType((*block)[j]) == EL_WATER) {
      (*block)[i] = retype((*block)[i], EL_SMOKE, cellVariant((*block)[i]), 0u);
      return;
    }
  }
  (*block)[i] = withTemp((*block)[i], max(cellStoredTemp((*block)[i]), elTemperature(EL_FIRE)));
}
`;
