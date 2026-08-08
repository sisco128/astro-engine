/**
 * Stories: the groupings that keep a chart's aspect list from being noise.
 *
 * A chart with a dozen points produces dozens of aspects, most of them
 * uninformative on their own. A story is a set of aspects that belong
 * together — bodies close enough to act as one, related to another such group
 * by a major aspect. It is the unit that transits are tested against, and the
 * reason the funnel filters at all: layering transits on raw aspects would
 * stack structure on noise.
 *
 * The scoring is ported from themes.js with every number unchanged. Two of
 * those numbers look like accidents and are flagged in SCORING_V1; they stay
 * as written, because altering them silently re-ranks every chart ever scored.
 *
 * The score orders stories. It does NOT decide which transits count — in the
 * prototype `finalScore` was computed at themes.js:368 and read only by the
 * sort at :405. Whether story weight should influence key dates is an open
 * question, deliberately not answered here.
 */

import { aspectBetween, type AspectPoint } from './aspects.js';
import { identifyComposites, type CompositeBody } from './composites.js';
import { ORB_POLICIES, type AspectId, type OrbPolicyId } from './orb-policy.js';
import {
  relationalBonus,
  SCORING_V1,
  type PlanetCategory,
  type ScoringWeights,
} from './scoring-weights.js';

export interface Story {
  /** Stable identifier: the two composite sides, sorted. */
  readonly id: string;
  readonly a: CompositeBody;
  readonly b: CompositeBody;
  readonly aspect: AspectId;
  readonly orb: number;
  /**
   * Every natal point on either side. A transit to any of these tests the
   * story — which is what `same-story` nesting means.
   */
  readonly members: readonly string[];
  readonly score: number;
  /** Which weighting produced `score`, so a client can detect a change. */
  readonly scoringVersion: string;
}

function categoryOf(member: string, weights: ScoringWeights): PlanetCategory | undefined {
  return weights.planetCategory[member];
}

/**
 * Strongest relational bonus across the two sides.
 *
 * Ported from themes.js:233-252, which took the MAXIMUM over every pair of
 * categories rather than an average — one personal-generational pairing
 * inside two stelliums carries the whole group.
 */
function bonusBetween(a: CompositeBody, b: CompositeBody, weights: ScoringWeights): number {
  let best = 0;
  for (const memberA of a.members) {
    for (const memberB of b.members) {
      const bonus = relationalBonus(
        categoryOf(memberA, weights),
        categoryOf(memberB, weights),
        weights,
      );
      if (bonus > best) best = bonus;
    }
  }
  return best;
}

/** themes.js:258-275. A lone body scores 1; groups multiply. */
function compositeMultiplier(body: CompositeBody, weights: ScoringWeights): number {
  if (body.type !== 'stellium') return 1;

  let multiplier =
    body.members.length >= 4
      ? weights.stelliumMultiplier.fourPlus
      : weights.stelliumMultiplier.threePlus;

  if (body.members.some((member) => (weights.luminaries as readonly string[]).includes(member))) {
    multiplier *= weights.stelliumMultiplier.luminaryPresent;
  }

  return multiplier;
}

/**
 * themes.js:344-368, verbatim.
 *
 *   base     = importance(aspect) * 100
 *   falloff  = (1 - orbMinutes / 600) ^ 2
 *   score    = (base + relationalBonus) * falloff * multiplierA * multiplierB
 *
 * Note `+ relationalBonus` and not `*`. On a base of 200-500 the largest bonus
 * moves the result by about one percent, where every other factor multiplies.
 * See SCORING_V1.
 */
function scoreStory(input: {
  aspect: AspectId;
  orb: number;
  a: CompositeBody;
  b: CompositeBody;
  weights: ScoringWeights;
}): number {
  const { aspect, orb, a, b, weights } = input;
  const importance = weights.aspectImportance[aspect] ?? 0;
  const base = importance * weights.baseScoreMultiplier;

  const orbMinutes = orb * 60;
  const falloff = Math.pow(1 - orbMinutes / weights.maxOrbMinutes, weights.orbFalloffExponent);

  const bonus = bonusBetween(a, b, weights);
  const multiplier = compositeMultiplier(a, weights) * compositeMultiplier(b, weights);

  return (base + bonus) * falloff * multiplier;
}

export interface StoriesResult {
  readonly composites: readonly CompositeBody[];
  readonly stories: readonly Story[];
}

export interface StoriesOptions {
  /** Which orbs define a story-forming aspect. Defaults to the prototype's natal set. */
  readonly orbPolicy?: OrbPolicyId;
  readonly weights?: ScoringWeights;
}

/**
 * Composite bodies, then the stories between them.
 *
 * Ascendant and Midheaven are excluded as a pair: they are geometrically bound
 * and always in aspect, so the "story" would be an artefact of the coordinate
 * system. The prototype hardcoded the same exclusion at themes.js:315.
 */
export function identifyStories(
  points: readonly AspectPoint[],
  options: StoriesOptions = {},
): StoriesResult {
  const weights = options.weights ?? SCORING_V1;
  const policy = ORB_POLICIES[options.orbPolicy ?? 'natal.v1'];

  const composites = identifyComposites(
    points.map((point) => ({ id: point.id, lon: point.lon })),
    weights.compositeConjunctionOrbDeg,
  );

  const stories: Story[] = [];

  for (let i = 0; i < composites.length; i += 1) {
    for (let j = i + 1; j < composites.length; j += 1) {
      const a = composites[i];
      const b = composites[j];
      if (a === undefined || b === undefined) continue;

      const members = [...a.members, ...b.members];
      if (members.length === 2 && members.includes('ascendant') && members.includes('midheaven')) {
        continue;
      }

      const aspect = aspectBetween(
        { id: a.members.join('+'), lon: a.lon },
        { id: b.members.join('+'), lon: b.lon },
        policy,
      );
      if (aspect === undefined) continue;

      stories.push({
        id: `${a.members.join('+')}|${aspect.aspect}|${b.members.join('+')}`,
        a,
        b,
        aspect: aspect.aspect,
        orb: aspect.orb,
        members,
        score: scoreStory({ aspect: aspect.aspect, orb: aspect.orb, a, b, weights }),
        scoringVersion: weights.version,
      });
    }
  }

  // Highest score first, matching themes.js:405. Ordering only — nothing
  // downstream reads the number.
  stories.sort((x, y) => y.score - x.score);

  return { composites, stories };
}
