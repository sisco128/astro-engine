/**
 * Story scoring, v2: the same four factors, restructured so they compose.
 *
 * v1 is a faithful port of themes.js and stays available. This exists because
 * the score is about to do a job it was never built for — weighting key dates
 * inside the funnel — which means values must be comparable ACROSS stories,
 * not merely ordered within one chart.
 *
 * Measured on the 1987 reference chart, v1 produces:
 *
 *   375.2  trine       orb 1.37
 *    76.6  square      orb 3.89
 *    ...
 *    21.3  opposition  orb 7.69   <- the highest reachable aspect weight, last
 *
 * The opposition carries v1's top usable weight (400) and finishes bottom.
 * Aspect weights span 2x; the orb falloff spans 14x. The falloff swamps
 * everything, so the carefully-built 5/4/3/2 table barely participates.
 *
 * Three structural problems, fixed here:
 *
 *   1. The falloff divided by a flat 600 arcminutes for every aspect, and
 *      decayed as (1-x)^2 — brutal, and unfair to aspects whose own orb is
 *      narrower than 10 degrees.
 *   2. The relational bonus was ADDED to a base of 200-500, making it worth
 *      about one percent while every other factor multiplied.
 *   3. Nothing was on a common scale, so changing one factor forced retuning
 *      the others and the resulting number meant nothing on its own.
 *
 * Deliberately NOT addressed here, by decision: composite cohesion and house
 * angularity are both computed elsewhere and still unused. Structure first.
 */

import type { AspectId } from './orb-policy.js';
import type { PlanetCategory } from './scoring-weights.js';

/**
 * Aspect weight from the harmonic, rather than chosen.
 *
 * Aspects are divisions of the circle: conjunction is harmonic 1, opposition
 * 2, trine 3, square 4, sextile 6. Weighting by 1/sqrt(h) gives ratios with a
 * reason instead of a preference.
 *
 * Worth noting how close this lands to v1's hand-built table, normalised:
 *
 *              conj   opp   trine  square
 *   v1 (n)     1.00   0.80   0.60   0.40
 *   1/sqrt(h)  1.00   0.71   0.58   0.50
 *
 * Same ordering, similar spacing. The original intuition was tracking the
 * harmonic structure; this just makes the reason explicit.
 */
export const ASPECT_HARMONIC: Readonly<Record<AspectId, number>> = {
  conjunction: 1,
  opposition: 2,
  trine: 3,
  square: 4,
  sextile: 6,
  semisquare: 8,
  sesquiquadrate: 8,
  quincunx: 12,
  semisextile: 12,
};

export function aspectWeight(aspect: AspectId): number {
  return 1 / Math.sqrt(ASPECT_HARMONIC[aspect]);
}

/**
 * What an aspect at the very edge of its orb is worth, relative to exact.
 *
 * This is the single most consequential number in the model, and it is a
 * deliberate choice rather than a leftover. At 0.06 the orb factor spans 17x
 * while the aspect factor spans 1.4x, so orb tightness dominates ranking
 * almost entirely.
 *
 * That is the intent. The goal is for one or two stories to stand out as
 * fundamental to a chart, and a steep decay is the mechanism that produces the
 * hierarchy — a gentle one flattens every story into the same band.
 *
 * Worth knowing what it does and does not achieve. Measured over 40 charts,
 * an average of 3.13 stories land within half the top score, ranging from 1 to
 * 6. Whether a single story dominates depends on whether the chart happens to
 * hold one notably tighter aspect; the decay cannot manufacture that. Charts
 * genuinely carrying five comparable themes are reported as such rather than
 * forced into a false hierarchy.
 */
export const EDGE_WEIGHT = 0.06;

/**
 * Orb falloff, normalised by THAT aspect's own orb.
 *
 * v1 divided every aspect by a flat 600 arcminutes, so a square — whose orb is
 * 6 degrees — was measured against a 10-degree scale and never reached zero at
 * its own limit. Here each aspect decays over its own orb, so they are
 * comparable.
 *
 * Gaussian rather than a cosine taper because it never reaches exactly zero.
 * Now that the score feeds the funnel, a story at the edge of its orb should
 * rank last, not vanish and destabilise the ordering.
 *
 *   orb / maxOrb   0.00   0.25   0.50   0.75   1.00
 *   weight         1.00   0.84   0.49   0.21   0.06
 */
export function orbFalloff(orb: number, maxOrb: number): number {
  if (maxOrb <= 0) return 0;
  // sigma such that F(maxOrb) === EDGE_WEIGHT.
  const sigma = maxOrb / Math.sqrt(-Math.log(EDGE_WEIGHT));
  return Math.exp(-Math.pow(orb / sigma, 2));
}

/**
 * Relational weight, as a multiplier rather than an additive crumb.
 *
 * v1's matrix ran 1 to 5 and was added to a base of 200-500. Here the same
 * ordering maps onto [1.0, 1.5], so a personal-generational pairing genuinely
 * scores half again as much as personal-personal — which is what the matrix
 * appears to have been trying to say.
 */
const RELATION_RANK: Readonly<Record<string, number>> = {
  'personal+personal': 1,
  'social+social': 2,
  'generational+generational': 2,
  'personal+social': 3,
  'social+generational': 3,
  'personal+generational': 5,
};

export const RELATION_WEIGHT_RANGE = [1.0, 1.5] as const;

export function relationWeight(
  a: PlanetCategory | undefined,
  b: PlanetCategory | undefined,
): number {
  if (a === undefined || b === undefined) return RELATION_WEIGHT_RANGE[0];
  const rank = RELATION_RANK[`${a}+${b}`] ?? RELATION_RANK[`${b}+${a}`] ?? 1;
  // ranks run 1..5; map onto the range linearly.
  return (
    RELATION_WEIGHT_RANGE[0] +
    ((rank - 1) / 4) * (RELATION_WEIGHT_RANGE[1] - RELATION_WEIGHT_RANGE[0])
  );
}

/**
 * Group weight. Unchanged from v1 in its values, kept as a multiplier.
 *
 * Still a step function, and still blind to how tightly the group is packed —
 * a three-body stellium spanning 25 degrees weighs the same as one spanning 2.
 * `cohesion` is already computed in composites.ts and would fix that; leaving
 * it out is a decision, not an oversight.
 */
export const GROUP_WEIGHT_MAX = 1.65;

export function groupWeight(memberCount: number, hasLuminary: boolean): number {
  if (memberCount < 3) return 1;
  const base = memberCount >= 4 ? 1.5 : 1.2;
  return hasLuminary ? base * 1.1 : base;
}

/** The product of every factor's maximum. Used to normalise into [0, 1]. */
export const THEORETICAL_MAX =
  1 * 1 * RELATION_WEIGHT_RANGE[1] * GROUP_WEIGHT_MAX * GROUP_WEIGHT_MAX;

export interface ScoreV2Input {
  readonly aspect: AspectId;
  readonly orb: number;
  /** The orb limit for this aspect under the policy in force. */
  readonly maxOrb: number;
  readonly relation: readonly [PlanetCategory | undefined, PlanetCategory | undefined];
  readonly groupA: { readonly members: number; readonly hasLuminary: boolean };
  readonly groupB: { readonly members: number; readonly hasLuminary: boolean };
}

export interface ScoreV2 {
  /** Product of the factors. Comparable across stories and across charts. */
  readonly score: number;
  /** `score` as a fraction of the theoretical maximum, in [0, 1]. */
  readonly strength: number;
  /** Every factor, so a client can see WHY a story ranks where it does. */
  readonly factors: {
    readonly aspect: number;
    readonly orb: number;
    readonly relation: number;
    readonly group: number;
  };
}

export function scoreStoryV2(input: ScoreV2Input): ScoreV2 {
  const aspect = aspectWeight(input.aspect);
  const orb = orbFalloff(input.orb, input.maxOrb);
  const relation = relationWeight(input.relation[0], input.relation[1]);
  const group =
    groupWeight(input.groupA.members, input.groupA.hasLuminary) *
    groupWeight(input.groupB.members, input.groupB.hasLuminary);

  const score = aspect * orb * relation * group;

  return {
    score,
    strength: score / THEORETICAL_MAX,
    factors: { aspect, orb, relation, group },
  };
}
