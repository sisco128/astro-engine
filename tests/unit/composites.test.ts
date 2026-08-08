/**
 * Composite body detection, and the two defects the rewrite fixes.
 */

import { describe, expect, it } from 'vitest';

import { identifyComposites, type CompositeInput } from '../../src/domain/composites.js';

const ORB = 10;

function at(id: string, lon: number): CompositeInput {
  return { id, lon };
}

describe('grouping', () => {
  it('leaves isolated bodies alone', () => {
    const result = identifyComposites([at('a', 0), at('b', 100), at('c', 200)], ORB);
    expect(result).toHaveLength(3);
    expect(result.every((body) => body.type === 'single')).toBe(true);
    expect(result.every((body) => body.cohesion === 0)).toBe(true);
  });

  it('fuses a pair inside the orb', () => {
    const result = identifyComposites([at('a', 10), at('b', 14)], ORB);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('conjunction');
    expect(result[0]?.members).toEqual(['a', 'b']);
    expect(result[0]?.cohesion).toBeCloseTo(4, 9);
  });

  it('fuses transitively even when the ends are further apart than the orb', () => {
    // a-b is 8, b-c is 8, a-c is 16 — outside the orb. Standard stellium
    // practice, and the prototype's behaviour, is that all three fuse.
    const result = identifyComposites([at('a', 0), at('b', 8), at('c', 16)], ORB);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('stellium');
    expect(result[0]?.members).toEqual(['a', 'b', 'c']);
  });

  it('keeps a body just outside the orb separate', () => {
    const result = identifyComposites([at('a', 0), at('b', 10.001)], ORB);
    expect(result).toHaveLength(2);
  });
});

describe('cohesion — the defect in the prototype', () => {
  /**
   * The prototype recomputed cohesion only inside the merge branch
   * (themes.js:120). When a conjunction joined two bodies ALREADY in the same
   * group it pushed the orb onto the list (:109) and left cohesion untouched.
   *
   * So for any stellium of three or more, whichever pair arrives after the
   * group has formed contributes its orb to the array but never to the
   * average — the reported cohesion summarises a subset of the orbs it claims
   * to cover.
   */
  it('averages every contributing orb, including the last pair to arrive', () => {
    // a-b = 4, b-c = 4, a-c = 8. All three pairs are within the orb, so all
    // three orbs must count: mean = (4 + 4 + 8) / 3 = 5.333...
    const result = identifyComposites([at('a', 0), at('b', 4), at('c', 8)], ORB);

    expect(result).toHaveLength(1);
    expect(result[0]?.orbs).toHaveLength(3);
    expect(result[0]?.cohesion).toBeCloseTo(16 / 3, 9);
  });

  it('would differ from a cohesion computed before the last pair', () => {
    // The stale value the prototype reports for the case above is the mean at
    // merge time, (4 + 4) / 2 = 4 — visibly different from 5.333.
    const result = identifyComposites([at('a', 0), at('b', 4), at('c', 8)], ORB);
    const stale = 4;
    expect(result[0]?.cohesion).not.toBeCloseTo(stale, 6);
  });

  it('accrues orbs to the final group, not to whichever existed at the time', () => {
    // Four bodies fusing in a chain. Six pairs are within a 10 degree orb here
    // (a-b, a-c, a-d, b-c, b-d, c-d at 3, 6, 9, 3, 6, 3), and every one must
    // reach the same group.
    const result = identifyComposites([at('a', 0), at('b', 3), at('c', 6), at('d', 9)], ORB);
    expect(result).toHaveLength(1);
    expect(result[0]?.orbs).toHaveLength(6);
  });
});

describe('longitude — the wrap defect', () => {
  /**
   * The prototype averaged raw longitudes. For a group straddling 0 Aries
   * that is not merely imprecise, it is diametrically wrong.
   */
  it('places a group straddling 0 Aries at the true midpoint', () => {
    const result = identifyComposites([at('a', 359), at('b', 1)], ORB);

    expect(result).toHaveLength(1);
    // True midpoint is 0. An arithmetic mean gives 180 — the exact opposite.
    expect(result[0]?.lon).toBeCloseTo(0, 6);
    expect(result[0]?.lon).not.toBeCloseTo(180, 0);
  });

  it('handles an ordinary group the obvious way', () => {
    const result = identifyComposites([at('a', 100), at('b', 106)], ORB);
    expect(result[0]?.lon).toBeCloseTo(103, 6);
  });

  it('normalises a lone body', () => {
    const result = identifyComposites([at('a', 370)], ORB);
    expect(result[0]?.lon).toBeCloseTo(10, 9);
  });
});

describe('output stability', () => {
  it('produces the same order regardless of input order', () => {
    // chartRef is a content hash, so a set-valued result that reorders would
    // change the cache key for identical input.
    const forwards = identifyComposites([at('a', 0), at('b', 4), at('z', 200)], ORB);
    const backwards = identifyComposites([at('z', 200), at('b', 4), at('a', 0)], ORB);
    expect(forwards.map((c) => c.members)).toEqual(backwards.map((c) => c.members));
  });
});
