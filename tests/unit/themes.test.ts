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
import { EDGE_WEIGHT, orbFalloff } from '../../src/domain/scoring-v2.js';
import { identifyStories, isTimeSensitive, storySignature } from '../../src/domain/themes.js';

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

describe('story signatures', () => {
  /**
   * The signature is what makes a configuration nameable outside the engine:
   * a lookup service or a model is keyed on this string, so two people with
   * the same configuration must produce the same one, and two different
   * configurations must never collide.
   */

  it('gives the same signature to the same configuration in two different charts', () => {
    // Same members, same aspect. Nothing else is shared: different longitudes,
    // different orbs, and the second chart carries a body the first does not.
    const first = identifyStories([at('sun', 0), at('saturn', 120)]);
    const second = identifyStories([at('sun', 200), at('saturn', 322), at('mars', 47)]);

    const trineIn = (result: typeof first): (typeof first)['stories'][number] | undefined =>
      result.stories.find((story) => story.aspect === 'trine');

    expect(trineIn(first)?.signature).toBe('trine:saturn|sun');
    expect(trineIn(second)?.signature).toBe(trineIn(first)?.signature);

    // Only the configuration is shared. The orbs differ (0 against 2 degrees),
    // so the scores differ, and the second chart carries a story the first
    // does not.
    expect(trineIn(first)?.orb).toBeCloseTo(0, 9);
    expect(trineIn(second)?.orb).toBeCloseTo(2, 9);
    expect(second.stories.length).toBeGreaterThan(first.stories.length);
  });

  it('separates a different member set and a different aspect', () => {
    const trineToSaturn = identifyStories([at('sun', 0), at('saturn', 120)]).stories[0];
    const trineToJupiter = identifyStories([at('sun', 0), at('jupiter', 120)]).stories[0];
    const squareToSaturn = identifyStories([at('sun', 0), at('saturn', 90)]).stories[0];

    expect(trineToSaturn?.signature).toBe('trine:saturn|sun');
    expect(trineToJupiter?.signature).toBe('trine:jupiter|sun');
    expect(squareToSaturn?.signature).toBe('square:saturn|sun');

    const all = [trineToSaturn, trineToJupiter, squareToSaturn].map((story) => story?.signature);
    expect(new Set(all).size).toBe(3);
  });

  it('is unchanged by the order the members arrive in', () => {
    const forwards = identifyStories([at('sun', 0), at('mercury', 5), at('saturn', 122)]);
    const backwards = identifyStories([at('saturn', 122), at('mercury', 5), at('sun', 0)]);

    expect(forwards.stories[0]?.signature).toBe('trine:mercury+sun|saturn');
    expect(backwards.stories[0]?.signature).toBe(forwards.stories[0]?.signature);

    // And at the function itself, where nothing has pre-sorted anything.
    expect(storySignature('square', ['trueNode', 'moon'], ['chiron'])).toBe(
      storySignature('square', ['chiron'], ['moon', 'trueNode']),
    );
  });

  it('orders the two sides so a configuration has one spelling, not two', () => {
    // Lexicographically smaller side first, by code unit — not localeCompare,
    // whose order depends on the runtime's ICU build. This string is a key on
    // another machine.
    expect(storySignature('square', ['moon', 'trueNode'], ['chiron'])).toBe(
      'square:chiron|moon+trueNode',
    );
  });

  it('does not collide across a differently grouped set of the same members', () => {
    // Same three bodies, different structure: Sun fused with Mercury against
    // Saturn, versus Sun alone against a Mercury-Saturn group. The story is
    // not the same story, and the signature must say so.
    const fusedWithMercury = storySignature('trine', ['mercury', 'sun'], ['saturn']);
    const fusedWithSaturn = storySignature('trine', ['sun'], ['mercury', 'saturn']);

    expect(fusedWithMercury).not.toBe(fusedWithSaturn);
  });
});

describe('what an unknown birth hour puts in question', () => {
  it('flags the Moon and the two angles, and nothing else', () => {
    // The Moon moves ~0.5 deg/hour: ±6 degrees over a 24-hour uncertainty,
    // wider than any orb that forms a story. The angles turn a full circle.
    expect(isTimeSensitive(['moon', 'saturn'])).toBe(true);
    expect(isTimeSensitive(['ascendant', 'mars'])).toBe(true);
    expect(isTimeSensitive(['midheaven', 'venus'])).toBe(true);

    // The Sun covers one degree in a day, Mercury at its fastest 2.3.
    expect(isTimeSensitive(['sun', 'mercury', 'saturn'])).toBe(false);
    expect(isTimeSensitive(['pluto', 'chiron'])).toBe(false);
  });
});

describe('scoring v1, ported verbatim', () => {
  const V1 = { scoring: 'v1' } as const;

  /** base = importance * 100; falloff = (1 - orbMin/600)^2; score = (base + bonus) * falloff * mult */
  function expected(importance: number, orbDeg: number, bonus: number, mult = 1): number {
    const falloff = Math.pow(1 - (orbDeg * 60) / 600, 2);
    return (importance * 100 + bonus) * falloff * mult;
  }

  it('scores an exact opposition at full weight', () => {
    // Opposition, not conjunction — see the unreachability test below.
    // Sun and Jupiter: personal + social = bonus 3.
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)], V1);
    expect(stories[0]?.score).toBeCloseTo(expected(4, 0, 3), 9);
  });

  it('applies the squared falloff', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 182)], V1);
    expect(stories[0]?.score).toBeCloseTo(expected(4, 2, 3), 9);
  });

  it('takes the strongest relational pairing, not an average', () => {
    // themes.js:237-250 kept the MAXIMUM bonus across category pairs, so one
    // personal-generational pairing inside a group carries the whole story.
    const { stories } = identifyStories(
      [
        at('sun', 0),
        at('mercury', 3), // both personal
        at('neptune', 121), // generational -> personal+generational = 5
      ],
      V1,
    );

    const story = stories[0];
    expect(story).toBeDefined();
    // Two-member composite is a 'conjunction', not a stellium: multiplier 1.
    expect(story?.score).toBeCloseTo(expected(3, story?.orb ?? 0, 5), 6);
  });

  it('multiplies for a stellium, and again when a luminary is present', () => {
    const { composites } = identifyStories([at('sun', 0), at('mercury', 4), at('venus', 8)], V1);
    const stellium = composites.find((c) => c.type === 'stellium');

    expect(stellium).toBeDefined();
    expect(stellium?.members).toHaveLength(3);
    // 3 members -> 1.2, Sun present -> * 1.1
    expect(SCORING_V1.stelliumMultiplier.threePlus).toBe(1.2);
    expect(SCORING_V1.stelliumMultiplier.luminaryPresent).toBe(1.1);
  });

  it('stamps the scoring version so a client can detect a change', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)], V1);
    expect(stories[0]?.scoringVersion).toBe('v1');
    expect(stories[0]?.strength).toBeUndefined();
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
    const V1 = { scoring: 'v1' } as const;
    const maxBonus = identifyStories([at('sun', 0), at('neptune', 180)], V1).stories[0];
    const minBonus = identifyStories([at('venus', 0), at('mars', 180)], V1).stories[0];

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

/**
 * Ten real charts, spanning nine decades and both hemispheres.
 *
 * Longitudes in DEFAULT_BODIES order, then Ascendant and Midheaven, produced by
 * `pnpm tsx scripts/measure-scoring-v1.ts --fixtures` against the repository
 * ephemeris. Frozen here rather than recomputed so this stays a unit test: the
 * relationship being pinned is between two scoring functions, and it should not
 * fail because an ephemeris file is missing.
 *
 * Six decimal places is four orders of magnitude finer than any orb in the
 * model, and the fixtures were checked to reproduce the script's rankings
 * exactly.
 */
const REFERENCE_POINT_IDS = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
  'trueNode',
  'chiron',
  'ascendant',
  'midheaven',
] as const;

const REFERENCE_CHARTS: readonly { label: string; lons: readonly number[] }[] = [
  {
    label: 'Rome 1987',
    lons: [
      139.155663, 0.225028, 130.771114, 136.165501, 143.367176, 29.638134, 254.573059, 262.888415,
      275.56302, 217.329241, 3.126491, 86.915252, 200.198433, 113.917525,
    ],
  },
  {
    label: 'Berlin 1934',
    lons: [
      57.496419, 120.598626, 64.719656, 13.986156, 49.56136, 194.020066, 327.840844, 29.106671,
      159.598762, 112.90542, 313.214268, 63.719126, 75.819497, 309.113601,
    ],
  },
  {
    label: 'Buenos Aires 1952',
    lons: [
      344.254396, 88.794586, 354.714954, 315.593991, 226.113222, 17.01905, 193.630753, 99.980023,
      201.259984, 139.783547, 330.504664, 280.992476, 140.012151, 64.887025,
    ],
  },
  {
    label: 'Sao Paulo 1961',
    lons: [
      250.071584, 184.414113, 242.417856, 236.66194, 253.475837, 304.419804, 296.569143, 150.542382,
      222.093689, 160.104261, 141.020061, 332.09156, 300.195587, 205.041886,
    ],
  },
  {
    label: 'Tokyo 1969',
    lons: [
      244.730545, 100.377064, 250.809448, 230.636532, 316.309174, 206.497374, 33.303512, 187.778353,
      238.672612, 177.083145, 347.530197, 2.502067, 348.307306, 263.187016,
    ],
  },
  {
    label: 'Delhi 1978',
    lons: [
      113.044848, 234.19158, 139.113166, 154.351491, 168.194227, 109.054023, 148.787642, 222.328532,
      256.011185, 194.028545, 179.209836, 39.388554, 85.397266, 339.811311,
    ],
  },
  {
    label: 'New York 1996',
    lons: [
      90.46474, 150.979555, 70.440065, 74.027487, 66.385492, 284.38479, 6.777086, 303.852323,
      297.065748, 240.96087, 193.570692, 188.176744, 146.286296, 49.74017,
    ],
  },
  {
    label: 'Nairobi 2004',
    lons: [
      288.354865, 127.116048, 266.789303, 323.395986, 14.248525, 168.858437, 99.071087, 330.430589,
      311.972891, 260.791221, 48.565854, 289.256603, 343.876621, 256.190619,
    ],
  },
  {
    label: 'Reykjavik 2011',
    lons: [
      216.994808, 271.212348, 235.961103, 236.781827, 144.07377, 35.053953, 202.233879, 1.297278,
      328.165218, 275.383242, 254.821054, 330.704674, 91.12664, 295.808865,
    ],
  },
  {
    label: 'Sydney 2018',
    lons: [
      17.101258, 272.69528, 7.823224, 38.333251, 281.298784, 231.961891, 279.047308, 27.822189,
      345.149443, 291.226379, 132.57307, 359.419979, 56.759226, 336.398496,
    ],
  },
];

function referencePoints(lons: readonly number[]): AspectPoint[] {
  return REFERENCE_POINT_IDS.map((id, index) => at(id, lons[index] ?? 0));
}

describe('v1 against v2, on ten reference charts', () => {
  /**
   * What scripts/measure-scoring-v1.ts measured, pinned so the relationship
   * cannot drift unnoticed. These assert what IS true, which is narrower than
   * "the two versions agree": they agree on the set always, on the headline
   * usually, and on the rest of the ordering rarely.
   */

  it('produces the identical set of stories under both versions', () => {
    // Membership is decided by identifyComposites and the orb policy before
    // any scoring runs, so no weight can add or remove a story. True on all
    // ten charts, and the reason every other difference here is about order.
    for (const chart of REFERENCE_CHARTS) {
      const points = referencePoints(chart.lons);
      const v1 = identifyStories(points, { scoring: 'v1' }).stories;
      const v2 = identifyStories(points, { scoring: 'v2' }).stories;

      expect(v1.length, chart.label).toBeGreaterThan(0);
      expect([...v1.map((story) => story.id)].sort(), chart.label).toEqual(
        [...v2.map((story) => story.id)].sort(),
      );
    }
  });

  it('agrees on the top story on eight of the ten, and differs on the named two', () => {
    // Not "always agrees" — that would be the convenient claim. Two charts
    // genuinely disagree, and they disagree for different reasons:
    //
    //   Berlin 1934  v1 leads with a Jupiter-Venus opposition 0.03 degrees
    //                from exact; v2 leads with a four-body stellium square at
    //                1.04. v1's aspect table spans 2x (opposition 4, square 2)
    //                and its flat 600-arcminute falloff docks that square to
    //                0.80, where v2 spans 1.41x and leaves it at 0.92.
    //
    //   Delhi 1978   the relational weight. v2's Midheaven-Uranus trine is
    //                personal+generational, worth x1.5, against a Chiron-Uranus
    //                opposition where Chiron has no category at all, worth x1.
    //                In v1 that same distinction is worth 5 points out of 200
    //                and the opposition's aspect weight decides it.
    //
    // Naming them is what makes a future change legible: a chart entering or
    // leaving this list is a real shift in the model, not noise.
    const disagree: string[] = [];

    for (const chart of REFERENCE_CHARTS) {
      const points = referencePoints(chart.lons);
      const v1 = identifyStories(points, { scoring: 'v1' }).stories;
      const v2 = identifyStories(points, { scoring: 'v2' }).stories;
      if (v1[0]?.id !== v2[0]?.id) disagree.push(chart.label);
    }

    expect(disagree).toEqual(['Berlin 1934', 'Delhi 1978']);
  });

  it('never moves a story more than three places between the versions', () => {
    // The two rankings are close but not the same: 8 of 10 charts reorder
    // somewhere below the top. Three places is the measured worst case, on
    // Reykjavik 2011 with twelve stories.
    let worstShift = 0;

    for (const chart of REFERENCE_CHARTS) {
      const points = referencePoints(chart.lons);
      const v1 = identifyStories(points, { scoring: 'v1' }).stories;
      const v2 = identifyStories(points, { scoring: 'v2' }).stories;

      const positionInV2 = new Map(v2.map((story, index) => [story.id, index]));
      v1.forEach((story, index) => {
        const moved = Math.abs((positionInV2.get(story.id) ?? index) - index);
        if (moved > worstShift) worstShift = moved;
      });
    }

    expect(worstShift).toBe(3);
  });

  it('reaches no conjunction story on any of them', () => {
    // The empirical half of the unreachability argument in SCORING_V1. The
    // structural half is that composites occupy disjoint arcs separated by
    // gaps wider than 10 degrees, and their circular means stay inside those
    // arcs for any point set this engine builds.
    for (const chart of REFERENCE_CHARTS) {
      const { stories } = identifyStories(referencePoints(chart.lons), { scoring: 'v1' });
      expect(
        stories.every((story) => story.aspect !== 'conjunction'),
        chart.label,
      ).toBe(true);
    }
  });
});

describe('scoring v2, the default', () => {
  it('is what you get without asking', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)]);
    expect(stories[0]?.scoringVersion).toBe('v2');
  });

  it('reports strength in [0, 1], comparable across charts', () => {
    // v1's raw number meant nothing on its own: it ranged 21 to 375 on the
    // reference chart and depended on how many stelliums happened to exist.
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)]);
    const strength = stories[0]?.strength;

    expect(strength).toBeDefined();
    expect(strength).toBeGreaterThan(0);
    expect(strength).toBeLessThanOrEqual(1);
  });

  it('exposes every factor, so a ranking can be explained', () => {
    const { stories } = identifyStories([at('sun', 0), at('jupiter', 180)]);
    const factors = stories[0]?.factors;

    expect(factors).toBeDefined();
    expect(factors?.aspect).toBeCloseTo(1 / Math.sqrt(2), 9); // opposition, harmonic 2
    expect(factors?.orb).toBeCloseTo(1, 9); // exact
    expect(factors?.relation).toBeCloseTo(1.25, 9); // personal + social, rank 3 of 5
    expect(factors?.group).toBe(1);
  });

  it('normalises the falloff by each aspect own orb', () => {
    // v1 divided everything by a flat 600 arcminutes, so a square at its own
    // 6-degree limit still scored 0.16 while a conjunction at 10 scored 0.
    // Here both land on EDGE_WEIGHT.
    const squareAtLimit = orbFalloff(6, 6);
    const trineAtLimit = orbFalloff(7, 7);
    const oppositionAtLimit = orbFalloff(8, 8);

    expect(squareAtLimit).toBeCloseTo(EDGE_WEIGHT, 9);
    expect(trineAtLimit).toBeCloseTo(EDGE_WEIGHT, 9);
    expect(oppositionAtLimit).toBeCloseTo(EDGE_WEIGHT, 9);
  });

  it('keeps the decay steep on purpose', () => {
    // Deliberate: the steep curve is what lets one or two stories stand out.
    // A gentle one flattens every story into the same band. Changing this
    // changes which stories a chart is said to be about.
    expect(EDGE_WEIGHT).toBe(0.06);
    expect(orbFalloff(0, 8) / orbFalloff(8, 8)).toBeCloseTo(1 / EDGE_WEIGHT, 6);
  });

  it('makes the relational weight actually matter, unlike v1', () => {
    // v1 added 1..5 to a base of 200-500: about one percent. v2 multiplies.
    const strong = identifyStories([at('sun', 0), at('neptune', 180)]).stories[0];
    const weak = identifyStories([at('venus', 0), at('mars', 180)]).stories[0];

    expect(strong?.score).toBeDefined();
    // personal+generational (1.5) against personal+personal (1.0)
    expect((strong?.score ?? 0) / (weak?.score ?? 1)).toBeCloseTo(1.5, 6);
  });
});
