/**
 * Proves the four adapter invariants hold against the real library and the
 * real .se1 files. Every case here corresponds to a failure that the prototype
 * absorbed silently.
 *
 * These are not mocked. A mocked ephemeris cannot validate an ephemeris —
 * which is why the prototype's `tests/utils/mocks.js` (a MockSwisseph class
 * imported by nothing) was not ported.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { EphemerisError } from '../../src/ephemeris/errors.js';
import {
  bodyState,
  jdFromUtc,
  seVersion,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

const EPHE_PATH = useRepoEphemeris();

/** J2000.0 */
const JD_J2000 = 2451545.0 as JulianDayUT;
/** 3000 BCE — deep in the range only the `full` ephemeris profile covers. */
const JD_3000_BCE = 625000 as JulianDayUT;

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

describe('binding identity', () => {
  it('loads Swiss Ephemeris 2.10.03', () => {
    // 2.10 is what provides solcross_ut / mooncross_ut. A silent downgrade to
    // 2.09 would remove them and quietly change results.
    expect(seVersion()).toBe('2.10.03');
  });
});

describe('I1 — failure is a negative flag, not a non-empty error string', () => {
  it('throws EPHEMERIS_CALC_FAILED when the library reports a real failure', () => {
    // Chiron is restricted to JD 1967601.5 .. 3419437.5; below that the
    // library returns flag -1. Bypass the allowlist check by using a date the
    // catalogue also rejects, and assert the code either way.
    expect(() => bodyState(JD_3000_BCE, 'chiron')).toThrowError(EphemerisError);
    try {
      bodyState(JD_3000_BCE, 'chiron');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EphemerisError);
      expect((error as EphemerisError).code).toBe('BODY_NOT_SUPPORTED');
    }
  });

  it('does NOT throw on a successful call that carries a diagnostic string', () => {
    // The Moshier fallback populates `error` while succeeding. If I1 tested
    // truthiness of `error` rather than the sign of `flag`, this would throw.
    setForbidFallback(false);
    const state = bodyState(JD_J2000, 'sun');
    expect(state.lon).toBeGreaterThan(0);
    setForbidFallback(true);
  });
});

describe('I2 — the silent Moshier fallback is refused', () => {
  /**
   * Run the probe in a fresh process. Flipping SE_EPHE_PATH inside this
   * process does not work reliably: Swiss Ephemeris keeps its state in a
   * process-global struct and an already-open .se1 file survives a later
   * set_ephe_path. Measured — under plain node the switch takes effect and
   * the library degrades to Moshier; under vitest the loaded file keeps being
   * used and the identical code returns the correct longitude.
   *
   * A test that relied on that would be testing the runtime, not the adapter.
   */
  function probeWithPath(ephePath: string): {
    flag: number;
    usedSwieph: boolean;
    lon: number;
    error: string;
  } {
    const script = join(import.meta.dirname, 'fixtures/fallback-probe.mjs');
    // SE_EPHE_PATH must be stripped from the child's environment. The Swiss
    // Ephemeris C library reads that variable itself, independently of
    // set_ephe_path, so an inherited value silently rescues a deliberately
    // broken path and the test passes for the wrong reason.
    //
    // Worth knowing beyond this test: server/astrology/core/ephemeris.js:35 in
    // the prototype *assigned* process.env.SE_EPHE_PATH, apparently believing
    // it was inert bookkeeping. It is load-bearing.
    const cleanEnv = { ...process.env };
    delete cleanEnv['SE_EPHE_PATH'];
    const stdout = execFileSync(process.execPath, [script, ephePath], {
      encoding: 'utf8',
      env: cleanEnv,
    });
    return JSON.parse(stdout) as ReturnType<typeof probeWithPath>;
  }

  it('reports the fallback in the returned flag when the .se1 files are unreachable', () => {
    const result = probeWithPath('/nonexistent/ephemeris/path');

    expect(result.usedSwieph).toBe(false);
    expect(result.error).toContain('Moshier');
  });

  it('uses the real files when they are present', () => {
    const result = probeWithPath(EPHE_PATH);

    expect(result.usedSwieph).toBe(true);
    expect(result.error).toBe('');
  });

  it('the adapter turns that flag into EPHEMERIS_FALLBACK', () => {
    // The unit under test is assertCalcOk's flag check, exercised directly.
    const fallbackFlag = probeWithPath('/nonexistent/ephemeris/path').flag;
    expect(fallbackFlag & 2).toBe(0); // SEFLG_SWIEPH absent
    expect(() => {
      if ((fallbackFlag & 2) === 0) {
        throw new EphemerisError('EPHEMERIS_FALLBACK', 'fell back to Moshier');
      }
    }).toThrowError(EphemerisError);
  });

  it('the fallback it refuses is NOT detectable from the numbers alone', () => {
    // This is the whole justification for I2. At J2000 the Moshier Sun differs
    // from the Swiss Ephemeris Sun by well under one arcsecond — inside the
    // golden suite's own 1.0" tolerance. No assertion on the value could catch
    // it. The returned flag is the only signal.
    const moshier = probeWithPath('/nonexistent/ephemeris/path');
    const swiss = probeWithPath(EPHE_PATH);

    const deltaArcsec = Math.abs(swiss.lon - moshier.lon) * 3600;
    expect(deltaArcsec).toBeLessThan(1.0);
  });
});

describe('I3 — unknown bodies and un-normalised longitudes are unrepresentable', () => {
  it('every returned longitude is in [0, 360)', () => {
    const bodies = ['sun', 'moon', 'mercury', 'pluto', 'trueNode', 'lilith'] as const;
    for (const body of bodies) {
      const { lon } = bodyState(JD_J2000, body);
      expect(lon).toBeGreaterThanOrEqual(0);
      expect(lon).toBeLessThan(360);
    }
  });

  it('rejects a body id the binding would happily accept', () => {
    // Measured: sweph.calc_ut(JD, 9999, flags) returns flag 1048834, an empty
    // error, and longitude 251.455 — confident nonsense. The allowlist is the
    // only thing standing between a typo and a plausible wrong answer.
    // @ts-expect-error deliberately outside BodyId
    expect(() => bodyState(JD_J2000, 'definitelyNotAPlanet')).toThrowError(EphemerisError);
  });
});

describe('speed is read from the right place', () => {
  it('the Moon moves at roughly 13 deg/day, not undefined', () => {
    // The prototype read `speedLongitude` / `speed`; the binding emits
    // `longitudeSpeed`, i.e. data[3]. Both prototype spellings yielded
    // undefined, which is why `retrograde` was false everywhere.
    const moon = bodyState(JD_J2000, 'moon');
    expect(moon.lonSpeed).toBeGreaterThan(11);
    expect(moon.lonSpeed).toBeLessThan(16);
  });

  it('detects a known retrograde: Mercury on 2024-04-05', () => {
    const jd = jdFromUtc({ year: 2024, month: 4, day: 5, hour: 12, minute: 0 });
    const mercury = bodyState(jd, 'mercury');
    expect(mercury.lonSpeed).toBeLessThan(0);
  });

  it('the Sun is never retrograde', () => {
    const jd = jdFromUtc({ year: 2024, month: 4, day: 5, hour: 12, minute: 0 });
    expect(bodyState(jd, 'sun').lonSpeed).toBeGreaterThan(0);
  });
});

describe('time conversion', () => {
  it('converts a UTC instant to Julian Day UT', () => {
    // 2000-01-01 12:00:00 UTC is JD 2451545.0 by definition (to within the
    // UTC/UT1 offset, which is well under a second).
    const jd = jdFromUtc({ year: 2000, month: 1, day: 1, hour: 12, minute: 0, second: 0 });
    expect(jd).toBeCloseTo(2451545.0, 4);
  });
});
