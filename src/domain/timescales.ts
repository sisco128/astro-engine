/**
 * Timescale tiers: which bodies open windows, which give context, which
 * trigger.
 *
 * The prototype assigned tiers BY PLANET NAME — Layer 1 was
 * ['Uranus','Neptune'], Layer 2 was ['Mars','Jupiter','Saturn'] — with one
 * activation window of 30 days for all of them. Measurement (see
 * scripts/measure-timescales.mjs, reproducible) says the naming does not
 * follow the physics:
 *
 *   body      deg/day  retro%   contact   full window
 *   mercury     1.217    19.2        1g   —
 *   venus       1.043     7.1        2g   —
 *   sun         0.986     0.0        2g   —
 *   mars        0.566     9.4        3g   —
 *   jupiter     0.133    30.1       14g   240g (2 passes)
 *   saturn      0.070    36.3       17g   277g (2 passes)
 *   uranus      0.034    40.7       49g   330g (3 passes)
 *   chiron      0.048    39.8      105g   1.7a (3 passes)
 *   neptune     0.021    43.0      125g   1.8a (3 passes)
 *   pluto       0.018    44.5      129g   2.7a (4 passes)
 *
 * Uranus and Neptune shared a tier, yet their contacts last 49 and 125 days.
 * Uranus and SATURN last 49 and 17 by median — but 47 and 46 by mean, because
 * Saturn's distribution is skewed. Either way the prototype's cut does not
 * match any statistic.
 *
 * Speed alone does not predict this: Saturn moves twice as fast as Uranus and
 * retrogrades in a way that partly compensates. That is why the thresholds are
 * measured rather than reasoned about.
 */

import type { BodyId } from '../ephemeris/bodies.js';
import type { AspectId } from './orb-policy.js';

export const TIER_IDS = ['fast', 'social', 'slow'] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface TierMeta {
  /** What this tier does in the funnel. Interpretation lives in clients; this is orientation. */
  readonly role: string;
  /** Typical contact duration in days, measured. */
  readonly contactDays: readonly [number, number];
  /** Bodies available at this tier. A request may use any subset. */
  readonly available: readonly BodyId[];
}

export const TIERS: Readonly<Record<TierId, TierMeta>> = {
  fast: {
    role: 'The personal planet. Dates the event — short enough contacts to pin a day.',
    contactDays: [1, 3],
    available: ['mercury', 'venus', 'sun', 'mars'],
  },
  social: {
    role: 'The social context around the archetype.',
    contactDays: [14, 17],
    available: ['jupiter', 'saturn'],
  },
  slow: {
    role: 'The archetype. Opens the window, for months or years.',
    contactDays: [49, 129],
    available: ['uranus', 'chiron', 'neptune', 'pluto'],
  },
};

/**
 * Saturn sits with Jupiter BY DECISION, not by measurement.
 *
 * The data puts it exactly between: Jupiter 14d, Saturn 17d, Uranus 49d by
 * median — or 9 / 20 / 47 over a 120-year window. Each step is roughly 2.3x,
 * and no gap isolates Saturn either way. Placing it is an astrological
 * judgement and is recorded here as one so nobody later mistakes it for a
 * threshold that fell out of the numbers.
 */
export const SATURN_PLACEMENT_IS_A_JUDGEMENT = true;

/**
 * Excluded from the transiting set, each for a measured reason:
 *
 *   Moon    3.6-hour contacts, 801 of them in 60 years. Real, and it would
 *           bury every other body. Revisit as an opt-in tier of its own.
 *   Node    retrograde 74% of the time; it does not behave like the others.
 *   Lilith  a mean point, not an osculating body: 0% retrograde and every
 *           contact exactly 18 days. The regularity is an artefact of the
 *           definition, not a property of a moving thing.
 */
export const EXCLUDED_BODIES = ['moon', 'trueNode', 'meanNode', 'lilith'] as const;

/** Which tier a body belongs to, or undefined if it is not a transiting body here. */
export function tierOf(body: BodyId): TierId | undefined {
  for (const tier of TIER_IDS) {
    if (TIERS[tier].available.includes(body)) return tier;
  }
  return undefined;
}

// --- funnel configuration ----------------------------------------------------

export interface TierConfig {
  readonly bodies: readonly BodyId[];
  readonly aspects: readonly AspectId[];
  readonly orbDeg: number;
}

export type NestingRule =
  /** All three levels must touch the same natal story. */
  | 'same-story'
  /** All three must touch the same natal point. Much stricter — see the note below. */
  | 'same-point';

export interface FunnelConfig {
  readonly slow: TierConfig;
  readonly social: TierConfig;
  readonly fast: TierConfig;
  readonly nesting: NestingRule;
  /** Contacts on the same story within this many days are one key window. */
  readonly clusterDays: number;
}

const HARD_ASPECTS: readonly AspectId[] = ['conjunction', 'square', 'opposition'];
const ALL_ASPECTS: readonly AspectId[] = [
  'conjunction',
  'sextile',
  'square',
  'trine',
  'opposition',
];

/**
 * The default, tuned against a stated target of one to two key windows per
 * quarter.
 *
 * Measured on the 1987-08-12 Rome chart over 30 years: **1.67 windows per
 * quarter, 61 distinct path shapes.**
 *
 * The tuning result worth knowing: the noise was NOT Pluto and Chiron. It was
 * the soft aspects at the slow tier. Dropping trine and sextile there — and
 * only there — lowers density enough to admit both bodies at a 1-degree orb.
 * The prototype removed bodies instead, which paid the wrong bill: the slow
 * tier multiplies, because its windows last months and each opening hosts
 * dozens of faster events.
 *
 * Restricting aspects BELOW the slow tier was measured and rejected: keeping
 * all five at social and fast gives both the highest in-target density (1.67
 * against 1.05 or 0.74) and the most interpretive variety (61 path shapes
 * against 37 or 36). Every restriction downstream loses nuance without
 * buying volume.
 */
export const FUNNEL_DEFAULT: FunnelConfig = {
  slow: {
    bodies: ['uranus', 'chiron', 'neptune', 'pluto'],
    aspects: HARD_ASPECTS,
    orbDeg: 1,
  },
  social: {
    bodies: ['jupiter', 'saturn'],
    aspects: ALL_ASPECTS,
    orbDeg: 1,
  },
  fast: {
    bodies: ['mars'],
    aspects: ALL_ASPECTS,
    orbDeg: 1,
  },
  nesting: 'same-story',
  clusterDays: 5,
};

/**
 * The prototype's configuration, for comparison.
 *
 * Measured: **1.90 windows per quarter** — inside the same target. The
 * prototype's empirical tuning was correct for the rule it used. This preset
 * exists so results stay comparable with what was seen before the rewrite,
 * not because it is worse.
 */
export const FUNNEL_PROTOTYPE: FunnelConfig = {
  slow: { bodies: ['uranus', 'neptune'], aspects: ALL_ASPECTS, orbDeg: 1 },
  social: { bodies: ['jupiter', 'saturn'], aspects: ALL_ASPECTS, orbDeg: 1 },
  fast: { bodies: ['mars'], aspects: ALL_ASPECTS, orbDeg: 1 },
  nesting: 'same-story',
  clusterDays: 5,
};

/**
 * Full body coverage under the strict rule.
 *
 * Also 1.90 per quarter — the same density by the opposite route. Bodies and
 * the nesting rule are the same knob: loosening one requires tightening the
 * other. Offered so a client can make that trade deliberately.
 */
export const FUNNEL_STRICT: FunnelConfig = {
  slow: { bodies: ['uranus', 'chiron', 'neptune', 'pluto'], aspects: ALL_ASPECTS, orbDeg: 1 },
  social: { bodies: ['jupiter', 'saturn'], aspects: ALL_ASPECTS, orbDeg: 1 },
  fast: { bodies: ['mercury', 'venus', 'sun', 'mars'], aspects: ALL_ASPECTS, orbDeg: 1 },
  nesting: 'same-point',
  clusterDays: 5,
};

export const FUNNEL_PRESETS = {
  'funnel.default': FUNNEL_DEFAULT,
  'funnel.prototype': FUNNEL_PROTOTYPE,
  'funnel.strict': FUNNEL_STRICT,
} as const;

export type FunnelPresetId = keyof typeof FUNNEL_PRESETS;

export const FUNNEL_PRESET_IDS = Object.keys(FUNNEL_PRESETS) as FunnelPresetId[];

/** Measured density of each preset on the reference chart, windows per quarter. */
export const PRESET_MEASURED_DENSITY: Readonly<Record<FunnelPresetId, number>> = {
  'funnel.default': 1.67,
  'funnel.prototype': 1.9,
  'funnel.strict': 1.9,
};
