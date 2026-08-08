/**
 * The single source of angular arithmetic. Small, pure, and held to 100%
 * coverage, because every uncovered branch here is a wrong number somewhere
 * downstream.
 */

import { describe, expect, it } from 'vitest';

import {
  degreesInSign,
  separation,
  signedSeparation,
  signIndex,
  wrap180,
  wrap360,
} from '../../src/math/angle.js';

describe('wrap360', () => {
  it('leaves an in-range angle alone', () => {
    expect(wrap360(0)).toBe(0);
    expect(wrap360(123.456)).toBeCloseTo(123.456, 12);
    expect(wrap360(359.999)).toBeCloseTo(359.999, 12);
  });

  it('wraps values at or beyond a full turn', () => {
    expect(wrap360(360)).toBe(0);
    expect(wrap360(361)).toBeCloseTo(1, 12);
    expect(wrap360(720)).toBe(0);
  });

  it('wraps negatives', () => {
    expect(wrap360(-1)).toBeCloseTo(359, 12);
    expect(wrap360(-360)).toBe(0);
    expect(wrap360(-370)).toBeCloseTo(350, 12);
  });

  it('never returns 360 for a tiny negative input', () => {
    // -1e-15 + 360 rounds to exactly 360 in IEEE-754. The result must stay
    // inside the half-open interval the Longitude brand promises. This is the
    // case that produced 360 from a circular mean of bodies at 359 and 1.
    for (const tiny of [-1e-15, -1e-14, -Number.EPSILON, -1e-13]) {
      const result = wrap360(tiny);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(360);
    }
  });

  it('is idempotent', () => {
    for (const value of [0, 45, 359.9999, -0.0001, 1234.5]) {
      expect(wrap360(wrap360(value))).toBeCloseTo(wrap360(value), 12);
    }
  });
});

describe('wrap180', () => {
  it('maps into (-180, 180]', () => {
    expect(wrap180(0)).toBe(0);
    expect(wrap180(90)).toBe(90);
    expect(wrap180(180)).toBe(180);
    expect(wrap180(181)).toBeCloseTo(-179, 12);
    expect(wrap180(270)).toBeCloseTo(-90, 12);
    expect(wrap180(-90)).toBeCloseTo(-90, 12);
  });

  it('changes sign through the contact, which is what root-finding needs', () => {
    expect(wrap180(-0.001)).toBeLessThan(0);
    expect(wrap180(0.001)).toBeGreaterThan(0);
  });
});

describe('separation', () => {
  it('is the shortest arc, never more than 180', () => {
    expect(separation(0, 0)).toBe(0);
    expect(separation(0, 90)).toBe(90);
    expect(separation(0, 270)).toBe(90);
    expect(separation(350, 10)).toBeCloseTo(20, 12);
    expect(separation(10, 350)).toBeCloseTo(20, 12);
  });

  it('is symmetric', () => {
    for (const [a, b] of [
      [12, 300],
      [359.5, 0.5],
      [45, 225],
    ]) {
      expect(separation(a ?? 0, b ?? 0)).toBeCloseTo(separation(b ?? 0, a ?? 0), 12);
    }
  });
});

describe('signedSeparation', () => {
  it('is zero exactly at the contact', () => {
    expect(signedSeparation(100, 100, 0, 1)).toBe(0);
    expect(signedSeparation(190, 100, 90, 1)).toBe(0);
    expect(signedSeparation(10, 100, 90, -1)).toBe(0);
  });

  it('distinguishes the two contacts of a non-symmetric aspect', () => {
    // A square has contacts at natal+90 and natal-90. An unsigned distance
    // cannot tell them apart, which is why the prototype merged them.
    const natal = 100;
    expect(signedSeparation(190, natal, 90, 1)).toBe(0);
    expect(signedSeparation(190, natal, 90, -1)).not.toBe(0);
  });

  it('changes sign as the transiting body passes through', () => {
    const before = signedSeparation(189, 100, 90, 1);
    const after = signedSeparation(191, 100, 90, 1);
    expect(Math.sign(before)).toBe(-1);
    expect(Math.sign(after)).toBe(1);
  });
});

describe('sign helpers', () => {
  it('indexes signs from 0 at Aries', () => {
    expect(signIndex(0)).toBe(0);
    expect(signIndex(29.999)).toBe(0);
    expect(signIndex(30)).toBe(1);
    expect(signIndex(359.999)).toBe(11);
  });

  it('never produces index 12', () => {
    // `degreesToSign` in the prototype (positions.js:9) did not normalise, so
    // a longitude of exactly 360 yielded SIGNS[12] — undefined.
    for (const value of [360, 720, -1e-15, -0.0]) {
      expect(signIndex(value)).toBeGreaterThanOrEqual(0);
      expect(signIndex(value)).toBeLessThanOrEqual(11);
    }
  });

  it('gives degrees within the sign', () => {
    expect(degreesInSign(0)).toBe(0);
    expect(degreesInSign(35)).toBeCloseTo(5, 12);
    expect(degreesInSign(359.5)).toBeCloseTo(29.5, 12);
  });
});
