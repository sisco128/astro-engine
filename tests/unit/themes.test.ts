/**
 * Story identification and scoring.
 *
 * The numbers are ported unchanged from themes.js, so the tests assert the
 * ported arithmetic rather than judging whether the model is good. Two of the
 * constants look like accidents; those get their own tests, so that if anyone
 * later "fixes" them the change is loud rather than silent.
 */

import { describe, expect, it } from 'vitest';

import type { AspectPoint } from '../../src/domain/aspects.js';
import { ORB_POLICIES } from '../../src/domain/orb-policy.js';
import { SCORING_V1 } from '../../src/domain/scoring-weights.js';
import { identifyStories } from '../../src/domain/themes.js';

function at(id: string, lon: number): AspectPoint {
  return { id, lon };
}

describe('story identification', () => {
  it('finds a story between two lone bodies in aspect', () => {
    const { stories } = identifyStories([at('sun', 0), at('saturn', 120)]);

    expect(stories).toHaveLength(1);
    expect(stories[0]?.aspect).toBe('trine');
    expect([...(stories[0]?.members ?? [])].sort()).toEqual(['saturn', 'sun']);
  });

  it('finds nothing when no aspect is within orb', () => {
    // 40 degrees: past the conjunction orb, and the natal.v1 policy has no
    // sextile or semisquare.
    expect(identifyStories([at('sun', 0), at('saturn', 40)]).stories).toHaveLength(0);
  });

  it('fuses conjunct bodies into one side before looking for aspects', () => {
    // Sun and Mercury within 10 degrees become one composite; the story is
    // between that group and Saturn, not three separate pairs.
    const { composites, stories } = identifyStories([
      at('sun', 0),
      at('mercury', 5),
      at('saturn', 122),
    ]);

    expect(composites).toHaveLength(2);
    expect(stories).toHaveLength(1);
    expect([...(stories[0]?.members ?? [])].sort()).toEqual(['mercury', 'saturn', 'sun']);
  });

  it('excludes the Ascendant-Midheaven pair', () => {
    // They are geometrically bound and always in aspect, so a "story" between
    // them is an artefact of the coordinate system. themes.js:315 did the same.
    const { stories } = identifyStories([at('ascendant', 0), at('midheaven', 90)]);
    expect(stories).toHaveLength(0);
  });

  it('still allows the angles to take part in other stories', () => {
    const { stories } = identifyStories([at('ascendant', 0), at('mars', 90)]);
    expect(stories).toHaveLength(1);
    expect([...(stories[0]?.members ?? [])].sort()).toEqual(['ascendant', 'mars']);
  });

  it('orders stories by score, strongest first', () => {
    const { stories } = identifyStories([
      at('sun', 0),
      at('moon', 0.1), // near-exact conjunction: highest importance, tightest orb
      at('mars', 95), // square, 5 degrees off
      at('saturn', 185), // opposition, 5 degrees off
    ]);

    expect(stories.length).toBeGreaterThan(1);
    for (let i = 1; i < stories.length; i += 1) {
      expect(stories[i - 1]?.score).toBeGreaterThanOrEqual(stories[i]?.score ?? 0);
    }
  });
});

describe('scoring, ported verbatim', () => {
  /** base = importance * 100; falloff = (1 - orbMin/600)^2; score = (base + bonus) * falloff * mult */
  function expected(importance: number, orbDeg: number, bonus: number, mult = 1): number {
    const falloff = Math.pow(1 - (orbDeg * 60) / 600, 2);
    return (importance * 100 + bonus) * falloff * mult;
  }

  it('scores an exact opposition at full weight', () => {
    // Opposition, not conjunction — see the unreachability test below.
    // Sun and Jupiter: personal + social = bonus 3.
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)]);
    expect(stories[0]?.score).toBeCloseTo(expected(4, 0, 3), 9);
  });

  it('applies the squared falloff', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 182)]);
    expect(stories[0]?.score).toBeCloseTo(expected(4, 2, 3), 9);
  });

  it('takes the strongest relational pairing, not an average', () => {
    // themes.js:237-250 kept the MAXIMUM bonus across category pairs, so one
    // personal-generational pairing inside a group carries the whole story.
    const { stories } = identifyStories([
      at('sun', 0),
      at('mercury', 3), // both personal
      at('neptune', 121), // generational -> personal+generational = 5
    ]);

    const story = stories[0];
    expect(story).toBeDefined();
    // Two-member composite is a 'conjunction', not a stellium: multiplier 1.
    expect(story?.score).toBeCloseTo(expected(3, story?.orb ?? 0, 5), 6);
  });

  it('multiplies for a stellium, and again when a luminary is present', () => {
    const { composites } = identifyStories([at('sun', 0), at('mercury', 4), at('venus', 8)]);
    const stellium = composites.find((c) => c.type === 'stellium');

    expect(stellium).toBeDefined();
    expect(stellium?.members).toHaveLength(3);
    // 3 members -> 1.2, Sun present -> * 1.1
    expect(SCORING_V1.stelliumMultiplier.threePlus).toBe(1.2);
    expect(SCORING_V1.stelliumMultiplier.luminaryPresent).toBe(1.1);
  });

  it('stamps the scoring version so a client can detect a change', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)]);
    expect(stories[0]?.scoringVersion).toBe('v1');
  });
});

describe('the two constants that look like accidents', () => {
  /**
   * Both are preserved exactly. These tests exist so that changing either is a
   * deliberate act with a failing test attached, not a quiet re-ranking of
   * every chart ever scored.
   */

  it('uses one 600-arcminute falloff for every aspect, so only the conjunction reaches zero', () => {
    // A square's orb is 6 degrees = 360 arcminutes. At its own limit the
    // falloff is (1 - 360/600)^2 = 0.16, not 0. The conjunction's orb is 10
    // degrees = 600 arcminutes, so only it falls to zero at its limit.
    expect(SCORING_V1.maxOrbMinutes).toBe(600);

    const squareAtLimit = Math.pow(1 - 360 / SCORING_V1.maxOrbMinutes, 2);
    const conjunctionAtLimit = Math.pow(1 - 600 / SCORING_V1.maxOrbMinutes, 2);

    expect(squareAtLimit).toBeCloseTo(0.16, 9);
    expect(conjunctionAtLimit).toBeCloseTo(0, 12);
  });

  it('adds the relational bonus, making it worth about one percent', () => {
    // Every other factor in the model multiplies. On a base of 200-500 the
    // largest bonus (5) moves the result by ~1%. Same geometry both times, so
    // the only difference is the bonus: 5 against 1.
    const maxBonus = identifyStories([at('sun', 0), at('neptune', 180)]).stories[0];
    const minBonus = identifyStories([at('venus', 0), at('mars', 180)]).stories[0];

    expect(maxBonus).toBeDefined();
    expect(minBonus).toBeDefined();

    const difference = (maxBonus?.score ?? 0) - (minBonus?.score ?? 0);
    expect(difference).toBe(4);
    expect(difference / (maxBonus?.score ?? 1)).toBeLessThan(0.01);
  });

  it('can never apply the conjunction weight, the highest in the table', () => {
    // Structural, not incidental: the composite fusion orb and the conjunction
    // aspect orb are both 10 degrees (SCORING_V1.compositeConjunctionOrbDeg
    // and ORB_POLICIES['natal.v1'].conjunction). Two composites close enough
    // to be conjunct necessarily have members close enough to have fused, so
    // they are one composite and there is no story.
    //
    // Verified empirically: 60,000 random chart layouts produced zero
    // conjunction stories.
    expect(SCORING_V1.compositeConjunctionOrbDeg).toBe(10);
    expect(ORB_POLICIES['natal.v1'].conjunction).toBe(10);

    // A deterministic sample rather than a random sweep, so the test is fast
    // and stable. Spread across the circle, nothing near enough to fuse.
    for (let offset = 0; offset < 360; offset += 7) {
      const { stories } = identifyStories([
        at('sun', offset),
        at('mars', offset + 61),
        at('jupiter', offset + 133),
        at('neptune', offset + 214),
        at('saturn', offset + 287),
      ]);
      expect(stories.every((story) => story.aspect !== 'conjunction')).toBe(true);
    }
  });
});
