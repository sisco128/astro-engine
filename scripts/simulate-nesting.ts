/**
 * Answers one question: does strict nesting produce results, or does it filter
 * everything away?
 *
 * The model is a funnel. A slow contact opens an archetypal window; a social
 * contact inside it gives the outer context; a personal contact inside THAT is
 * the key date. All three must touch the same natal story.
 *
 * Strict containment — the fast body's exact contact falling inside the medium
 * interval, and the medium's inside the slow — is the clean rule. But it may be
 * so restrictive that a chart yields almost nothing over a decade, in which
 * case the rule has to relax to overlap plus an intensity weighting.
 *
 * That is not answerable by reasoning. This measures it.
 *
 * Deliberately coarse: a daily scan is enough to COUNT nestings. Second-level
 * precision is phase 4's job and would not change the count.
 *
 *   pnpm tsx scripts/simulate-nesting.ts [years]
 */

import { aspectsAmong, type AspectPoint } from '../src/domain/aspects.js';
import { identifyComposites } from '../src/domain/composites.js';
import { ORB_POLICIES } from '../src/domain/orb-policy.js';
import { SCORING_V1 } from '../src/domain/scoring-weights.js';
import { DEFAULT_BODIES, type BodyId } from '../src/ephemeris/bodies.js';
import {
  bodyState,
  housesFor,
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../src/ephemeris/swe.js';
import { separation } from '../src/math/angle.js';

setEphemerisPath(process.env['SE_EPHE_PATH'] ?? './ephem');
setForbidFallback(true);

const YEARS = Number(process.argv[2] ?? 30);

/** Tiers, from scripts/measure-timescales.mjs. Saturn sits with Jupiter by decision. */
const TIERS = {
  fast: ['mercury', 'venus', 'sun', 'mars'],
  social: ['jupiter', 'saturn'],
  slow: ['uranus', 'chiron', 'neptune', 'pluto'],
} as const;

type Tier = keyof typeof TIERS;

const TIER_OF = new Map<string, Tier>();
for (const [tier, bodies] of Object.entries(TIERS)) {
  for (const body of bodies) TIER_OF.set(body, tier as Tier);
}

/** Orbs per tier. 1 degree throughout, as the prototype used for activations. */
const ORB = 1;

// --- the natal chart: 12 Aug 1987, 11:32 CEST Rome = 09:32 UT ----------------

const natalJd = jdFromUtc({ year: 1987, month: 8, day: 12, hour: 9, minute: 32 });
const houses = housesFor(natalJd, 41.9028, 12.4964, 'P');

const natalPoints: AspectPoint[] = [
  ...DEFAULT_BODIES.map((id) => {
    const state = bodyState(natalJd, id);
    return { id, lon: state.lon, lonSpeed: state.lonSpeed };
  }),
  { id: 'ascendant', lon: houses.ascendant },
  { id: 'midheaven', lon: houses.midheaven },
];

// --- stories -----------------------------------------------------------------
//
// A story is a grouping of aspects that belong together — the device that keeps
// a chart's aspect list from being noise. Composite bodies first (bodies close
// enough to act as one), then aspects between those composites.

const composites = identifyComposites(
  natalPoints.map((p) => ({ id: p.id, lon: p.lon })),
  SCORING_V1.compositeConjunctionOrbDeg,
);

const compositePoints: AspectPoint[] = composites.map((c) => ({
  id: c.members.join('+'),
  lon: c.lon,
}));

const storyAspects = aspectsAmong(compositePoints, ORB_POLICIES['natal.v1'], [
  ['ascendant', 'midheaven'],
]);

interface Story {
  readonly label: string;
  /** Every natal point belonging to either side. A transit to any of them counts. */
  readonly members: readonly string[];
  readonly lonByMember: ReadonlyMap<string, number>;
}

const stories: Story[] = storyAspects.map((aspect) => {
  const members = [...aspect.a.split('+'), ...aspect.b.split('+')];
  const lonByMember = new Map<string, number>();
  for (const member of members) {
    const point = natalPoints.find((p) => p.id === member);
    if (point !== undefined) lonByMember.set(member, point.lon);
  }
  return { label: `${aspect.a} ${aspect.aspect} ${aspect.b}`, members, lonByMember };
});

console.log(`Chart: 1987-08-12 09:32 UT, Rome`);
console.log(`Composite bodies: ${String(composites.length)}`);
console.log(`Stories: ${String(stories.length)}\n`);
for (const story of stories) console.log(`  ${story.label}`);

// --- transit scan ------------------------------------------------------------

const ASPECT_ANGLES = [0, 60, 90, 120, 180];
const START = natalJd + 365 * 20; // from age 20
const DAYS = YEARS * 365;

interface Interval {
  readonly body: string;
  readonly tier: Tier;
  readonly storyIndex: number;
  readonly member: string;
  readonly angle: number;
  start: number;
  end: number;
  /** Day of closest approach — stands in for the exact contact. */
  peak: number;
  peakOrb: number;
}

const open = new Map<string, Interval>();
const intervals: Interval[] = [];
const allTransiting = [...TIERS.fast, ...TIERS.social, ...TIERS.slow] as BodyId[];

for (let d = 0; d < DAYS; d += 1) {
  const jd = (START + d) as JulianDayUT;

  for (const body of allTransiting) {
    let state;
    try {
      state = bodyState(jd, body);
    } catch {
      continue;
    }

    for (const [storyIndex, story] of stories.entries()) {
      for (const [member, natalLon] of story.lonByMember) {
        for (const angle of ASPECT_ANGLES) {
          const orb = Math.abs(separation(state.lon, natalLon) - angle);
          const key = `${body}|${String(storyIndex)}|${member}|${String(angle)}`;
          const existing = open.get(key);

          if (orb <= ORB) {
            if (existing === undefined) {
              open.set(key, {
                body,
                tier: TIER_OF.get(body) ?? 'fast',
                storyIndex,
                member,
                angle,
                start: d,
                end: d,
                peak: d,
                peakOrb: orb,
              });
            } else {
              existing.end = d;
              if (orb < existing.peakOrb) {
                existing.peak = d;
                existing.peakOrb = orb;
              }
            }
          } else if (existing !== undefined) {
            intervals.push(existing);
            open.delete(key);
          }
        }
      }
    }
  }
}
for (const interval of open.values()) intervals.push(interval);

const byTier = (tier: Tier): Interval[] => intervals.filter((i) => i.tier === tier);

console.log(`\nScan: ${String(YEARS)} years from age 20, 1 degree orb\n`);
console.log(`  slow intervals   ${String(byTier('slow').length)}`);
console.log(`  social intervals ${String(byTier('social').length)}`);
console.log(`  fast intervals   ${String(byTier('fast').length)}`);

// --- nesting -----------------------------------------------------------------

const contains = (outer: Interval, instant: number): boolean =>
  instant >= outer.start && instant <= outer.end;

const overlaps = (a: Interval, b: Interval): boolean => a.start <= b.end && b.start <= a.end;

interface Result {
  strictPaths: number;
  overlapPaths: number;
  storiesWithPath: Set<number>;
  examples: string[];
}

const result: Result = {
  strictPaths: 0,
  overlapPaths: 0,
  storiesWithPath: new Set(),
  examples: [],
};

/** Variants to compare, each a further constraint on top of strict nesting. */
const variants = {
  sameStory: 0,
  sameMember: 0,
  sameMemberSlowConj: 0,
  sameMemberClustered: new Set<string>(),
};

for (const slow of byTier('slow')) {
  for (const social of byTier('social')) {
    if (social.storyIndex !== slow.storyIndex) continue;

    const socialStrict = contains(slow, social.peak);
    const socialOverlap = overlaps(slow, social);
    if (!socialOverlap) continue;

    for (const fast of byTier('fast')) {
      if (fast.storyIndex !== slow.storyIndex) continue;

      if (socialOverlap && overlaps(social, fast)) result.overlapPaths += 1;

      if (socialStrict && contains(social, fast.peak)) {
        variants.sameStory += 1;
        const sameMember = fast.member === social.member && social.member === slow.member;
        if (sameMember) {
          variants.sameMember += 1;
          if (slow.angle === 0) variants.sameMemberSlowConj += 1;
          // Cluster near-duplicates: several fast bodies hitting the same
          // member within a few days is one key date, not four.
          variants.sameMemberClustered.add(
            `${String(slow.storyIndex)}|${slow.member}|${String(Math.round(fast.peak / 5))}`,
          );
        }
        result.strictPaths += 1;
        result.storiesWithPath.add(slow.storyIndex);
        if (result.examples.length < 8) {
          const year = 1987 + Math.floor((20 * 365 + fast.peak) / 365);
          result.examples.push(
            `${String(year)}  ${fast.body} ${String(fast.angle)} ${fast.member}  <  ` +
              `${social.body} ${String(social.angle)} ${social.member}  <  ` +
              `${slow.body} ${String(slow.angle)} ${slow.member}   [${stories[slow.storyIndex]?.label ?? ''}]`,
          );
        }
      }
    }
  }
}

console.log(`\n--- nesting, same story required at all three levels ---\n`);
console.log(`  strict  (exact instant inside the interval above)   ${String(result.strictPaths)}`);
console.log(`  relaxed (intervals merely overlap)                  ${String(result.overlapPaths)}`);
console.log(
  `  stories reached by at least one strict path        ${String(result.storiesWithPath.size)} / ${String(stories.length)}`,
);
console.log(
  `  strict key dates per year                          ${(result.strictPaths / YEARS).toFixed(1)}`,
);

console.log(`\n--- quanto stringe ogni vincolo aggiuntivo ---\n`);
const perYear = (n: number): string => `${(n / YEARS).toFixed(1)}/anno`;
console.log(
  `  stessa storia (attuale)              ${String(variants.sameStory).padStart(6)}   ${perYear(variants.sameStory)}`,
);
console.log(
  `  + stesso punto natale                ${String(variants.sameMember).padStart(6)}   ${perYear(variants.sameMember)}`,
);
console.log(
  `  + lento solo in congiunzione         ${String(variants.sameMemberSlowConj).padStart(6)}   ${perYear(variants.sameMemberSlowConj)}`,
);
console.log(
  `  + raggruppate a 5 giorni             ${String(variants.sameMemberClustered.size).padStart(6)}   ${perYear(variants.sameMemberClustered.size)}`,
);

if (result.examples.length > 0) {
  console.log(`\n  first strict paths:\n`);
  for (const example of result.examples) console.log(`    ${example}`);
}
