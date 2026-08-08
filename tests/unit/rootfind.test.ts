/**
 * Root finding, checked against functions whose roots are known analytically —
 * so a failure means the solver is wrong, not the ephemeris.
 */

import { describe, expect, it } from 'vitest';

import { BracketError, brentRoot } from '../../src/math/rootfind.js';

describe('convergence', () => {
  const cases: [string, (x: number) => number, number, number, number][] = [
    ['linear', (x) => x - 0.5, 0, 1, 0.5],
    ['quadratic', (x) => x * x - 2, 0, 2, Math.SQRT2],
    ['cubic', (x) => x * x * x - x - 2, 1, 2, 1.5213797068045676],
    ['sine', (x) => Math.sin(x), 3, 4, Math.PI],
    ['exponential', (x) => Math.exp(x) - 5, 0, 3, Math.log(5)],
    // Flat near the root: the case that defeats a naive secant method.
    ['flat cubic', (x) => Math.pow(x - 0.3, 3), 0, 1, 0.3],
  ];

  for (const [name, f, a, b, expected] of cases) {
    it(`finds the root of a ${name}`, () => {
      const result = brentRoot(f, a, b, { tolerance: 1e-10 });
      expect(result.x).toBeCloseTo(expected, 8);
    });
  }

  it('costs a handful of evaluations, not dozens', () => {
    // Ephemeris calls are the cost, so this is the number that matters.
    // Measured at a 1e-6 day tolerance (0.086 seconds): linear 3, x^2-2 8,
    // sine 6, exp 10. The prototype spent 15 bisection steps plus a
    // 40-evaluation ternary search and still stopped at one hour.
    expect(brentRoot((x) => x - 0.5, 0, 1, { tolerance: 1e-6 }).evaluations).toBeLessThanOrEqual(4);
    expect(brentRoot((x) => x * x - 2, 0, 2, { tolerance: 1e-6 }).evaluations).toBeLessThanOrEqual(
      10,
    );
    expect(
      brentRoot((x) => Math.sin(x), 3, 4, { tolerance: 1e-6 }).evaluations,
    ).toBeLessThanOrEqual(8);
  });

  it('degrades to bisection rate on a triple root, and says so', () => {
    // (x - 0.3)^3 is flat across a wide neighbourhood of its root, so there
    // is no curvature for interpolation to exploit. 36 evaluations is the
    // honest cost; a method claiming better here would be lying.
    const result = brentRoot((x) => Math.pow(x - 0.3, 3), 0, 1, { tolerance: 1e-6 });
    expect(result.x).toBeCloseTo(0.3, 5);
    expect(result.evaluations).toBeLessThan(45);
  });

  it('stops immediately when a step lands exactly on the root', () => {
    // Not an edge case here: a body approaching an aspect at constant speed
    // is linear, so the first secant step hits the contact exactly. Without
    // an early return the bracket stops shrinking — one endpoint never moves
    // — and the search burns evaluations re-deriving the answer it has.
    const result = brentRoot((x) => x - 0.5, 0, 1, { tolerance: 1e-6 });
    expect(result.x).toBe(0.5);
    expect(result.precision).toBe(0);
  });

  it('reports the precision it actually achieved', () => {
    const result = brentRoot((x) => x - 0.5, 0, 1, { tolerance: 1e-6 });
    expect(result.precision).toBeLessThanOrEqual(1e-6);
  });

  it('returns an endpoint immediately when it is the root', () => {
    expect(brentRoot((x) => x, 0, 1).x).toBe(0);
    expect(brentRoot((x) => x - 1, 0, 1).x).toBe(1);
  });
});

describe('bracketing', () => {
  it('refuses a bracket that does not contain a sign change', () => {
    expect(() => brentRoot((x) => x * x + 1, 0, 1)).toThrowError(BracketError);
  });

  it('works with the bracket given in either order', () => {
    const forwards = brentRoot((x) => x - 0.5, 0, 1, { tolerance: 1e-10 });
    const backwards = brentRoot((x) => x - 0.5, 1, 0, { tolerance: 1e-10 });
    expect(forwards.x).toBeCloseTo(backwards.x, 9);
  });
});

describe('the shape the transit engine needs', () => {
  /**
   * Signed separation through an exact aspect contact. This is the function
   * the whole transit engine is built on, and the reason it works: it changes
   * sign, so a root exists to be bracketed.
   *
   * The prototype minimised an UNSIGNED distance instead, which has no sign
   * change — hence its ternary search, and hence its inability to tell the two
   * contacts of a square apart.
   */
  it('finds an exact contact to sub-second precision', () => {
    // A body moving 0.5 deg/day, natal point at 100, square (90 deg).
    // Contact when transitLon - 100 - 90 === 0, i.e. transitLon === 190.
    const speed = 0.5;
    const startLon = 188;
    const f = (days: number): number => startLon + speed * days - 100 - 90;

    const result = brentRoot(f, 0, 10, { tolerance: 1e-6 });

    // 2 degrees to cover at 0.5 deg/day = 4 days.
    expect(result.x).toBeCloseTo(4, 6);
    expect(result.precision).toBeLessThanOrEqual(1e-6);
    // Three evaluations, against roughly 55 for the same job in the prototype.
    expect(result.evaluations).toBeLessThanOrEqual(4);
  });

  it('handles a retrograde loop, where the same contact is crossed twice', () => {
    // Position that rises, turns back, and rises again — the triple-pass
    // shape. Each crossing must be findable from its own bracket.
    const lon = (days: number): number => 188 + 3 * Math.sin(days / 10);
    const f = (days: number): number => lon(days) - 190;

    // First crossing: on the way up.
    const first = brentRoot(f, 0, 10, { tolerance: 1e-8 });
    // Second: on the way back down.
    const second = brentRoot(f, 10, 30, { tolerance: 1e-8 });

    expect(first.x).toBeLessThan(second.x);
    expect(Math.abs(f(first.x))).toBeLessThan(1e-6);
    expect(Math.abs(f(second.x))).toBeLessThan(1e-6);
  });
});
