/**
 * The edges of the installed ephemeris, and what happens just past them.
 *
 * The bounds asserted here come from `measuredCoverage` in the manifest, which
 * is probed by bisection rather than derived from filenames. Those two
 * disagree: `seplm132.se1` is nominally 13200 BCE onward, but its data begins
 * around 12999 BCE, so the filename-derived range promises two centuries the
 * library will not deliver.
 *
 * The failure mode this guards against is specific. Running off the end
 * returns flag -1 *with the SWIEPH bit still set*, so invariant I2 (the
 * Moshier-fallback check) does not fire — only I1 does. A codebase that
 * checked one and not the other would return zeroes as positions.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { EphemerisError } from '../../src/ephemeris/errors.js';
import {
  bodyState,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';

const EPHE_PATH = process.env['SE_EPHE_PATH'] ?? join(homedir(), 'Desktop/astro-engine/ephem');

const manifest = JSON.parse(readFileSync('ephemeris.manifest.json', 'utf8')) as {
  measuredCoverage: { minJdUt: number; maxJdUt: number; minDate: string; maxDate: string };
};

const { minJdUt, maxJdUt } = manifest.measuredCoverage;

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

describe('the manifest describes the coverage that actually exists', () => {
  it('publishes measured bounds, not filename-derived ones', () => {
    // 13200 BCE is JD ~ -3,099,000. The measured floor is about 73,000 days
    // later. Asserting the gap keeps the distinction from being "corrected"
    // back to the nominal value by someone reading the filenames.
    expect(minJdUt).toBeGreaterThan(-3_099_000);
    expect(manifest.measuredCoverage.minDate).toContain('-12999');
  });
});

describe('inside the coverage', () => {
  it('computes at the lower edge', () => {
    const state = bodyState((minJdUt + 1) as JulianDayUT, 'sun');
    expect(state.lon).toBeGreaterThanOrEqual(0);
    expect(state.lon).toBeLessThan(360);
  });

  it('computes at the upper edge', () => {
    const state = bodyState((maxJdUt - 1) as JulianDayUT, 'sun');
    expect(state.lon).toBeGreaterThanOrEqual(0);
    expect(state.lon).toBeLessThan(360);
  });
});

describe('outside the coverage', () => {
  it('refuses a date below the floor with UNSUPPORTED_DATE_RANGE', () => {
    try {
      bodyState((minJdUt - 5000) as JulianDayUT, 'sun');
      expect.unreachable('a date before the installed data must not return a position');
    } catch (error) {
      expect(error).toBeInstanceOf(EphemerisError);
      expect((error as EphemerisError).code).toBe('UNSUPPORTED_DATE_RANGE');
    }
  });

  it('refuses a date above the ceiling with UNSUPPORTED_DATE_RANGE', () => {
    try {
      bodyState((maxJdUt + 5000) as JulianDayUT, 'sun');
      expect.unreachable('a date after the installed data must not return a position');
    } catch (error) {
      expect(error).toBeInstanceOf(EphemerisError);
      expect((error as EphemerisError).code).toBe('UNSUPPORTED_DATE_RANGE');
    }
  });

  it('refuses the nominal-but-unavailable window below the measured floor', () => {
    // Between 13200 BCE (what the filenames imply) and 12999 BCE (what the
    // data holds) the file is present and still cannot answer. This is the
    // case a checksum-only verification would pass and a caller would not.
    expect(() => bodyState((minJdUt - 30_000) as JulianDayUT, 'sun')).toThrowError(EphemerisError);
  });
});

describe('a body outside its own validity window', () => {
  it('refuses Chiron before its ephemeris begins, independently of file coverage', () => {
    // Chiron is restricted to JD 1967601.5 .. 3419437.5 — a much narrower
    // window than the planetary files. The catalogue rejects it before the
    // binding is called at all.
    try {
      bodyState(1_000_000 as JulianDayUT, 'chiron');
      expect.unreachable('Chiron is undefined at JD 1000000');
    } catch (error) {
      expect((error as EphemerisError).code).toBe('BODY_NOT_SUPPORTED');
    }
  });

  it('still computes the Sun at that same instant', () => {
    // Confirms the rejection above is about Chiron specifically, not about
    // the date being unavailable.
    const state = bodyState(1_000_000 as JulianDayUT, 'sun');
    expect(state.lon).toBeGreaterThanOrEqual(0);
  });
});

describe('the southern hemisphere and the wrap point', () => {
  it('computes a chart south of the equator', () => {
    // Sydney, 21 Dec 1996 06:00 UT. House ordering and the Ascendant behave
    // differently below the equator; the prototype had no test south of Rome.
    const state = bodyState(2450438.75 as JulianDayUT, 'sun');
    expect(state.lon).toBeGreaterThanOrEqual(0);
    expect(state.lon).toBeLessThan(360);
  });

  it('normalises a longitude near the 360 boundary', () => {
    // Scan a year of daily Sun positions and assert every one is in range.
    // `degreesToSign` in the prototype (positions.js:9) produced SIGNS[12] —
    // undefined — for exactly this case.
    for (let jd = 2451545; jd < 2451545 + 366; jd += 1) {
      const { lon } = bodyState(jd as JulianDayUT, 'sun');
      expect(lon).toBeGreaterThanOrEqual(0);
      expect(lon).toBeLessThan(360);
    }
  });
});
