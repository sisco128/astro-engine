/**
 * Daylight-saving edge cases, sub-hour offsets, and the conversion the
 * prototype got wrong in three distinct ways.
 */

import { describe, expect, it } from 'vitest';

import { LocalTimeError, resolveLocalTime } from '../../src/time/local-to-utc.js';

describe('ordinary conversions', () => {
  it('applies CEST for the primary regression chart', () => {
    // 12 Aug 1987, 11:32 in Rome. This is the exact conversion the prototype's
    // own regression test skipped: neptune-conjunction-bug.test.js:18 passed
    // 11:32 into calculateChart as though it were UT, making every number in
    // that test two hours wrong.
    const resolved = resolveLocalTime({
      year: 1987,
      month: 8,
      day: 12,
      hour: 11,
      minute: 32,
      zone: 'Europe/Rome',
    });

    expect(resolved.offset).toBe('+02:00');
    expect(resolved.utc).toBe('1987-08-12T09:32:00Z');
    expect(resolved.hour).toBe(9);
  });

  it('applies standard time outside the DST window', () => {
    const resolved = resolveLocalTime({
      year: 1987,
      month: 1,
      day: 15,
      hour: 11,
      minute: 32,
      zone: 'Europe/Rome',
    });

    expect(resolved.offset).toBe('+01:00');
    expect(resolved.utc).toBe('1987-01-15T10:32:00Z');
  });
});

describe('sub-hour offsets', () => {
  /**
   * The prototype searched 29 *integer* hour offsets, so these zones were not
   * merely inaccurate — they were unrepresentable.
   */
  it('handles India at +05:30', () => {
    const resolved = resolveLocalTime({
      year: 1985,
      month: 6,
      day: 15,
      hour: 8,
      minute: 0,
      zone: 'Asia/Kolkata',
    });

    expect(resolved.offset).toBe('+05:30');
    expect(resolved.utc).toBe('1985-06-15T02:30:00Z');
  });

  it('handles Nepal at +05:45', () => {
    const resolved = resolveLocalTime({
      year: 1990,
      month: 3,
      day: 10,
      hour: 10,
      minute: 0,
      zone: 'Asia/Kathmandu',
    });

    expect(resolved.offset).toBe('+05:45');
    expect(resolved.utc).toBe('1990-03-10T04:15:00Z');
  });

  it('handles the Chatham Islands at +12:45', () => {
    const resolved = resolveLocalTime({
      year: 2000,
      month: 6,
      day: 1,
      hour: 12,
      minute: 0,
      zone: 'Pacific/Chatham',
    });

    expect(resolved.offset).toBe('+12:45');
  });
});

describe('spring forward — the time never existed', () => {
  /**
   * US daylight saving in 1978 began on the LAST Sunday in April, 30 April —
   * not 2 April, which the original plan named. Verified: 1978-04-02 02:30 in
   * New York resolves normally at -05:00, while 1978-04-30 02:30 does not
   * exist. A fixture built on the wrong date would have tested nothing.
   */
  it('rejects 02:30 on 30 April 1978 in New York', () => {
    try {
      resolveLocalTime({
        year: 1978,
        month: 4,
        day: 30,
        hour: 2,
        minute: 30,
        zone: 'America/New_York',
      });
      expect.unreachable('02:30 did not exist that night');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalTimeError);
      expect((error as LocalTimeError).code).toBe('NONEXISTENT_LOCAL_TIME');
      expect((error as LocalTimeError).details['gap']).toBeDefined();
    }
  });

  it('rejects 02:30 on 10 March 2024 in New York', () => {
    expect(() =>
      resolveLocalTime({
        year: 2024,
        month: 3,
        day: 10,
        hour: 2,
        minute: 30,
        zone: 'America/New_York',
      }),
    ).toThrowError(LocalTimeError);
  });

  it('accepts 02:30 on 2 April 1978, which was NOT a transition', () => {
    // Guards the guard: if this threw, the gap detection would be firing on
    // ordinary nights and the rejection above would prove nothing.
    const resolved = resolveLocalTime({
      year: 1978,
      month: 4,
      day: 2,
      hour: 2,
      minute: 30,
      zone: 'America/New_York',
    });

    expect(resolved.offset).toBe('-05:00');
  });
});

describe('fall back — the time happened twice', () => {
  it('reports both candidates for 01:30 on 29 October 1978 in New York', () => {
    try {
      resolveLocalTime({
        year: 1978,
        month: 10,
        day: 29,
        hour: 1,
        minute: 30,
        zone: 'America/New_York',
      });
      expect.unreachable('01:30 occurred twice that night');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalTimeError);
      expect((error as LocalTimeError).code).toBe('AMBIGUOUS_LOCAL_TIME');

      const candidates = (error as LocalTimeError).details['candidates'] as {
        utc: string;
        offset: string;
      }[];

      // Two distinct instants, one hour apart, at the two different offsets.
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.offset).toBe('-04:00');
      expect(candidates[1]?.offset).toBe('-05:00');
      expect(candidates[0]?.utc).not.toBe(candidates[1]?.utc);
    }
  });
});

describe('the lenient mode, for a time the engine invented', () => {
  /**
   * `disambiguation: 'compatible'` exists for one caller: the assumed 03:00 of
   * an unknown birth time. Rejecting there would ask the caller to resolve a
   * 60-minute ambiguity inside a 24-hour one the response has already
   * declared, and they have nothing to answer with — the hour is not theirs.
   * A real birth time keeps the strict behaviour, which the suites above hold
   * in place.
   */

  it('resolves a gap forward instead of throwing', () => {
    const resolved = resolveLocalTime(
      { year: 2024, month: 3, day: 10, hour: 2, minute: 30, zone: 'America/New_York' },
      { disambiguation: 'compatible' },
    );

    // The clock jumped 02:00 to 03:00, so Temporal's compatible rule pushes
    // the wall time forward by the shift: 03:30 EDT, which is 07:30 UT.
    expect(resolved.offset).toBe('-04:00');
    expect(resolved.utc).toBe('2024-03-10T07:30:00Z');
  });

  it('takes the earlier of a fold instead of returning both', () => {
    const resolved = resolveLocalTime(
      { year: 1978, month: 10, day: 29, hour: 1, minute: 30, zone: 'America/New_York' },
      { disambiguation: 'compatible' },
    );

    // The first 01:30, still on daylight time.
    expect(resolved.offset).toBe('-04:00');
    expect(resolved.utc).toBe('1978-10-29T05:30:00Z');
  });

  it('changes nothing on an ordinary night', () => {
    const strict = resolveLocalTime({
      year: 1987,
      month: 8,
      day: 12,
      hour: 3,
      minute: 0,
      zone: 'Europe/Rome',
    });
    const lenient = resolveLocalTime(
      { year: 1987, month: 8, day: 12, hour: 3, minute: 0, zone: 'Europe/Rome' },
      { disambiguation: 'compatible' },
    );

    expect(lenient).toEqual(strict);
  });
});

describe('invalid input', () => {
  it('rejects an unknown time zone', () => {
    try {
      resolveLocalTime({
        year: 2000,
        month: 1,
        day: 1,
        hour: 12,
        minute: 0,
        zone: 'Middle_Earth/Shire',
      });
      expect.unreachable('should have rejected the zone');
    } catch (error) {
      expect(error).toBeInstanceOf(LocalTimeError);
      expect((error as LocalTimeError).code).toBe('INVALID_TIME_ZONE');
    }
  });
});
