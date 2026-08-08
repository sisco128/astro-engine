/**
 * Which house a longitude falls in.
 *
 * The prototype's `getPlanetHouse` (chart-calculator.js:11-44) silently
 * returned house 1 whenever its cusp search failed (line 43). A body that
 * could not be placed was therefore indistinguishable from a body genuinely in
 * the first house, and no caller could tell.
 *
 * This version cannot fail: the twelve cusps partition the circle exactly, so
 * every longitude lies in exactly one house by construction. The loop below
 * always terminates with a match — the final `throw` exists only to make that
 * claim checkable rather than assumed.
 */

import { wrap360 } from '../math/angle.js';

/**
 * House number 1..12 for a longitude, given the twelve cusps in order.
 *
 * Houses are unequal in the quadrant systems and any of them may straddle 0
 * degrees Aries, so the containment test is done on arc lengths measured
 * forward from each cusp rather than on raw numeric comparison. A naive
 * `cusp[i] <= lon && lon < cusp[i+1]` fails for whichever house wraps.
 */
export function houseOf(longitude: number, cusps: readonly number[]): number {
  if (cusps.length !== 12) {
    throw new Error(`Expected 12 house cusps, received ${String(cusps.length)}`);
  }

  const lon = wrap360(longitude);

  for (let i = 0; i < 12; i += 1) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    if (start === undefined || end === undefined) {
      throw new Error(`House cusp ${String(i)} is missing`);
    }

    const span = wrap360(end - start);
    const offset = wrap360(lon - start);

    // `offset < span` and not `<=`: a body exactly on a cusp belongs to the
    // house that cusp opens, which the next iteration's offset of 0 gives.
    if (offset < span) {
      return i + 1;
    }
  }

  /* c8 ignore next 4 -- unreachable: twelve forward arcs partition the circle */
  throw new Error(
    `Longitude ${String(lon)} fell outside all twelve houses, which is geometrically impossible. ` +
      `Cusps: ${cusps.join(', ')}`,
  );
}
