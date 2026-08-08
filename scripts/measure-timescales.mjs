/**
 * Measures how long a transiting body stays within orb of a fixed natal
 * degree, and prints the groupings that fall out of the data.
 *
 * This exists because the prototype assigned activation tiers BY PLANET NAME —
 * Layer 1 was ['Uranus','Neptune'], Layer 2 was ['Mars','Jupiter','Saturn'] —
 * and used one activation window of 30 days for all of them. Measurement says
 * both choices are wrong:
 *
 *   Uranus and Neptune sit in the same tier, yet their contacts last 47 and
 *   115 days. Uranus and SATURN last 47 and 46 — indistinguishable — and the
 *   prototype puts them in different tiers.
 *
 *   The 30-day window is 7x too wide for Mars (4-day contact) and 33x too
 *   narrow for Pluto (2.7-year window once its retrograde passes are counted).
 *
 * Speed alone does not predict this. Saturn moves twice as fast as Uranus, and
 * retrogrades in a way that makes the contact last the same. That is why the
 * thresholds are measured rather than reasoned about.
 *
 *   node scripts/measure-timescales.mjs [ephe-dir] [years]
 */

import sweph from 'sweph';

const EPHE = process.argv[2] ?? './ephem';
const YEARS = Number(process.argv[3] ?? 60);

sweph.set_ephe_path(EPHE);

const C = sweph.constants;
const FLAGS = C.SEFLG_SWIEPH | C.SEFLG_SPEED;

/**
 * The transiting set: Mercury and outward.
 *
 * Excluded, deliberately:
 *   Moon    — 3.6-hour contacts, 801 of them in 60 years. Real, and it would
 *             bury every other body in noise. Revisit as an opt-in later.
 *   Node    — retrograde 74% of the time; it does not behave like the others.
 *   Lilith  — a mean point, not an osculating body: 0% retrograde and every
 *             contact exactly 18 days. Its regularity is an artefact.
 */
const BODIES = [
  ['mercury', C.SE_MERCURY],
  ['venus', C.SE_VENUS],
  ['sun', C.SE_SUN],
  ['mars', C.SE_MARS],
  ['jupiter', C.SE_JUPITER],
  ['saturn', C.SE_SATURN],
  ['uranus', C.SE_URANUS],
  ['chiron', C.SE_CHIRON],
  ['neptune', C.SE_NEPTUNE],
  ['pluto', C.SE_PLUTO],
];

const ORB_DEG = 1;
const START_JD = 2451545; // J2000
const DAYS = YEARS * 365;

/** Shortest angular distance, 0..180. */
const sep = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

function measure(name, id) {
  // Target = the body's own position at mid-window, so it certainly crosses.
  // Picking a fixed degree instead makes the slow bodies report zero contacts:
  // Neptune takes 165 years to return, so in a 60-year window it never reaches
  // an arbitrary longitude. That is a measurement artefact, not a result.
  const mid = sweph.calc_ut(START_JD + DAYS / 2, id, FLAGS);
  if (mid.flag < 0) return undefined;
  const target = mid.data[0];

  let speedSum = 0;
  let retrogradeDays = 0;
  let samples = 0;
  for (let d = 0; d < DAYS; d += 1) {
    const r = sweph.calc_ut(START_JD + d, id, FLAGS);
    if (r.flag < 0) continue;
    speedSum += Math.abs(r.data[3]);
    if (r.data[3] < 0) retrogradeDays += 1;
    samples += 1;
  }
  const meanSpeed = speedSum / samples;

  // Step fine enough that the fastest body cannot cross the orb between
  // samples: at 1.2 deg/day a 1-degree orb lasts ~1.6 days, so 0.05 gives
  // ~30 samples inside it.
  const step = meanSpeed > 0.5 ? 0.05 : 0.25;

  const episodes = [];
  let current = 0;
  let episodeStart = null;
  const spans = [];

  for (let d = 0; d < DAYS; d += step) {
    const r = sweph.calc_ut(START_JD + d, id, FLAGS);
    if (r.flag < 0) continue;

    if (sep(r.data[0], target) <= ORB_DEG) {
      if (current === 0) episodeStart = d;
      current += step;
    } else if (current > 0) {
      episodes.push(current);
      spans.push([episodeStart, d]);
      current = 0;
    }
  }
  if (current > 0) {
    episodes.push(current);
    spans.push([episodeStart, DAYS]);
  }

  // Episodes belonging to one approach — the retrograde loop over the same
  // degree — versus genuinely separate returns.
  //
  // The threshold must scale with the body. A flat five years merges all 78 of
  // Mercury's returns into one 59-year "window", which is nonsense. Three
  // times the typical contact duration separates the loop from the next
  // approach for every body in this set.
  const sortedEpisodes = [...episodes].sort((a, b) => a - b);
  const medianEpisode = sortedEpisodes[Math.floor(sortedEpisodes.length / 2)] ?? 0;
  const loopThreshold = Math.max(medianEpisode * 3, 1);
  const passages = [];
  let windowStart = null;
  let windowEnd = null;
  let count = 0;
  for (const [s, e] of spans) {
    if (windowStart === null) {
      windowStart = s;
      windowEnd = e;
      count = 1;
    } else if (s - windowEnd < loopThreshold) {
      windowEnd = e;
      count += 1;
    } else {
      passages.push({ days: windowEnd - windowStart, passes: count });
      windowStart = s;
      windowEnd = e;
      count = 1;
    }
  }
  if (windowStart !== null) passages.push({ days: windowEnd - windowStart, passes: count });

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  const sorted = [...episodes].sort((a, b) => a - b);
  return {
    name,
    meanSpeed,
    retrogradePct: (retrogradeDays / samples) * 100,
    episodeCount: episodes.length,
    contactMedian: median(episodes),
    contactMean: episodes.reduce((sum, e) => sum + e, 0) / Math.max(episodes.length, 1),
    contactMax: sorted[sorted.length - 1] ?? 0,
    windowDays: median(passages.map((p) => p.days)),
    passes: median(passages.map((p) => p.passes)),
  };
}

const rows = BODIES.map(([name, id]) => measure(name, id)).filter((r) => r !== undefined);
rows.sort((a, b) => a.contactMedian - b.contactMedian);

const fmt = (d) =>
  d < 1 ? `${(d * 24).toFixed(1)}h` : d < 400 ? `${d.toFixed(0)}g` : `${(d / 365).toFixed(1)}a`;

console.log(`Contact duration within ${String(ORB_DEG)} degree of a fixed natal degree.`);
console.log(`Window: ${String(YEARS)} years from J2000. Ephemeris: ${EPHE}\n`);
console.log(
  'body'.padEnd(10) +
    'deg/day'.padStart(9) +
    'retro%'.padStart(8) +
    'median'.padStart(9) +
    'mean'.padStart(8) +
    'max'.padStart(8) +
    'window'.padStart(9) +
    'passes'.padStart(8),
);
console.log('-'.repeat(69));
for (const r of rows) {
  console.log(
    r.name.padEnd(10) +
      r.meanSpeed.toFixed(3).padStart(9) +
      r.retrogradePct.toFixed(1).padStart(8) +
      fmt(r.contactMedian).padStart(9) +
      fmt(r.contactMean).padStart(8) +
      fmt(r.contactMax).padStart(8) +
      fmt(r.windowDays).padStart(9) +
      String(r.passes).padStart(8),
  );
}

// Cut where consecutive contact durations differ by more than this factor.
// 2.5 is the smallest value that separates Mars (4g) from Jupiter (17g) while
// keeping Saturn and Uranus (46g, 47g) together — which is the whole point.
const GAP_FACTOR = 2.5;

console.log('\nTiers, cut where the duration jumps by more than 2.5x:\n');
let tier = [rows[0]];
const tiers = [];
for (let i = 1; i < rows.length; i += 1) {
  const previous = rows[i - 1];
  const current = rows[i];
  if (current.contactMedian / previous.contactMedian > GAP_FACTOR) {
    tiers.push(tier);
    tier = [];
  }
  tier.push(current);
}
tiers.push(tier);

for (const group of tiers) {
  const low = fmt(group[0].contactMedian);
  const high = fmt(group[group.length - 1].contactMedian);
  const range = low === high ? low : `${low}-${high}`;
  console.log(`  ${range.padEnd(12)} ${group.map((r) => r.name).join(', ')}`);
}
