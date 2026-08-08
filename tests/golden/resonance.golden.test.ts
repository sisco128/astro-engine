/**
 * Resonances against the real ephemeris.
 *
 * The claim being tested is the one the whole rewrite rests on: that a transit
 * contact is an interval with an exact instant inside it, not a day that
 * happened to be sampled.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
  bodyState,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import { resonancesFor, scanStepDays } from '../../src/transits/resonance.js';
import { separation } from '../../src/math/angle.js';

const EPHE_PATH = process.env['SE_EPHE_PATH'] ?? join(homedir(), 'Desktop/astro-engine/ephem');

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

describe('scan step adapts to the body', () => {
  it('is coarse for the slow bodies and fine for the fast ones', () => {
    // The prototype used one day for every body: five times finer than
    // Neptune needs, and fifty times too coarse for the Moon.
    const neptune = scanStepDays('neptune', 1);
    const mars = scanStepDays('mars', 1);
    const moon = scanStepDays('moon', 1);

    expect(neptune).toBeGreaterThan(mars);
    expect(mars).toBeGreaterThan(moon);
    // A contact cannot be stepped over: the step must stay under the time the
    // body needs to cross the orb.
    expect(moon).toBeLessThan(2 / 15.4);
  });
});

describe('exact contacts', () => {
  it('places a contact where the separation really is zero', () => {
    const from = jdFromUtc({ year: 2024, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 });

    // Mars against a fixed natal degree, conjunction only.
    const found = resonancesFor({
      body: 'mars',
      member: 'natal',
      natalLon: 100,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['conjunction'],
        tier: 'fast',
      },
    });

    expect(found.length).toBeGreaterThan(0);

    for (const resonance of found) {
      const lon = bodyState(resonance.exactJd as JulianDayUT, 'mars').lon;
      // At the exact contact the separation from the natal degree is zero to
      // within what the root tolerance allows the body to travel.
      expect(separation(lon, 100)).toBeLessThan(0.001);
    }
  });

  it('reports sub-second precision', () => {
    const from = jdFromUtc({ year: 2024, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 });

    const found = resonancesFor({
      body: 'mars',
      member: 'natal',
      natalLon: 100,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['conjunction'],
        tier: 'fast',
      },
    });

    for (const resonance of found) {
      // 1e-6 days is 0.086 seconds. The prototype stopped at one hour.
      expect(resonance.precisionDays).toBeLessThanOrEqual(1e-5);
    }
  });

  it('puts the exact contact inside its own orb window', () => {
    const from = jdFromUtc({ year: 2020, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2030, month: 1, day: 1, hour: 0, minute: 0 });

    const found = resonancesFor({
      body: 'saturn',
      member: 'natal',
      natalLon: 200,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['conjunction', 'square', 'opposition'],
        tier: 'social',
      },
    });

    expect(found.length).toBeGreaterThan(0);
    for (const resonance of found) {
      expect(resonance.exactJd).toBeGreaterThanOrEqual(resonance.enterJd);
      expect(resonance.exactJd).toBeLessThanOrEqual(resonance.exitJd);
      expect(resonance.durationDays).toBeGreaterThan(0);
    }
  });
});

describe('retrograde loops produce several passes over the same degree', () => {
  /**
   * The triple passage. A slow body crosses a degree, turns retrograde back
   * over it, then turns direct and crosses a third time.
   *
   * The prototype could see these only through full-transit-calculator.js,
   * which sampled daily over a fixed +/-3 year window and gated exact-pass
   * detection on a hardcoded `prev.orb < 1.0` regardless of the requested orb.
   */
  it('finds multiple contacts for Neptune on one degree', () => {
    const from = jdFromUtc({ year: 2000, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2012, month: 1, day: 1, hour: 0, minute: 0 });

    // Neptune's position part-way through the window, so it certainly crosses.
    const mid = jdFromUtc({ year: 2006, month: 1, day: 1, hour: 0, minute: 0 });
    const target = bodyState(mid, 'neptune').lon;

    const found = resonancesFor({
      body: 'neptune',
      member: 'natal',
      natalLon: target,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['conjunction'],
        tier: 'slow',
      },
    });

    // Three passes: direct, retrograde, direct.
    expect(found.length).toBeGreaterThanOrEqual(3);

    // Each is a distinct instant, in order.
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]?.exactJd).toBeGreaterThan(found[i - 1]?.exactJd ?? 0);
    }
  });

  it('gives a slow body a window of months, not a flat 30 days', () => {
    const from = jdFromUtc({ year: 2000, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2012, month: 1, day: 1, hour: 0, minute: 0 });
    const mid = jdFromUtc({ year: 2006, month: 1, day: 1, hour: 0, minute: 0 });
    const target = bodyState(mid, 'neptune').lon;

    const found = resonancesFor({
      body: 'neptune',
      member: 'natal',
      natalLon: target,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['conjunction'],
        tier: 'slow',
      },
    });

    // Measured: a Neptune contact within 1 degree lasts around 125 days.
    // The prototype used 30 for every body.
    const longest = Math.max(...found.map((r) => r.durationDays));
    expect(longest).toBeGreaterThan(60);
  });
});

describe('the two contacts of a non-symmetric aspect stay separate', () => {
  it('distinguishes the square at +90 from the square at -90', () => {
    const from = jdFromUtc({ year: 2024, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2027, month: 1, day: 1, hour: 0, minute: 0 });

    const found = resonancesFor({
      body: 'mars',
      member: 'natal',
      natalLon: 100,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['square'],
        tier: 'fast',
      },
    });

    const sides = new Set(found.map((r) => r.side));
    // Both contacts occur as Mars goes round; an unsigned distance — which is
    // what the prototype used — would merge them into one.
    expect(sides.size).toBe(2);

    for (const resonance of found) {
      const lon = bodyState(resonance.exactJd as JulianDayUT, 'mars').lon;
      expect(separation(lon, 100)).toBeCloseTo(90, 2);
    }
  });

  it('does not double-count a symmetric aspect', () => {
    const from = jdFromUtc({ year: 2024, month: 1, day: 1, hour: 0, minute: 0 });
    const to = jdFromUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 });

    const found = resonancesFor({
      body: 'mars',
      member: 'natal',
      natalLon: 100,
      fromJd: from,
      toJd: to,
      options: {
        orbDeg: 1,
        aspects: ['opposition'],
        tier: 'fast',
      },
    });

    // An opposition has one contact, not two. Scanning both sides would
    // report every one of them twice.
    expect(found.every((r) => r.side === 1)).toBe(true);
  });
});
