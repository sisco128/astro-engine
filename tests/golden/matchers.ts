/**
 * Angular assertions for the golden suite.
 *
 * A plain `toBeCloseTo` is wrong for longitudes: 359.9999 and 0.0001 are two
 * arcseconds apart, and any comparison that does not wrap will report them as
 * 360 degrees apart. The prototype's tests never compared a longitude to a
 * reference value at all, so it never hit this — but it also never verified
 * anything.
 */

import { expect } from 'vitest';

import { wrap180 } from '../../src/math/angle.js';

/**
 * Tolerances, in arcseconds, derived from measurement rather than guesswork.
 *
 * Swiss Ephemeris vs JPL Horizons, observed over J2000.0 and 1987-08-12:
 *
 *   planets   max 0.10"   (Saturn 0.097 at J2000)
 *   Moon      max 0.31"   (at 1987-08-12)
 *
 * The values below sit roughly 5x above what is observed — tight enough that a
 * real integration error cannot hide, loose enough to survive a Horizons
 * revision. The original plan proposed 1.0" and 5.0"; at those levels a
 * half-arcsecond regression would pass silently.
 */
export const TOLERANCE_ARCSEC = {
  planet: 0.5,
  moon: 1.0,
  latitude: 1.0,
  /** Same C code on both sides of a swetest comparison; anything larger is an integration bug. */
  houseCusp: 0.5,
} as const;

const ARCSEC_PER_DEGREE = 3600;

expect.extend({
  /**
   * Asserts two longitudes are within `arcsec` of each other, correctly
   * handling the wrap at 0/360.
   */
  toBeWithinArcsec(received: number, expected: number, arcsec: number) {
    if (typeof received !== 'number' || !Number.isFinite(received)) {
      return {
        pass: false,
        message: () => `expected a finite number, received ${String(received)}`,
      };
    }

    const deltaArcsec = Math.abs(wrap180(received - expected)) * ARCSEC_PER_DEGREE;
    const pass = deltaArcsec <= arcsec;

    return {
      pass,
      message: () =>
        pass
          ? `expected ${received.toFixed(9)} NOT to be within ${String(arcsec)}" of ${expected.toFixed(9)} (was ${deltaArcsec.toFixed(4)}")`
          : `expected ${received.toFixed(9)} to be within ${String(arcsec)}" of ${expected.toFixed(9)}, but it was off by ${deltaArcsec.toFixed(4)}"`,
    };
  },
});

// vitest 2 augments `Assertion` / `AsymmetricMatchersContaining`; the
// `Matchers` interface only exists from vitest 3 onwards.
declare module 'vitest' {
  interface Assertion {
    toBeWithinArcsec: (expected: number, arcsec: number) => void;
  }
  interface AsymmetricMatchersContaining {
    toBeWithinArcsec: (expected: number, arcsec: number) => void;
  }
}
