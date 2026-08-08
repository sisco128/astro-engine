/**
 * House cusps, and the high-latitude behaviour that the prototype could not
 * see.
 *
 * Reference: the primary regression chart, 12 August 1987, 11:32 CEST, Rome
 * (41.9028 N, 12.4964 E) = 09:32 UT.
 *
 * Note on that chart: the prototype's own regression test
 * (tests/unit/neptune-conjunction-bug.test.js:18) passed the *local* time
 * 11:32 straight into calculateChart as though it were UT. Rome was on CEST
 * that day, so every number that test asserted is two hours wrong — roughly
 * 30 degrees of Ascendant.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { wrap360 } from '../../src/math/angle.js';
import { EphemerisError } from '../../src/ephemeris/errors.js';
import {
  housesFor,
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
  type HouseSystem,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';

const EPHE_PATH = process.env['SE_EPHE_PATH'] ?? join(homedir(), 'Desktop/astro-engine/ephem');

/** 1987-08-12 09:32:00 UT — the local 11:32 CEST converted correctly. */
const ROME_1987: { jd: JulianDayUT; lat: number; lon: number } = {
  jd: 0 as JulianDayUT,
  lat: 41.9028,
  lon: 12.4964,
};

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
  ROME_1987.jd = jdFromUtc({ year: 1987, month: 8, day: 12, hour: 9, minute: 32 });
});

describe('house cusps are internally consistent', () => {
  it('returns twelve cusps, with the first equal to the Ascendant', () => {
    const houses = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'P');

    expect(houses.cusps).toHaveLength(12);
    expect(houses.cusps[0]).toBeWithinArcsec(houses.ascendant, 0.001);
  });

  it('places the MC on the tenth cusp for quadrant systems', () => {
    const houses = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'P');
    expect(houses.cusps[9]).toBeWithinArcsec(houses.midheaven, 0.001);
  });

  it('has opposite cusps exactly 180 degrees apart', () => {
    const { cusps } = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'P');
    expect(cusps).toHaveLength(12);

    for (let i = 0; i < 6; i += 1) {
      const near = cusps[i];
      const far = cusps[i + 6];
      if (near === undefined || far === undefined) {
        expect.unreachable(`cusp ${String(i)} or ${String(i + 6)} missing`);
        return;
      }
      expect(wrap360(far + 180)).toBeWithinArcsec(near, 0.001);
    }
  });

  it('advances monotonically around the circle', () => {
    const { cusps } = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'P');
    expect(cusps).toHaveLength(12);

    let total = 0;
    for (let i = 0; i < 12; i += 1) {
      const from = cusps[i];
      const to = cusps[(i + 1) % 12];
      if (from === undefined || to === undefined) {
        expect.unreachable(`cusp ${String(i)} missing`);
        return;
      }
      const arc = wrap360(to - from);
      expect(arc).toBeGreaterThan(0);
      total += arc;
    }
    // Twelve consecutive forward arcs must close exactly one revolution. A
    // system that went backwards, or repeated a cusp, would not sum to 360.
    expect(total).toBeCloseTo(360, 6);
  });

  it('gives every system the same Ascendant and MC', () => {
    // The angles are a function of time and place alone; only the intermediate
    // cusps depend on the house system. A system that changed the Ascendant
    // would indicate we are reading the wrong element of `points`.
    const systems: HouseSystem[] = ['P', 'K', 'O', 'R', 'C', 'W'];
    const reference = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'P');

    for (const system of systems) {
      const houses = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, system);
      expect(houses.ascendant).toBeWithinArcsec(reference.ascendant, 0.001);
      expect(houses.midheaven).toBeWithinArcsec(reference.midheaven, 0.001);
    }
  });

  it('puts Whole Sign cusps on exact sign boundaries', () => {
    const houses = housesFor(ROME_1987.jd, ROME_1987.lat, ROME_1987.lon, 'W');
    for (const cusp of houses.cusps) {
      expect(wrap360(cusp) - Math.floor(wrap360(cusp) / 30) * 30).toBeCloseTo(0, 9);
    }
  });
});

describe('quadrant systems above the polar circle', () => {
  /**
   * Measured at 1975-06-21, latitude 69.65 (Tromsø):
   *
   *   Placidus    flag -1, cusp 2 = 1.3114
   *   Koch        flag -1, cusp 2 = 1.3114
   *   Porphyry    flag  0, cusp 2 = 1.3114   <- identical
   *   Whole Sign  flag  0, cusp 2 = 330.0000
   *
   * Swiss Ephemeris substitutes Porphyry and signals it *only* through the
   * negative flag. There is no error string. The prototype read neither, so it
   * returned Porphyry cusps labelled Placidus.
   */
  const JD_1975 = 2442584.5 as JulianDayUT;
  const ARCTIC_LAT = 69.65;

  it('refuses Placidus rather than silently returning Porphyry', () => {
    try {
      housesFor(JD_1975, ARCTIC_LAT, 12.4964, 'P');
      expect.unreachable('Placidus is undefined at 69.65 N and must not succeed');
    } catch (error) {
      expect(error).toBeInstanceOf(EphemerisError);
      expect((error as EphemerisError).code).toBe('HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE');
    }
  });

  it('refuses Koch for the same reason', () => {
    expect(() => housesFor(JD_1975, ARCTIC_LAT, 12.4964, 'K')).toThrowError(EphemerisError);
  });

  it('names alternatives that actually work at that latitude', () => {
    try {
      housesFor(JD_1975, ARCTIC_LAT, 12.4964, 'P');
      expect.unreachable('should have thrown');
    } catch (error) {
      const details = (error as EphemerisError).details as {
        suggestedSystems: { system: HouseSystem }[];
      };
      expect(details.suggestedSystems.length).toBeGreaterThan(0);

      // Every suggestion must genuinely succeed here — otherwise the advice is
      // as useless as the failure.
      for (const { system } of details.suggestedSystems) {
        const houses = housesFor(JD_1975, ARCTIC_LAT, 12.4964, system);
        expect(houses.cusps).toHaveLength(12);
      }
    }
  });

  it('still works at a latitude where quadrant systems are defined', () => {
    const houses = housesFor(JD_1975, 59.9139, 10.7522, 'P');
    expect(houses.cusps).toHaveLength(12);
  });
});
