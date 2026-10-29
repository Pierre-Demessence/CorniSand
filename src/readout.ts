import { ELEMENTS, cellName, elementHoldsHeat, meltRow, type ElementDef } from './elements';
import { effectiveTemp } from './heat';
import type { CellProbe } from './simulation';

/** Air pressure for the readout: signed, two decimals (the blast thresholds are a few tenths), no sign on a zero. */
export function formatPressure(pressure: number): string {
  const text = pressure.toFixed(2);
  return Number(text) === 0 ? '0.00' : pressure > 0 ? `+${text}` : text;
}

/**
 * The line shown for the cell under the pointer: "Sand · 25 °C · pressure +1.20". Empty space shows its air's
 * temperature. A wall holds no heat and its air cell is a closed pocket, so it shows the label alone. Without air the
 * probe has no pressure and the line ends after the temperature. A molten cell is named by what it sets into ("Lava" for
 * melted basalt, "Molten glass"), see `cellName`.
 */
export function formatProbe(element: ElementDef, probe: CellProbe, table: readonly ElementDef[] = ELEMENTS): string {
  const holdsHeat = elementHoldsHeat(element);
  const isAir = element.state === 'empty';
  const ctype = probe.ctype ?? 0;
  const parts = [cellName(table, element.id, ctype) || element.label];
  if (holdsHeat) parts.push(`${Math.round(effectiveTemp(element, probe.temp, meltRow(table, element, ctype)))} °C`);
  else if (isAir && probe.airTemp !== undefined) parts.push(`${Math.round(probe.airTemp)} °C`);
  if (probe.pressure !== undefined && (holdsHeat || isAir)) parts.push(`pressure ${formatPressure(probe.pressure)}`);
  return parts.join(' · ');
}
