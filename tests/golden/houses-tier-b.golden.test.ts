/**
 * Tier B: house cusps against `swetest`, plus a genuinely independent check on
 * the angles.
 *
 * The two halves of this file have different strength, and conflating them
 * would be self-deception:
 *
 *   The cusp comparison is INTEGRATION verification. `swetest` is built from
 *   the same C source `sweph` binds, so it cannot catch an error inside Swiss
 *   Ephemeris — it would make the same one. What it catches is everything
 *   between the library and our response: a misread `points[]` index, the
 *   wrong system letter reaching the binding, a dropped normalisation.
 *
 *   The Ascendant/MC comparison is ASTRONOMY verification. Both have closed
 *   forms in ARMC and the obliquity, and computing them from spherical
 *   trigonometry here does not touch Swiss Ephemeris's house code at all.
 *
 * JPL Horizons publishes nothing comparable for house cusps, which is why
 * Tier A cannot cover them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  housesFor,
  setEphemerisPath,
  setForbidFallback,
  trueObliquity,
  type HouseSystem,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import { wrap360 } from '../../src/math/angle.js';
import { TOLERANCE_ARCSEC } from './matchers.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

interface SwetestFixture {
  provider: string;
  seVersion: string;
  charts: {
    id: string;
    note: string;
    civilUtc: string;
    /** The canonical instant both sides refer to. */
    jdUt: number;
    swetestUt: string;
    geo: { lat: number; lon: number };
    systems: Record<string, number[]>;
  }[];
}

const EPHE_PATH = useRepoEphemeris();

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/swetest-houses.json'), 'utf8'),
) as SwetestFixture;

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

describe('the fixture is present and complete', () => {
  // Without this, an emptied fixture would make every generated test below
  // simply not exist, and the suite would go green having checked nothing.
  it('describes five charts from swetest 2.10.03', () => {
    expect(fixture.provider).toBe('swetest');
    expect(fixture.seVersion).toBe('2.10.03');
    expect(fixture.charts).toHaveLength(5);

    let cuspCount = 0;
    for (const chart of fixture.charts) {
      const systems = Object.values(chart.systems);
      expect(systems.length).toBeGreaterThan(0);
      for (const cusps of systems) {
        expect(cusps).toHaveLength(12);
        cuspCount += cusps.length;
      }
    }
    expect(cuspCount).toBeGreaterThanOrEqual(240);
  });
});

describe('cusps match swetest', () => {
  for (const chart of fixture.charts) {
    describe(`${chart.id} — ${chart.note}`, () => {
      for (const [system, expected] of Object.entries(chart.systems)) {
        it(`${system}: all twelve cusps within ${String(TOLERANCE_ARCSEC.houseCusp)}"`, () => {
          const jd = chart.jdUt as JulianDayUT;
          const actual = housesFor(jd, chart.geo.lat, chart.geo.lon, system as HouseSystem);

          for (let i = 0; i < 12; i += 1) {
            const reference = expected[i];
            const computed = actual.cusps[i];
            if (reference === undefined || computed === undefined) {
              expect.unreachable(`cusp ${String(i + 1)} missing`);
              return;
            }
            expect(computed).toBeWithinArcsec(reference, TOLERANCE_ARCSEC.houseCusp);
          }
        });
      }
    });
  }
});

describe('the angles reproduce from closed-form trigonometry', () => {
  /**
   * Ascendant and MC derived from ARMC and the true obliquity alone.
   *
   * This is the part of the file that could actually catch Swiss Ephemeris
   * being wrong, rather than catching us wiring it up wrong. Measured on the
   * Rome 1987 chart, both agree to 0.000000 arcseconds.
   */
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  function analyticMc(armc: number, obliquity: number): number {
    return wrap360(
      Math.atan2(Math.sin(armc * DEG), Math.cos(armc * DEG) * Math.cos(obliquity * DEG)) * RAD,
    );
  }

  function analyticAscendant(armc: number, obliquity: number, latitude: number): number {
    return wrap360(
      Math.atan2(
        Math.cos(armc * DEG),
        -(
          Math.sin(armc * DEG) * Math.cos(obliquity * DEG) +
          Math.tan(latitude * DEG) * Math.sin(obliquity * DEG)
        ),
      ) * RAD,
    );
  }

  for (const chart of fixture.charts) {
    it(`${chart.id}: Ascendant and MC agree with spherical trigonometry`, () => {
      const jd = chart.jdUt as JulianDayUT;
      const houses = housesFor(jd, chart.geo.lat, chart.geo.lon, 'W');

      const obliquity = trueObliquity(jd);

      expect(houses.midheaven).toBeWithinArcsec(analyticMc(houses.armc, obliquity), 0.01);
      expect(houses.ascendant).toBeWithinArcsec(
        analyticAscendant(houses.armc, obliquity, chart.geo.lat),
        0.01,
      );
    });
  }
});

describe('system-specific structure', () => {
  /**
   * "Cusp 1 is the Ascendant" holds for the quadrant systems and for nothing
   * else. Asserting the relationships rather than literal degrees keeps this
   * test meaningful when the fixture is regenerated — an earlier version
   * hardcoded the numbers and broke the moment the canonical instant was
   * corrected for UT1, which told us nothing about the code.
   */
  it('anchors cusp 1 differently per system family', () => {
    const rome = fixture.charts.find((chart) => chart.id === 'rome-1987');
    if (rome === undefined) {
      expect.unreachable('the Rome fixture is missing');
      return;
    }

    const jd = rome.jdUt as JulianDayUT;
    const { ascendant } = housesFor(jd, rome.geo.lat, rome.geo.lon, 'P');

    // Quadrant systems: cusp 1 IS the Ascendant.
    for (const system of ['P', 'K', 'O', 'R', 'C', 'T', 'B'] as const) {
      const cusps = rome.systems[system];
      expect(cusps?.[0]).toBeWithinArcsec(ascendant, TOLERANCE_ARCSEC.houseCusp);
    }

    // Whole Sign: the start of the Ascendant's sign, so a multiple of 30.
    const wholeSign = rome.systems['W'];
    expect(wholeSign?.[0]).toBe(Math.floor(ascendant / 30) * 30);

    // Morinus is anchored on the ARMC, not the Ascendant, and lands elsewhere.
    const morinus = rome.systems['M'];
    if (morinus?.[0] === undefined) {
      expect.unreachable('Morinus cusps missing');
      return;
    }
    expect(Math.abs(morinus[0] - ascendant) * 3600).toBeGreaterThan(60);
  });
});
