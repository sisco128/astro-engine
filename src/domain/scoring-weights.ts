/**
 * Every constant in the theme scoring model, in one place, with its origin.
 *
 * In the prototype these were 434 lines of bare literals scattered through
 * themes.js. Nothing said where any of them came from or what would happen if
 * one changed. Lifting them here is behaviour-preserving — not a single value
 * is altered — but it makes the model reviewable, and it lets a `scoringVersion`
 * ship in the response so a frontend can tell when the weighting moved.
 *
 * Two properties of this model are worth flagging rather than silently
 * carrying forward. Both are preserved exactly; both look like accidents.
 * See the notes on `maxOrbMinutes` and `relationalBonus`.
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
   * WARNING: `conjunction: 5` is unreachable, and it is the highest weight in
   * the table.
   *
   * Composite fusion uses `compositeConjunctionOrbDeg` = 10, and the natal
   * conjunction orb is also 10. Two composites close enough to be conjunct
   * therefore have members close enough to have already fused into one
   * composite — so there is no pair, and no story. The effective maximum is
   * the opposition at 4.
   *
   * Verified empirically: 60,000 random chart layouts produced zero
   * conjunction stories, and tests/unit/themes.test.ts asserts it
   * deterministically.
   *
   * Preserved because removing it would change nothing about behaviour while
   * discarding evidence of what the model's author intended. Fixing it — by
   * making the fusion orb tighter than the conjunction orb — would be a real
   * change to every chart's rankings and needs its own decision.
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
   * Note it is a single constant for every aspect. The square's orb is 6
   * degrees, so a square at the very edge of its orb still scores
   * (1 - 360/600)^2 = 0.16 rather than falling to zero; the trine at 7 degrees
   * scores 0.09. Only the conjunction, whose orb is also 10 degrees, actually
   * reaches zero at its limit. Whether that was intended is unknown, and it is
   * preserved here unchanged.
   */
  maxOrbMinutes: 600,

  /** themes.js:357. `orbModifier = (1 - orbMinutes / maxOrbMinutes) ^ 2`. */
  orbFalloffExponent: 2,

  /**
   * themes.js:241-246. Symmetric; the pair is looked up in either order.
   *
   * Note the magnitude. This is added to a base score of 200-500, so the
   * largest bonus available moves the result by about one percent. Every other
   * factor in the model is multiplicative. A "bonus" that additive is
   * effectively inert, which reads like an intended `*` that was typed as `+`
   * (themes.js:368). Preserved as written — changing it would silently
   * re-rank every chart ever scored.
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
