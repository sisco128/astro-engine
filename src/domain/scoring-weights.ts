/**
 * Every constant in the theme scoring model, in one place, with its origin.
 *
 * In the prototype these were 434 lines of bare literals scattered through
 * themes.js. Nothing said where any of them came from or what would happen if
 * one changed. Lifting them here is behaviour-preserving — not a single value
 * is altered — but it makes the model reviewable, and it lets a `scoringVersion`
 * ship in the response so a frontend can tell when the weighting moved.
 *
 * Three properties of this model looked like accidents. All three are still
 * preserved exactly — v1's contract is to reproduce prototype results — but
 * they are no longer suspicions. scripts/measure-scoring-v1.ts re-scores the
 * same stories with one factor changed at a time over ten charts spanning nine
 * decades and both hemispheres (76 stories), and each note below states what
 * was measured. Re-run it before touching any number here.
 *
 * One result applies to all three and is worth stating once: no variant ever
 * changed the SET of stories, on any chart. Membership is decided by
 * identifyComposites and the orb policy before scoring runs, so a weight can
 * only reorder stories, never add or remove one. Everything below is therefore
 * about ranking and magnitude.
 */

import type { AspectId } from './orb-policy.js';

export type PlanetCategory = 'personal' | 'social' | 'generational';

export const SCORING_V1 = {
  version: 'v1',

  /**
   * Bodies within this orb of each other fuse into one composite body.
   * themes.js:51.
   */
  compositeConjunctionOrbDeg: 10,

  /**
   * themes.js:345-351. Multiplied by `baseScoreMultiplier` to form the base.
   *
   * `conjunction: 5` is the highest weight in the table and no chart can reach
   * it. The effective maximum is the opposition at 4.
   *
   * The proof, for charts. Fusion joins points within
   * `compositeConjunctionOrbDeg` = 10 transitively, so composites occupy
   * disjoint arcs separated by gaps strictly wider than 10 degrees. A
   * composite's `lon` is the circular mean of its members, and for a set inside
   * an arc narrower than 180 degrees that mean lies inside the arc. Every route
   * between two arcs crosses a gap, so two composite means are always more than
   * 10 degrees apart — and `aspectBetween` needs 10 or less, the natal
   * conjunction orb being 10 as well. The 180-degree condition always holds
   * here: the funnel route feeds a fixed 14 points (DEFAULT_BODIES plus the two
   * angles), which chain across at most 13 gaps of 10 degrees, so no composite
   * can span more than 130.
   *
   * Measured over the ten charts: zero conjunction stories, widest composite
   * 20.2 degrees, and the closest pair of composite means 10.5 degrees. The
   * margin over the 10-degree orb is real but thin, which is why the argument
   * above is stated rather than left to the sample.
   *
   * NOT deleted, and the reason is not sentiment. `identifyStories` is exported
   * and accepts any points, not only charts. A synthetic 268-point set whose
   * composite wraps past 180 degrees with its mass at both ends puts the
   * circular mean outside its own arc, in the empty gap, and does produce a
   * conjunction story — scripts/measure-scoring-v1.ts constructs it. Removing
   * this entry drops that story's base from 500 to 0 via the `?? 0` in
   * themes.ts, so deletion is not output-preserving and the "dead weight"
   * reading is wrong.
   *
   * Nothing serves this table to clients: /v1/meta offers license, funnel and
   * life-phases only, and /v1/charts carries no stories. So observability is
   * not what keeps the entry — reachability is.
   *
   * Fixing the model instead — making the fusion orb tighter than the
   * conjunction orb — would re-rank every chart and needs its own decision.
   */
  aspectImportance: {
    conjunction: 5,
    opposition: 4,
    trine: 3,
    square: 2,
  } as Partial<Record<AspectId, number>>,

  /** themes.js:351. */
  baseScoreMultiplier: 100,

  /**
   * themes.js:304. Ten degrees, expressed in arcminutes.
   *
   * It is a single constant for every aspect. The square's orb is 6 degrees, so
   * a square at the very edge of its orb still scores (1 - 360/600)^2 = 0.16
   * rather than falling to zero; the trine at 7 degrees scores 0.09. Only the
   * conjunction, whose orb is also 10 degrees, reaches zero at its limit.
   *
   * This is the largest of the three accidents by score and the smallest by
   * consequence. Dividing by each aspect's own orb instead moves scores by up
   * to 98.8% — a near doubling for a square out near its limit — and reorders
   * 6 of the 10 charts. But no story moves more than 2 places, and the top
   * story does not change on ANY chart. The falloff decides magnitudes; it does
   * not decide what a chart is said to be about.
   *
   * Preserved because v1 must reproduce prototype numbers, and a 98.8% score
   * shift is exactly the kind of change that would do so silently. scoring-v2
   * normalises by the aspect's own orb, which is the fix.
   */
  maxOrbMinutes: 600,

  /** themes.js:357. `orbModifier = (1 - orbMinutes / maxOrbMinutes) ^ 2`. */
  orbFalloffExponent: 2,

  /**
   * themes.js:241-246. Symmetric; the pair is looked up in either order.
   *
   * Added to a base of 200-500 where every other factor multiplies, which reads
   * like an intended `*` typed as `+` (themes.js:368). Measured, "effectively
   * inert" turns out to be literally true: DELETING the bonus outright changes
   * no ranking on any of the ten charts, not one position. Its ceiling is 2.44%
   * of a story's score — reached on a square, whose base of 200 is the smallest
   * — and 23 of the 76 stories receive no bonus at all, because Pluto, the true
   * node and Chiron are absent from `planetCategory` below.
   *
   * So the accident costs nothing as written. What it would cost to "fix" is
   * the part worth knowing:
   *
   *   base * bonus, the literal typo reading   reorders 10/10 charts,
   *                                            top story changes on 5,
   *                                            a story moves up to 9 places,
   *                                            scores move up to +394%
   *   base * (1 + (rank-1)/8), as v2 does it   reorders 7/10 charts,
   *                                            top story changes on 1,
   *                                            up to 3 places, up to 48%
   *
   * The literal reading is also destructive rather than merely different: with
   * a bonus of 0 for any uncategorised body it zeroes 23 stories outright.
   *
   * Preserved as written. Not because the change is unknowable — it is right
   * there — but because it is large, and v1 exists to reproduce the old
   * numbers. scoring-v2 carries the scaled version.
   */
  relationalBonus: {
    'personal+personal': 1,
    'personal+social': 3,
    'personal+generational': 5,
    'social+social': 2,
    'social+generational': 3,
    'generational+generational': 2,
  } as Record<string, number>,

  /** themes.js:261-272. */
  stelliumMultiplier: {
    /** Three bodies fused. */
    threePlus: 1.2,
    /** Four or more. */
    fourPlus: 1.5,
    /** Applied on top when the Sun or Moon is one of them. */
    luminaryPresent: 1.1,
  },

  /**
   * planets.js:23-25.
   *
   * The Ascendant and Midheaven are classed personal. Pluto, the lunar nodes,
   * Lilith and Chiron are absent because the prototype never computed them —
   * they fall through to 'unknown' and score no relational bonus at all. The
   * engine now offers those bodies, so this table needs extending before they
   * can take part in themes. Deliberately left as-is for now: adding them
   * would change scores, and v1 exists to reproduce the old numbers.
   */
  planetCategory: {
    sun: 'personal',
    moon: 'personal',
    mercury: 'personal',
    venus: 'personal',
    mars: 'personal',
    ascendant: 'personal',
    midheaven: 'personal',
    jupiter: 'social',
    saturn: 'social',
    uranus: 'generational',
    neptune: 'generational',
  } as Record<string, PlanetCategory | undefined>,

  /** The luminaries, for the stellium multiplier. */
  luminaries: ['sun', 'moon'],
} as const;

export type ScoringWeights = typeof SCORING_V1;

/** Symmetric lookup into the relational bonus matrix. */
export function relationalBonus(
  a: PlanetCategory | undefined,
  b: PlanetCategory | undefined,
  weights: ScoringWeights = SCORING_V1,
): number {
  if (a === undefined || b === undefined) return 0;
  return weights.relationalBonus[`${a}+${b}`] ?? weights.relationalBonus[`${b}+${a}`] ?? 0;
}
