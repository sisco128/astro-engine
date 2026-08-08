/**
 * Tier A of the golden suite: Swiss Ephemeris against JPL Horizons.
 *
 * This is the only tier that is genuinely independent. `swetest` shares the
 * Swiss Ephemeris C source, so it would make the same mistake we would — it
 * cannot catch a wrong SEFLG_* combination, a bad data file, or a frame
 * mismatch. Horizons can.
 *
 * Reference data is committed (tests/golden/fixtures/horizons-reference.json)
 * and regenerated deliberately via scripts/fetch-horizons.mjs. CI never
 * fetches it: the suite must not depend on a third party being reachable, and
 * a reference that silently refreshes is not a reference.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  bodyState,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import type { BodyId } from '../../src/ephemeris/bodies.js';
import { TOLERANCE_ARCSEC } from './matchers.js';

interface HorizonsReference {
  provider: string;
  retrieved: string;
  epochs: { jdUt: number; bodies: Record<string, { lon: number; lat: number }> }[];
}

const EPHE_PATH = process.env['SE_EPHE_PATH'] ?? join(homedir(), 'Desktop/astro-engine/ephem');

const reference = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/horizons-reference.json'), 'utf8'),
) as HorizonsReference;

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

describe('Swiss Ephemeris agrees with JPL Horizons', () => {
  // Guard against the fixture being emptied or truncated — an empty epoch list
  // would make every assertion below vacuous, which is exactly how the
  // prototype's suite passed while testing nothing.
  it('has reference data to compare against', () => {
    expect(reference.provider).toBe('jpl-horizons');
    expect(reference.epochs.length).toBeGreaterThanOrEqual(2);
    for (const epoch of reference.epochs) {
      expect(Object.keys(epoch.bodies)).toHaveLength(10);
    }
  });

  for (const epoch of reference.epochs) {
    describe(`JD ${String(epoch.jdUt)} UT`, () => {
      for (const [body, expected] of Object.entries(epoch.bodies)) {
        const tolerance = body === 'moon' ? TOLERANCE_ARCSEC.moon : TOLERANCE_ARCSEC.planet;

        it(`${body} longitude within ${String(tolerance)}"`, () => {
          const actual = bodyState(epoch.jdUt as JulianDayUT, body as BodyId);
          expect(actual.lon).toBeWithinArcsec(expected.lon, tolerance);
        });

        it(`${body} latitude within ${String(TOLERANCE_ARCSEC.latitude)}"`, () => {
          const actual = bodyState(epoch.jdUt as JulianDayUT, body as BodyId);
          expect(actual.lat).toBeWithinArcsec(expected.lat, TOLERANCE_ARCSEC.latitude);
        });
      }
    });
  }
});

describe('the reference frame matches', () => {
  /**
   * A frame mismatch is the failure this whole tier exists to catch, and it is
   * invisible at J2000 because that is where the two frames coincide. If our
   * output were referred to the J2000 ecliptic while Horizons reported the
   * ecliptic of date (or vice versa), the 1987 epoch would be off by roughly
   * 13 years of precession — about 650 arcseconds, or 0.18 degrees.
   *
   * Observed: 0.066" for the Sun. Both sides use the ecliptic of date.
   */
  it('shows no precession offset at the 1987 epoch', () => {
    const epoch = reference.epochs.find((e) => Math.floor(e.jdUt) === 2447019);
    if (epoch === undefined) {
      expect.unreachable('the 1987 reference epoch is missing from the fixture');
      return;
    }
    const expectedSun = epoch.bodies['sun'];
    if (expectedSun === undefined) {
      expect.unreachable('the 1987 epoch has no Sun entry');
      return;
    }

    const actual = bodyState(epoch.jdUt as JulianDayUT, 'sun');
    // One arcsecond is ~650x smaller than the precession offset a frame
    // mismatch would produce, so this assertion genuinely discriminates.
    expect(actual.lon).toBeWithinArcsec(expectedSun.lon, 1.0);
  });
});
