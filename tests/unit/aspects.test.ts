/**
 * Aspect detection, and the applying/separating calculation the prototype got
 * wrong twice.
 */

import { describe, expect, it } from 'vitest';

import { aspectBetween, aspectsAmong, type AspectPoint } from '../../src/domain/aspects.js';
import { ORB_POLICIES } from '../../src/domain/orb-policy.js';

const NATAL = ORB_POLICIES['natal.default'];

function at(id: string, lon: number, lonSpeed?: number): AspectPoint {
  return lonSpeed === undefined ? { id, lon } : { id, lon, lonSpeed };
}

describe('detection', () => {
  it('finds an exact conjunction', () => {
    const aspect = aspectBetween(at('a', 100), at('b', 100), NATAL);
    expect(aspect?.aspect).toBe('conjunction');
    expect(aspect?.orb).toBe(0);
  });

  it('finds an opposition across the 0/360 boundary', () => {
    // 350 and 170 are exactly opposite. A comparison that does not wrap sees
    // 180 degrees of raw difference and gets the right answer by luck; 355 and
    // 175 would too. This pair is here so the wrap is exercised deliberately.
    const aspect = aspectBetween(at('a', 350), at('b', 170), NATAL);
    expect(aspect?.aspect).toBe('opposition');
    expect(aspect?.orb).toBeCloseTo(0, 9);
  });

  it('finds the sextile the prototype could not', () => {
    // The prototype had no sextile in any of its five orb tables, even though
    // full-transit-calculator.js:34 defined a 60-degree angle.
    const aspect = aspectBetween(at('a', 10), at('b', 70), NATAL);
    expect(aspect?.aspect).toBe('sextile');
  });

  it('does not find a sextile under the legacy policy', () => {
    const aspect = aspectBetween(at('a', 10), at('b', 70), ORB_POLICIES['natal.v1']);
    expect(aspect).toBeUndefined();
  });

  it('returns nothing when no aspect is within orb', () => {
    // 25 degrees apart: past the 10-degree conjunction orb, short of the
    // 30-degree semisextile, which this policy does not include anyway.
    expect(aspectBetween(at('a', 0), at('b', 25), NATAL)).toBeUndefined();
  });

  it('prefers the tighter of two candidates', () => {
    // 61 degrees: 1 off a sextile, 29 off a conjunction. Both would be
    // rejected by the conjunction orb, so make it explicit with a policy where
    // both genuinely fit.
    const wide = { conjunction: 70, sextile: 5 } as const;
    const aspect = aspectBetween(at('a', 0), at('b', 61), wide);
    expect(aspect?.aspect).toBe('sextile');
    expect(aspect?.orb).toBeCloseTo(1, 9);
  });

  it('respects a policy that omits an aspect entirely', () => {
    // layer1.cyclic deliberately has no trine: a body returning to its own
    // natal position is tracked at conjunction, opposition and square only.
    const aspect = aspectBetween(at('a', 0), at('b', 120), ORB_POLICIES['layer1.cyclic']);
    expect(aspect).toBeUndefined();
  });
});

describe('applying and separating', () => {
  /**
   * The reference case, worked through in the module doc.
   *
   * Sun at 10 deg moving 0.99/day; Moon at 5 deg moving 13.2/day. The Moon is
   * closing from behind, so the conjunction is applying. Numerically the
   * separation runs 5.00 -> 3.78 -> 0.006 over 0.41 days before the Moon
   * overtakes.
   */
  it('reports applying when a faster body closes from behind', () => {
    const aspect = aspectBetween(at('sun', 10, 0.99), at('moon', 5, 13.2), NATAL);
    expect(aspect?.aspect).toBe('conjunction');
    expect(aspect?.applying).toBe(true);
  });

  it('is what the prototype formula got wrong', () => {
    // `(speed1 - speed2) > 0` would answer false for the case above.
    const prototypeAnswer = 0.99 - 13.2 > 0;
    const aspect = aspectBetween(at('sun', 10, 0.99), at('moon', 5, 13.2), NATAL);
    expect(prototypeAnswer).toBe(false);
    expect(aspect?.applying).toBe(true);
  });

  it('reports separating once the faster body has passed', () => {
    const aspect = aspectBetween(at('sun', 10, 0.99), at('moon', 15, 13.2), NATAL);
    expect(aspect?.applying).toBe(false);
  });

  it('agrees with a numerically differentiated separation', () => {
    // Independent check: step forward by a small fraction of a day and see
    // whether the separation actually shrank. The step must be small — the
    // prototype used a whole day, over which the Moon moves 13 degrees and
    // can pass through the contact entirely.
    const dt = 1e-4;
    const cases: [number, number, number, number][] = [
      [10, 0.99, 5, 13.2],
      [10, 0.99, 15, 13.2],
      [200, 0.05, 82, -0.1],
      [45, 1.2, 133, 0.4],
    ];

    for (const [lonA, speedA, lonB, speedB] of cases) {
      const aspect = aspectBetween(at('a', lonA, speedA), at('b', lonB, speedB), NATAL);
      if (aspect === undefined) continue;

      const sepNow = aspect.separation;
      const after = aspectBetween(
        at('a', lonA + speedA * dt, speedA),
        at('b', lonB + speedB * dt, speedB),
        NATAL,
      );
      const orbNow = aspect.orb;
      const orbAfter = after?.orb ?? Infinity;

      expect(aspect.applying).toBe(orbAfter < orbNow);
      expect(sepNow).toBeGreaterThanOrEqual(0);
    }
  });

  it('omits applying when a point has no speed, rather than reporting null', () => {
    // The angles have no meaningful longitude speed. The prototype set theirs
    // to 0 and then guarded on `speed !== 0`, so every aspect involving an
    // angle silently produced `applying: null` — indistinguishable from the
    // speed lookup having failed, which is what was actually happening for
    // every body.
    const aspect = aspectBetween(at('ascendant', 100), at('sun', 100, 0.99), NATAL);
    expect(aspect?.aspect).toBe('conjunction');
    expect(aspect).not.toHaveProperty('applying');
  });

  it('omits applying when the two bodies move together', () => {
    const aspect = aspectBetween(at('a', 10, 1.0), at('b', 12, 1.0), NATAL);
    expect(aspect).not.toHaveProperty('applying');
  });
});

describe('pairs', () => {
  const points = [at('sun', 0, 1), at('moon', 120, 13), at('mars', 180, 0.5), at('venus', 60, 1.2)];

  it('considers each unordered pair once', () => {
    const aspects = aspectsAmong(points, NATAL);
    const keys = aspects.map((aspect) => [aspect.a, aspect.b].sort().join(' '));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('honours the exclusion list', () => {
    // The prototype hardcoded exactly one exclusion, Ascendant/Midheaven,
    // because the two are geometrically bound and always in aspect.
    const withPair = aspectsAmong(points, NATAL);
    const without = aspectsAmong(points, NATAL, [['sun', 'moon']]);

    expect(withPair.some((a) => [a.a, a.b].sort().join(' ') === 'moon sun')).toBe(true);
    expect(without.some((a) => [a.a, a.b].sort().join(' ') === 'moon sun')).toBe(false);
    expect(without.length).toBe(withPair.length - 1);
  });
});
