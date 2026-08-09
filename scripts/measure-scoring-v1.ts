/**
 * Answers, with numbers, the three questions SCORING_V1 was carrying as
 * suspicions.
 *
 * v1's contract is to reproduce the prototype's results, so nothing here
 * changes v1. What it does is measure what WOULD change, which is the only way
 * to say whether the three documented accidents are cosmetic or load-bearing:
 *
 *   1. the orb falloff divides by a flat 600 arcminutes for every aspect,
 *      although only the conjunction's own orb is 10 degrees;
 *   2. the relational bonus is ADDED to a base of 200-500 where every other
 *      factor multiplies;
 *   3. `aspectImportance.conjunction` is the highest weight in the table and
 *      looks unreachable.
 *
 * Method. For each birth instant, build the natal points exactly as
 * tests/golden/funnel.golden.test.ts does, run identifyStories, then re-score
 * the SAME stories under each variant and re-sort. Re-scoring rather than
 * re-deriving is the right move and not a shortcut: story membership is decided
 * by identifyComposites and the orb policy before any scoring runs, so no
 * weight can add or remove a story — only move it. The table reports set
 * identity anyway rather than asserting it in prose.
 *
 * The variant formulas are re-implemented here from themes.js:344-368 because
 * themes.ts exposes no hook for swapping one factor. The self-check is what
 * keeps the re-implementation honest: variant (a) must reproduce
 * identifyStories' own v1 score for every story of every chart, or the script
 * refuses to print a table.
 *
 *   SE_EPHE_PATH=/absolute/path/to/ephem pnpm tsx scripts/measure-scoring-v1.ts
 *   ... --fixtures    also dump the natal longitudes as a TypeScript literal,
 *                     which is where tests/unit/themes.test.ts got its charts
 */

import type { AspectPoint } from '../src/domain/aspects.js';
import type { CompositeBody } from '../src/domain/composites.js';
import { orbPolicy, type AspectId } from '../src/domain/orb-policy.js';
import { relationalBonus, SCORING_V1 } from '../src/domain/scoring-weights.js';
import { identifyStories, type Story } from '../src/domain/themes.js';
import { DEFAULT_BODIES } from '../src/ephemeris/bodies.js';
import {
  bodyState,
  housesFor,
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
} from '../src/ephemeris/swe.js';
import { separation } from '../src/math/angle.js';

setEphemerisPath(process.env['SE_EPHE_PATH'] ?? './ephem');
setForbidFallback(true);

const DUMP_FIXTURES = process.argv.includes('--fixtures');

// --- the sample --------------------------------------------------------------
//
// The 1987 reference chart plus nine more, spread across nine decades and both
// hemispheres. Spread matters because the accidents act on geometry: a chart
// whose aspects all sit near-exact would show nothing, and one crowded with
// stelliums exercises multipliers the reference chart barely uses. Latitudes
// stay under 66 degrees so Placidus is defined everywhere.

interface Birth {
  readonly label: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** UT, not local. */
  readonly hour: number;
  readonly minute: number;
  readonly latitude: number;
  readonly longitude: number;
}

const CHARTS: readonly Birth[] = [
  {
    label: 'Rome 1987',
    year: 1987,
    month: 8,
    day: 12,
    hour: 9,
    minute: 32,
    latitude: 41.9028,
    longitude: 12.4964,
  },
  {
    label: 'Berlin 1934',
    year: 1934,
    month: 5,
    day: 19,
    hour: 4,
    minute: 8,
    latitude: 52.52,
    longitude: 13.405,
  },
  {
    label: 'Buenos Aires 1952',
    year: 1952,
    month: 3,
    day: 4,
    hour: 21,
    minute: 15,
    latitude: -34.6037,
    longitude: -58.3816,
  },
  {
    label: 'Sao Paulo 1961',
    year: 1961,
    month: 12,
    day: 2,
    hour: 11,
    minute: 55,
    latitude: -23.5505,
    longitude: -46.6333,
  },
  {
    label: 'Tokyo 1969',
    year: 1969,
    month: 11,
    day: 27,
    hour: 3,
    minute: 48,
    latitude: 35.6895,
    longitude: 139.6917,
  },
  {
    label: 'Delhi 1978',
    year: 1978,
    month: 7,
    day: 15,
    hour: 22,
    minute: 3,
    latitude: 28.6139,
    longitude: 77.209,
  },
  {
    label: 'New York 1996',
    year: 1996,
    month: 6,
    day: 21,
    hour: 14,
    minute: 5,
    latitude: 40.7128,
    longitude: -74.006,
  },
  {
    label: 'Nairobi 2004',
    year: 2004,
    month: 1,
    day: 9,
    hour: 7,
    minute: 20,
    latitude: -1.2921,
    longitude: 36.8219,
  },
  {
    label: 'Reykjavik 2011',
    year: 2011,
    month: 10,
    day: 30,
    hour: 18,
    minute: 44,
    latitude: 64.1466,
    longitude: -21.9426,
  },
  {
    label: 'Sydney 2018',
    year: 2018,
    month: 4,
    day: 6,
    hour: 23,
    minute: 27,
    latitude: -33.8688,
    longitude: 151.2093,
  },
];

function natalPointsFor(birth: Birth): AspectPoint[] {
  const jd = jdFromUtc({
    year: birth.year,
    month: birth.month,
    day: birth.day,
    hour: birth.hour,
    minute: birth.minute,
  });
  const houses = housesFor(jd, birth.latitude, birth.longitude, 'P');

  return [
    ...DEFAULT_BODIES.map((id) => ({ id, lon: bodyState(jd, id).lon })),
    { id: 'ascendant', lon: houses.ascendant },
    { id: 'midheaven', lon: houses.midheaven },
  ];
}

// --- the v1 formula, with one factor swappable -------------------------------
//
//   base    = importance(aspect) * 100
//   falloff = (1 - orbMinutes / maxOrbMinutes) ^ 2
//   score   = (base + bonus) * falloff * multiplierA * multiplierB

/** Which denominator the falloff divides by. */
type Falloff = 'flat600' | 'perAspect';

/**
 * How the relational bonus enters.
 *
 * 'none' drops it, which is the sharpest test of whether an additive bonus of
 * 1..5 on a base of 200-500 does anything at all.
 *
 * 'multiply' is the literal typo hypothesis — `*` where `+` was typed. It is
 * brutal, because the bonus is 0 for any pair involving a body absent from
 * planetCategory (Pluto, the true node, Chiron), which zeroes the story
 * outright. 'multiplyScaled' is the charitable reading, mapping the same 1..5
 * ranks onto [1.0, 1.5] the way scoring-v2 does. Both are measured; they answer
 * different questions and only one of them is a strawman.
 */
type BonusMode = 'add' | 'none' | 'multiply' | 'multiplyScaled';

// Via orbPolicy() rather than ORB_POLICIES directly: the literal type of the
// table only carries the four aspects it defines, and this needs to answer for
// any AspectId a story could carry.
const NATAL_V1 = orbPolicy('natal.v1');

function maxOrbMinutesFor(aspect: AspectId, falloff: Falloff): number {
  if (falloff === 'flat600') return SCORING_V1.maxOrbMinutes;
  return (NATAL_V1[aspect] ?? 10) * 60;
}

/** themes.js:233-252: the MAXIMUM over category pairs, not an average. */
function bonusBetween(a: CompositeBody, b: CompositeBody): number {
  let best = 0;
  for (const memberA of a.members) {
    for (const memberB of b.members) {
      const bonus = relationalBonus(
        SCORING_V1.planetCategory[memberA],
        SCORING_V1.planetCategory[memberB],
      );
      if (bonus > best) best = bonus;
    }
  }
  return best;
}

/** themes.js:258-275. */
function compositeMultiplier(body: CompositeBody): number {
  if (body.type !== 'stellium') return 1;

  let multiplier =
    body.members.length >= 4
      ? SCORING_V1.stelliumMultiplier.fourPlus
      : SCORING_V1.stelliumMultiplier.threePlus;

  if (
    body.members.some((member) => (SCORING_V1.luminaries as readonly string[]).includes(member))
  ) {
    multiplier *= SCORING_V1.stelliumMultiplier.luminaryPresent;
  }

  return multiplier;
}

/** The bonus term, under each reading of what it was meant to be. */
function weightedBase(base: number, bonus: number, mode: BonusMode): number {
  switch (mode) {
    case 'add':
      return base + bonus;
    case 'none':
      return base;
    case 'multiply':
      return base * bonus;
    case 'multiplyScaled':
      // Ranks run 1..5; map onto [1.0, 1.5], as scoring-v2 does. A bonus of 0
      // means a body with no category, which scoring-v2 treats as rank 1.
      return base * (1 + ((Math.max(bonus, 1) - 1) / 4) * 0.5);
  }
}

function scoreVariant(story: Story, falloff: Falloff, bonusMode: BonusMode): number {
  const importance = SCORING_V1.aspectImportance[story.aspect] ?? 0;
  const base = importance * SCORING_V1.baseScoreMultiplier;

  const orbMinutes = story.orb * 60;
  const denominator = maxOrbMinutesFor(story.aspect, falloff);
  // A per-aspect denominator can be exceeded — a trine at 7 degrees against a
  // 7-degree orb lands exactly at 0 — but never overshot into a negative base
  // raised to an even power, which would score a far aspect as if it were near.
  const decay = Math.pow(Math.max(0, 1 - orbMinutes / denominator), SCORING_V1.orbFalloffExponent);

  const bonus = bonusBetween(story.a, story.b);
  const multiplier = compositeMultiplier(story.a) * compositeMultiplier(story.b);

  return weightedBase(base, bonus, bonusMode) * decay * multiplier;
}

// --- comparing two rankings --------------------------------------------------

interface Ranking {
  /** Story ids, strongest first. */
  readonly order: readonly string[];
  readonly scoreById: ReadonlyMap<string, number>;
}

function rank(stories: readonly Story[], score: (story: Story) => number): Ranking {
  const scoreById = new Map<string, number>();
  for (const story of stories) scoreById.set(story.id, score(story));

  // Sort a copy, matching themes.ts: highest first, stable on ties.
  const order = [...stories]
    .sort((x, y) => (scoreById.get(y.id) ?? 0) - (scoreById.get(x.id) ?? 0))
    .map((story) => story.id);

  return { order, scoreById };
}

interface Comparison {
  readonly sameSet: boolean;
  readonly sameRanking: boolean;
  readonly topSame: boolean;
  /** Largest distance any story moved in the ordering. */
  readonly maxRankShift: number;
  /** Fraction of story pairs whose relative order flipped. */
  readonly inversionRate: number;
  /** max |variant - baseline| / baseline. undefined when the scales differ. */
  readonly maxRelativeDelta: number | undefined;
}

function positions(order: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  order.forEach((id, index) => map.set(id, index));
  return map;
}

function compare(baseline: Ranking, variant: Ranking, comparableScale: boolean): Comparison {
  const basePos = positions(baseline.order);
  const variantPos = positions(variant.order);

  const sameSet =
    baseline.order.length === variant.order.length &&
    baseline.order.every((id) => variantPos.has(id));

  let maxRankShift = 0;
  for (const [id, index] of basePos) {
    const moved = Math.abs((variantPos.get(id) ?? index) - index);
    if (moved > maxRankShift) maxRankShift = moved;
  }

  let inversions = 0;
  let pairs = 0;
  for (let i = 0; i < baseline.order.length; i += 1) {
    for (let j = i + 1; j < baseline.order.length; j += 1) {
      const a = baseline.order[i];
      const b = baseline.order[j];
      if (a === undefined || b === undefined) continue;
      pairs += 1;
      if ((variantPos.get(a) ?? 0) > (variantPos.get(b) ?? 0)) inversions += 1;
    }
  }

  let maxRelativeDelta: number | undefined;
  if (comparableScale) {
    let worst = 0;
    for (const [id, base] of baseline.scoreById) {
      const other = variant.scoreById.get(id) ?? 0;
      // A baseline of exactly 0 needs a conjunction at exactly 10 degrees,
      // which is unreachable; guard anyway rather than print Infinity.
      const relative = base === 0 ? (other === 0 ? 0 : Infinity) : Math.abs(other - base) / base;
      if (relative > worst) worst = relative;
    }
    maxRelativeDelta = worst;
  }

  const sameRanking =
    baseline.order.length === variant.order.length &&
    baseline.order.every((id, index) => variant.order[index] === id);

  return {
    sameSet,
    sameRanking,
    topSame: baseline.order[0] === variant.order[0],
    maxRankShift,
    inversionRate: pairs === 0 ? 0 : inversions / pairs,
    maxRelativeDelta,
  };
}

// --- geometry behind the conjunction claim -----------------------------------

/** Angular width of a composite: 360 minus its largest internal gap. */
function compositeSpan(body: CompositeBody, points: readonly AspectPoint[]): number {
  const longitudes = body.members
    .map((member) => points.find((point) => point.id === member)?.lon)
    .filter((lon): lon is number => lon !== undefined)
    .sort((a, b) => a - b);

  if (longitudes.length < 2) return 0;

  let largestGap = 0;
  for (let i = 0; i < longitudes.length; i += 1) {
    const here = longitudes[i] ?? 0;
    const next = longitudes[(i + 1) % longitudes.length] ?? 0;
    const gap = i === longitudes.length - 1 ? next + 360 - here : next - here;
    if (gap > largestGap) largestGap = gap;
  }
  return 360 - largestGap;
}

/** Smallest separation between any two composite means, in degrees. */
function closestCompositePair(composites: readonly CompositeBody[]): number {
  let closest = Infinity;
  for (let i = 0; i < composites.length; i += 1) {
    for (let j = i + 1; j < composites.length; j += 1) {
      const a = composites[i];
      const b = composites[j];
      if (a === undefined || b === undefined) continue;
      const gap = separation(a.lon, b.lon);
      if (gap < closest) closest = gap;
    }
  }
  return closest;
}

// --- run ---------------------------------------------------------------------

interface Variant {
  readonly key: string;
  readonly label: string;
  readonly falloff: Falloff;
  readonly bonus: BonusMode;
}

const VARIANTS: readonly Variant[] = [
  { key: 'a0', label: 'bonus removed', falloff: 'flat600', bonus: 'none' },
  { key: 'b', label: 'per-aspect falloff', falloff: 'perAspect', bonus: 'add' },
  { key: 'c', label: 'bonus x, literal', falloff: 'flat600', bonus: 'multiply' },
  { key: "c'", label: 'bonus x, scaled', falloff: 'flat600', bonus: 'multiplyScaled' },
];

const KEYS = [...VARIANTS.map((variant) => variant.key), 'd'];

function labelFor(key: string): string {
  if (key === 'd') return 'scoring-v2';
  return VARIANTS.find((variant) => variant.key === key)?.label ?? key;
}

interface ChartRow {
  readonly label: string;
  readonly storyCount: number;
  readonly comparisons: ReadonlyMap<string, Comparison>;
  readonly conjunctionStories: number;
  readonly maxCompositeSpan: number;
  readonly closestCompositePair: number;
  readonly topStoryV1: string;
  readonly topStoryV2: string;
}

const rows: ChartRow[] = [];
const fixtures: string[] = [];
let selfCheckWorst = 0;
/** Largest share of a v1 score that the additive bonus actually accounts for. */
let bonusShareWorst = 0;
let storiesTotal = 0;
let storiesWithoutBonus = 0;

for (const birth of CHARTS) {
  const points = natalPointsFor(birth);
  const v1 = identifyStories(points, { scoring: 'v1' });
  const v2 = identifyStories(points, { scoring: 'v2' });

  for (const story of v1.stories) {
    // Self-check: the re-implemented v1 must reproduce the engine's own number.
    const mine = scoreVariant(story, 'flat600', 'add');
    const delta = Math.abs(mine - story.score);
    if (delta > selfCheckWorst) selfCheckWorst = delta;

    const bonus = bonusBetween(story.a, story.b);
    const base = (SCORING_V1.aspectImportance[story.aspect] ?? 0) * SCORING_V1.baseScoreMultiplier;
    const share = bonus / (base + bonus);
    if (share > bonusShareWorst) bonusShareWorst = share;
    storiesTotal += 1;
    if (bonus === 0) storiesWithoutBonus += 1;
  }

  const baseline = rank(v1.stories, (story) => story.score);
  const comparisons = new Map<string, Comparison>();

  for (const variant of VARIANTS) {
    const ranked = rank(v1.stories, (story) => scoreVariant(story, variant.falloff, variant.bonus));
    comparisons.set(variant.key, compare(baseline, ranked, true));
  }

  // v2 lives on a different scale entirely (0..~1 against 0..400), so a
  // relative score delta would be a number about nothing. Ranking is the only
  // honest comparison.
  const v2Ranking = rank(v2.stories, (story) => story.score);
  comparisons.set('d', compare(baseline, v2Ranking, false));

  rows.push({
    label: birth.label,
    storyCount: v1.stories.length,
    comparisons,
    conjunctionStories: v1.stories.filter((story) => story.aspect === 'conjunction').length,
    maxCompositeSpan: Math.max(...v1.composites.map((body) => compositeSpan(body, points))),
    closestCompositePair: closestCompositePair(v1.composites),
    topStoryV1: baseline.order[0] ?? '-',
    topStoryV2: v2Ranking.order[0] ?? '-',
  });

  if (DUMP_FIXTURES) {
    const numbers = points.map((point) => point.lon.toFixed(6)).join(', ');
    fixtures.push(`  // ${birth.label}\n  [${numbers}],`);
  }
}

if (selfCheckWorst > 1e-9) {
  throw new Error(
    `Re-implemented v1 diverges from identifyStories by ${selfCheckWorst.toExponential(3)}. ` +
      `Every number below would be measuring the wrong formula.`,
  );
}

const pad = (text: string, width: number): string => text.padEnd(width);
const padStart = (text: string, width: number): string => text.padStart(width);
const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

console.log(`v1 scoring accidents, measured on ${String(CHARTS.length)} charts`);
console.log(
  `self-check: re-implemented v1 matches identifyStories to ${selfCheckWorst.toExponential(1)}\n`,
);

console.log('  (a)  v1 as it is               baseline');
console.log('  (a0) relational bonus removed  base alone, to see whether the bonus does anything');
console.log("  (b)  per-aspect orb falloff    (1 - orb/ownOrb)^2 instead of (1 - orb/600')^2");
console.log('  (c)  bonus multiplied          base * bonus, the literal typo hypothesis');
console.log("  (c') bonus multiplied, scaled  base * (1 + (rank-1)/8), as scoring-v2 does it");
console.log('  (d)  scoring-v2                the corrected default\n');

const HEAD: readonly (readonly [string, number])[] = [
  ['chart', 20],
  ['stories', 9],
  ['variant', 24],
  ['set', 6],
  ['rank', 7],
  ['top', 7],
  ['maxShift', 10],
  ['inv%', 7],
  ['maxDelta', 10],
];

console.log(HEAD.map(([title, width]) => pad(title, width)).join(''));
console.log(HEAD.map(([, width]) => `${'-'.repeat(width - 1)} `).join(''));

const sameOrMoved = (value: boolean): string => (value ? 'same' : 'MOVED');

for (const row of rows) {
  let first = true;
  for (const key of KEYS) {
    const comparison = row.comparisons.get(key);
    if (comparison === undefined) continue;

    console.log(
      [
        pad(first ? row.label : '', 20),
        `${padStart(first ? String(row.storyCount) : '', 8)} `,
        pad(`(${key}) ${labelFor(key)}`, 24),
        pad(comparison.sameSet ? 'same' : 'DIFF', 6),
        pad(sameOrMoved(comparison.sameRanking), 7),
        pad(sameOrMoved(comparison.topSame), 7),
        `${padStart(String(comparison.maxRankShift), 9)} `,
        `${padStart((comparison.inversionRate * 100).toFixed(1), 6)} `,
        `${padStart(
          comparison.maxRelativeDelta === undefined ? 'n/a' : percent(comparison.maxRelativeDelta),
          9,
        )} `,
      ].join(''),
    );
    first = false;
  }
}

// --- totals ------------------------------------------------------------------

console.log('');
for (const key of KEYS) {
  const all = rows
    .map((row) => row.comparisons.get(key))
    .filter((comparison): comparison is Comparison => comparison !== undefined);

  const rankingsMoved = all.filter((comparison) => !comparison.sameRanking).length;
  const topsMoved = all.filter((comparison) => !comparison.topSame).length;
  const worstShift = all.reduce((worst, c) => Math.max(worst, c.maxRankShift), 0);
  const worstDelta = all.reduce((worst, c) => Math.max(worst, c.maxRelativeDelta ?? 0), 0);
  const scaleComparable = all.every((c) => c.maxRelativeDelta !== undefined);

  console.log(
    pad(`(${key})`, 6) +
      pad(labelFor(key), 24) +
      `rankings changed ${String(rankingsMoved)}/${String(all.length)}   ` +
      `top story changed ${String(topsMoved)}/${String(all.length)}   ` +
      `worst rank shift ${String(worstShift)}   ` +
      `worst score delta ${scaleComparable ? percent(worstDelta) : 'n/a'}`,
  );
}

console.log(
  `\nadditive bonus, as v1 actually applies it: at most ${percent(bonusShareWorst)} of a story's ` +
    `score;\n${String(storiesWithoutBonus)} of ${String(storiesTotal)} stories get no bonus at all ` +
    `(Pluto, the true node and Chiron have no category).`,
);

// --- the conjunction entry ---------------------------------------------------

console.log(`\n--- aspectImportance.conjunction: is it reachable? ---\n`);
console.log(
  pad('chart', 20) +
    padStart('conj stories', 13) +
    padStart('widest composite', 18) +
    padStart('closest pair', 14),
);
for (const row of rows) {
  console.log(
    pad(row.label, 20) +
      padStart(String(row.conjunctionStories), 13) +
      padStart(`${row.maxCompositeSpan.toFixed(1)} deg`, 18) +
      padStart(`${row.closestCompositePair.toFixed(1)} deg`, 14),
  );
}

/**
 * The structural argument, then the construction that bounds it.
 *
 * Fusion joins points within 10 degrees transitively, so composites occupy
 * disjoint arcs separated by gaps STRICTLY wider than 10 degrees. A composite's
 * `lon` is the circular mean of its members, which for a set inside an arc
 * narrower than 180 degrees lies inside that arc. Every route between two arcs
 * crosses a gap, so two composite means are always more than 10 degrees apart,
 * and `aspectBetween` — whose conjunction orb is 10 — cannot return one.
 *
 * The span bound is what makes this hold for charts: 14 natal points chained at
 * most 10 degrees apart span at most 130 degrees. It stops holding for a point
 * set large enough for a composite to wrap past 180 degrees with its mass at
 * both ends, where the circular mean escapes its own arc and lands in the empty
 * gap. identifyStories is exported and accepts any points, so that case is
 * constructed here rather than argued about.
 */
function conjunctionCounterexample(): { pointCount: number; found: number } {
  const points: AspectPoint[] = [];
  let index = 0;
  const add = (lon: number): void => {
    points.push({ id: `p${String(index)}`, lon });
    index += 1;
  };

  // One composite with its mass at 0 and at 270, chained through the middle at
  // 10-degree steps so it stays a single group. Equal masses put the resultant
  // at 315 — inside the empty gap, not inside the 0..270 arc it came from.
  for (let i = 0; i < 120; i += 1) add(0);
  for (let i = 0; i < 120; i += 1) add(270);
  for (let lon = 10; lon < 270; lon += 10) add(lon);

  // A second composite parked in that gap, near where the first one's mean
  // landed. Its own arc is nowhere near the first's.
  add(318);
  add(319);

  const { stories } = identifyStories(points, { scoring: 'v1' });
  return {
    pointCount: points.length,
    found: stories.filter((story) => story.aspect === 'conjunction').length,
  };
}

const counterexample = conjunctionCounterexample();
console.log(
  `\nsynthetic ${String(counterexample.pointCount)}-point set, composite wrapping past 180 deg: ` +
    `${String(counterexample.found)} conjunction stories`,
);
console.log(
  counterexample.found > 0
    ? '=> unreachable for charts, NOT for every input identifyStories accepts. Keep the entry.'
    : '=> this construction found no counterexample.',
);

// --- top stories, v1 against v2 ----------------------------------------------

console.log(`\n--- top story, v1 against v2 ---\n`);
let topAgreements = 0;
for (const row of rows) {
  const agree = row.topStoryV1 === row.topStoryV2;
  if (agree) topAgreements += 1;
  console.log(`${pad(row.label, 20)}${agree ? 'AGREE  ' : 'DIFFER '}${row.topStoryV1}`);
  if (!agree) console.log(`${pad('', 20)}       v2: ${row.topStoryV2}`);
}
console.log(`\n${String(topAgreements)}/${String(rows.length)} charts agree on the top story.`);

if (DUMP_FIXTURES) {
  console.log(`\n--- fixtures ---\n`);
  console.log(fixtures.join('\n'));
}
