/**
 * The single source of angular arithmetic in this codebase.
 *
 * The prototype had four hand-written copies of this maths (aspects.js:61-75,
 * natal-aspects.js:78-87, themes.js:321-330, full-transit-calculator.js:81-99),
 * one of which contained an unreachable branch. It also had a `degreesToSign`
 * that never normalised its input, so a longitude of exactly 360 produced
 * `SIGNS[12]` — undefined. Both classes of bug are structural, not careless:
 * they follow from letting every caller re-derive the same thing.
 *
 * Nothing outside this module may use `% 360`. An ESLint rule enforces it.
 */

/** A longitude in [0, 360). The brand makes an un-normalised value unrepresentable. */
export type Longitude = number & { readonly __brand: 'Longitude' };

/**
 * Normalise any real angle into [0, 360). Handles negatives and values >= 360.
 *
 * The final guard is not defensive padding. For a tiny negative input such as
 * -1e-15, `wrapped + 360` rounds to exactly 360 in IEEE-754 — the interval the
 * `Longitude` brand promises is half-open, and without this the function could
 * return its own excluded upper bound. Found by a composite-body test on a
 * group straddling 0 Aries, where the circular mean lands a hair below zero.
 */
export function wrap360(degrees: number): Longitude {
  // This is the one permitted `% 360` in the codebase. The lint rule exists to
  // route every other caller here rather than re-deriving it.
  // eslint-disable-next-line no-restricted-syntax
  const wrapped = degrees % 360;
  const normalised = wrapped < 0 ? wrapped + 360 : wrapped;
  // `+ 0` collapses -0 to +0. `-360 % 360` is -0 in JavaScript, and -0 is
  // distinguishable from 0 by Object.is — enough to change a content hash or
  // an equality check for a value that is arithmetically the same.
  return (normalised >= 360 ? 0 : normalised + 0) as Longitude;
}

/**
 * Normalise into (-180, 180].
 *
 * This is the function the transit engine is built on: unlike an unsigned
 * distance, it changes sign as a body passes through an exact contact, which
 * is what makes root-finding possible.
 */
export function wrap180(degrees: number): number {
  const wrapped = wrap360(degrees);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** Shortest unsigned angular distance between two longitudes, in [0, 180]. */
export function separation(a: number, b: number): number {
  return Math.abs(wrap180(a - b));
}

/**
 * Signed separation from an exact aspect contact, in (-180, 180].
 *
 * Zero exactly at the contact. `side` selects which of the two geometrically
 * distinct contacts of a non-symmetric aspect is meant: for a square, the
 * transiting body at natal+90 and at natal-90 are different events. The
 * prototype's `Math.abs(diff - 90)` could not tell them apart and merged them.
 *
 * Conjunction (0) and opposition (180) are symmetric and have one side only.
 */
export function signedSeparation(
  transiting: number,
  natal: number,
  aspectAngle: number,
  side: 1 | -1,
): number {
  return wrap180(transiting - natal - side * aspectAngle);
}

/** Zodiac sign index 0..11 (0 = Aries). Total by construction — no undefined. */
export function signIndex(longitude: number): number {
  return Math.floor(wrap360(longitude) / 30);
}

/** Degrees within the sign, in [0, 30). */
export function degreesInSign(longitude: number): number {
  return wrap360(longitude) % 30;
}
