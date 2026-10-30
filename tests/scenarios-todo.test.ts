import { describe, it } from 'vitest';

// The catalogue of real-world scenarios that are not built yet (`docs/plans/m8.9-real-world-scenarios.md`, AC14), one
// `it.todo` titled `<name>: <target>` each, with the calculation of its target, its sources and what it needs in a comment
// beside it. The file holds no test body, imports no GPU code and creates no device.
//
// Whoever builds a scenario moves its todo into a test file of its topic (M8.1: `tests/materials.test.ts`), written with
// `scenario()` and `control()` from `tests/scenario.ts` before the rows and mechanics it needs. The rules of
// `AGENTS.md` ("Real-world scenarios") hold: the target is the calculation below, never a value the game produced;
// a todo that gives no tolerance gets one, from the spread of its data, when it is built, and only the user changes it
// afterwards. "Estimate" marks a figure from a simplified model, "handbook" a value of the CRC Handbook or NIST.
//
// The scale: one cell is 1.3625 mm and one dispatch 2.08 ms (`src/physics.ts`), 734 cells to the metre, and a minute of
// game time is 14,400 supersteps.

describe('scenarios to build with M8.1 materials', () => {
  describe('iceOnMetal', () => {
    // Experiment: ice cubes at 0 °C on an aluminium and an acrylic block, both at room temperature.
    // Target: the cube on aluminium melts many times sooner. A melting face stays at 0 °C, so the first heat flows of the
    //   two blocks differ by the ratio of their thermal effusivities sqrt(k rho c), 41 to 45; ice colder than 0 °C narrows it.
    // Calculation: aluminium 237 W/m·K, 2,700 kg/m³, 0.897 kJ/kg·K gives sqrt(237 x 2,700 x 897) = 23,960 W·s^0.5/m²·K;
    //   acrylic 0.19 W/m·K, 1,180 to 1,200 kg/m³, 1.26 to 1.47 kJ/kg·K gives 532 to 579; the ratio is 23,960 / 579 = 41.4
    //   to 23,960 / 532 = 45.1. The melt times come from a calculation for the chosen blocks when it is built.
    // Sources: Wikipedia, List of thermal conductivities (aluminium); MakeItFrom, PMMA, and a Xometry datasheet (acrylic;
    //   they disagree on the specific heat, 1.26 and 1.47 kJ/kg·K, which makes the range).
    // Measure: supersteps until no ICE cell is left on each block.
    // Needs: ACRYLIC (M8.2); ALUMINIUM (M8.1f) exists, and COPPER and INSULATION could stand in.
    it.todo('iceOnMetal: an ice cube at 0 °C on an aluminium block melts many times sooner than on an acrylic block, their first heat flows differing by 41 to 45');
  });
});

describe('scenarios to build later', () => {
  describe('damBreak', () => {
    // Experiment: a released water column.
    // Target: its front runs at up to 2 sqrt(g H) (Ritter 1892, the ideal solution on a dry frictionless bed).
    // Calculation: a column 40 cells high is H = 40 x 1.3625 mm = 54.5 mm, so 2 x sqrt(9.81 x 0.0545) = 1.46 m/s, more than
    //   twice the grid's top speed of one cell per dispatch (1.3625 mm / 2.08 ms = 0.65 m/s); columns over 8 cells reach it.
    // Source: tilupy's analytic solutions for Ritter's solution.
    // Needs: I27 (M12.6).
    it.todo('damBreak: the front of a released water column 40 cells high runs at up to 1.46 m/s (2 sqrt(g H))');
  });

  describe('leidenfrost', () => {
    // Experiment: a water drop on a pan at 250 °C and one at 150 °C.
    // Target: the drop at 250 °C outlasts the one at 150 °C many times over; the Leidenfrost point is about 185 °C on
    //   polished steel (150 to 265 °C across studies, `docs/research/physical-properties.md`). The lifetimes come from
    //   Gottfried et al. 1966, to source when it is built. A cell is 2.5 µL against the tens of µL measured, so a cell's
    //   lifetime is shorter than the measured ones (estimate).
    // Needs: film boiling (M12.4; `docs/research/physical-properties.md`, Film boiling).
    it.todo('leidenfrost: a water drop on a pan at 250 °C outlasts one on a pan at 150 °C many times over');
  });

  describe('capillary', () => {
    // Experiment: water in a one-cell glass slot.
    // Target: it climbs 7.5 to 8 cells.
    // Calculation: h = 2 gamma cos(theta) / (rho g w) with gamma 0.0728 N/m, rho 1,000 kg/m³ and w = 1.3625 mm:
    //   2 x 0.0728 / (1,000 x 9.81 x 0.0013625) = 10.9 mm = 8.0 cells at theta 0°, 7.5 cells at 20° (cos 20° = 0.940).
    // Needs: surface tension (M12.7), GLASS (M8.1e).
    it.todo('capillary: water climbs 7.5 to 8 cells up a one-cell glass slot (2 gamma cos(theta) / (rho g w), theta 0 to 20°)');
  });

  describe('puddleOnWax', () => {
    // Experiment: water poured on wax.
    // Target: it stops spreading 3.2 cells deep.
    // Calculation: 2 l_c sin(theta / 2) with the capillary length l_c = sqrt(gamma / (rho g)) = sqrt(0.0728 / (1,000 x 9.81))
    //   = 2.72 mm (2.0 cells) and the contact angle theta = 107°: 2 x 2.72 mm x sin(53.5°) = 4.37 mm = 3.2 cells.
    // Needs: surface tension (M12.7), WAX (M8.1g).
    it.todo('puddleOnWax: water on wax stops spreading 3.2 cells deep (2 l_c sin(theta / 2), theta 107°)');
  });

  describe('sandCastle', () => {
    // Experiment: damp sand packed into a wall.
    // Target: it stands in a vertical wall 100 to 170 cells high (14 to 23 cm). The research behind this catalogue gave no
    //   calculation or source for the range; cite one when it is built (the target is not final until then).
    // Needs: moisture (M12.7).
    it.todo('sandCastle: damp sand stands in a vertical wall 100 to 170 cells high');
  });

  describe('drainage', () => {
    // Experiment: water draining through a bed of gravel and through a bed of sand.
    // Target: it drains through gravel tens of times faster. Permeability grows with the square of the grain size
    //   (Kozeny-Carman), so the ratio is that of the rows' grain sizes squared, computed from them when it is built.
    // Needs: grain size (M12.1), moisture (M12.7), GRAVEL (M8.1e).
    it.todo('drainage: water drains through gravel tens of times faster than through sand');
  });

  describe('matchInDiesel', () => {
    // Experiment: a lit match dropped into diesel and into petrol, both at room temperature.
    // Target: it goes out in diesel and lights the petrol. A liquid gives off a flammable vapor only above its flash
    //   point: diesel at least 52 °C, petrol -43 °C (handbook), so at 20 °C only petrol's vapor lights.
    // Needs: M8.2's flash point apart from the ignition temperature (data in `docs/research/physical-properties.md`).
    it.todo('matchInDiesel: a lit match dropped into diesel goes out, and into petrol it lights it (flash points: diesel at least 52 °C, petrol -43 °C)');
  });

  describe('flourDust', () => {
    // Experiment: flour dispersed in air, and a heap of flour, each with a flame.
    // Target: the dispersed flour explodes, the heap smoulders. The research behind this catalogue gave no figure; the
    //   targets (the burn's duration, the pressure of the burst) are calculated and sourced when it is built.
    // Needs: M8.2, and grain size (M12.1) for the burn speed.
    it.todo('flourDust: flour dispersed in air explodes, a heap of it smoulders');
  });

  describe('heavyGas', () => {
    // Experiment: carbon dioxide poured from a glass.
    // Target: it flows down and pools. Calculation: its density is 1.84 kg/m³ at 20 °C against air's 1.20 (handbook),
    //   1.84 / 1.20 = 1.53 times as dense.
    // Needs: M8.3.
    it.todo('heavyGas: carbon dioxide, 1.5 times as dense as air, poured from a glass flows down and pools');
  });

  describe('pressureCooker', () => {
    // Experiment: water heated in a sealed vessel at one atmosphere over ambient.
    // Target: it boils at about 120 °C (steam tables, IAPWS: 120.2 °C at 202.65 kPa absolute).
    // Needs: M8.3's boiling points that follow the pressure, on a physical pressure scale for the air.
    it.todo('pressureCooker: water boils at about 120 °C at one atmosphere over ambient');
  });

  describe('saltOnIce', () => {
    // Experiment: salt on ice.
    // Target: it makes brine that cools to -21.1 °C, the salt-water eutectic (handbook).
    // Needs: M8.4's freezing point that falls with the salt dissolved.
    it.todo('saltOnIce: salt on ice makes brine that cools to -21.1 °C');
  });

  describe('thermocouple', () => {
    // Experiment: a copper-constantan junction heated at one end.
    // Target: it gives about 40 µV per °C (type T thermocouple sensitivity, handbook; the Seebeck coefficient,
    //   `docs/research/physical-properties.md`, M7). The tolerance is fixed from the handbook's range when it is built.
    // Needs: M7's Seebeck coefficient per element (data in `docs/research/physical-properties.md`).
    it.todo('thermocouple: a copper-constantan junction gives about 40 µV per °C');
  });

  describe('prism', () => {
    // Experiment: white light through a glass prism.
    // Target: it splits into colors, blue bending more than red. Refractive indices (handbook): water 1.33, crown glass
    //   1.52, diamond 2.42; for BK7 crown glass 1.5143 at red (656 nm) and 1.5224 at blue (486 nm). The deviation angle
    //   of the chosen prism is calculated from them when it is built.
    // Needs: M7's refraction with dispersion (data in `docs/research/physical-properties.md`).
    it.todo('prism: a glass prism splits white light, blue bending more than red (crown glass 1.5143 for red, 1.5224 for blue)');
  });
});

describe('scenarios to build beside the built ones', () => {
  describe('freeFall', () => {
    // Sand's check is built by M8.9g in `tests/scenarios-flow.test.ts`; the pebble is built by M8.1e beside it; the flour needs another material.
    // Measure: dispatches until the grain reaches the floor, 734 cells (1 m) below.
    // Source: settling speeds from `docs/research/physical-properties.md` (Grain size).

    // Flour: 50 µm grains settle at 0.07 to 0.1 m/s, so 1 m takes 1 / 0.1 = 10 s to 1 / 0.07 = 14.3 s.
    // Needs: FLOUR (M8.2) and grain size (backlog I34, M12.1).
    it.todo('freeFall (flour): a pinch of flour hangs for 10 to 14 s over a fall of 1 m (734 cells)');
  });

  describe('coolingBlock', () => {
    // The held-out check of `AIR.surfaceCoefficient` (40 W/m²·K, fitted on the 50-cell block of `coolingBlock`): the
    //   constant is checked on a second size that it was not fitted on. Real natural convection grows as a body shrinks
    //   (laminar: h grows as (dT / L)^(1/4)), the game's coefficient does not (inferred).
    // Target: a steel block 16 cells wide (22 mm, the size of `redHotBar`'s bar) at 500 °C in still air has an effective
    //   surface coefficient 1.15 to 1.5 times that of `coolingBlock`'s 50-cell block (68 mm) at 500 °C. A ratio, not a
    //   window on the coefficient: a factor of 2 on 13.3 W/m²·K (6.6 to 26.6) holds the game's size-blind coefficient,
    //   about 9 W/m²·K at both sizes (inferred from `coolingBlock` and the 16x16 block of `tests/air-heat.test.ts`), so it
    //   could not fail.
    // Calculation (estimate): laminar natural convection scales as L^(-1/4) at one temperature difference, (50 / 16)^(1/4)
    //   = 1.33; Churchill and Chu's correlation for a horizontal cylinder in air at these Rayleigh numbers (about 3e4 and
    //   1e6, air at a film temperature of 260 °C) gives 1.25. Tolerance: about 0.15 around both. The game today gives
    //   1.0 (inferred) and misses.
    // Source: Incropera et al., Fundamentals of Heat and Mass Transfer (natural convection by size; Churchill and Chu 1975).
    // Measure: the effective surface coefficient of each block from the cooling of its mean temperature, as `coolingBlock`
    //   reads it, at emissivity 0 once radiation exists (backlog I26): radiation does not grow as a body shrinks.
    // Needs: nothing new; the first scenario file that has room builds it, waiting for a size-dependent air exchange.
    it.todo('coolingBlock (second size): a steel block 16 cells wide at 500 °C loses heat per unit of surface 1.15 to 1.5 times as fast as the 50-cell block in still air (laminar natural convection: 1.25 to 1.33)');
  });
});
