/**
 * The reference panel: ten charts the engine is measured against.
 *
 * Everything calibrated in this project before this file — the one-to-two key
 * windows per quarter target, the funnel presets in src/domain/timescales.ts,
 * the density bounds in tests/golden/funnel.golden.test.ts — was measured on a
 * single chart, 12 Aug 1987 in Rome. One chart cannot distinguish "the preset
 * is well tuned" from "the preset happens to suit this sky". The panel exists
 * so that difference becomes visible.
 *
 * How the ten were chosen. Four axes are spread deliberately:
 *
 *   birth year   1945 to 2010, so the slow bodies sit in different signs and
 *                different mutual configurations
 *   latitude     60.2N down to 41.3S, including the equator, so house sizes
 *                run from grossly unequal to nearly equal
 *   time of day  ten different local clock times, so the angles land in ten
 *                different degrees and never in the same house pattern
 *   clustering   from seven points inside one 10-degree composite (Madrid
 *                2000) to twelve singletons (Wellington 1973)
 *
 * Clustering is the axis that actually moves the funnel, and it is the one
 * that was measured rather than assumed. A composite body is a group of points
 * within SCORING_V1.compositeConjunctionOrbDeg of each other; a story is an
 * aspect between two composites. Clustering therefore sets how many stories a
 * chart has, and the funnel's output is bounded by that count. Every
 * clustering claim in the notes below was produced by running bodyState over
 * the candidate instant and counting, not by picking a date that sounded
 * right; scripts/measure-density-panel.ts recomputes all of them.
 *
 * Latitude ceiling: 60.2N (Helsinki). Above roughly 66 degrees Placidus is
 * undefined and src/ephemeris/swe.ts refuses the cusps rather than returning
 * Porphyry under Placidus's name, so a higher chart could not use the same
 * setup as the rest of the panel.
 */

import type { AspectPoint } from '../../src/domain/aspects.js';
import { DEFAULT_BODIES } from '../../src/ephemeris/bodies.js';
import {
  bodyState,
  housesFor,
  jdFromUtc,
  type JulianDayUT,
  type UtcInstant,
} from '../../src/ephemeris/swe.js';
import type { FunnelPath } from '../../src/transits/funnel.js';

export interface ReferenceChart {
  readonly id: string;
  readonly whenUtc: UtcInstant;
  readonly geo: { readonly lat: number; readonly lon: number };
  /** Why this chart is in the set. */
  readonly note: string;
}

export const REFERENCE_CHARTS: readonly ReferenceChart[] = [
  {
    id: 'rome-1987',
    whenUtc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 },
    geo: { lat: 41.9028, lon: 12.4964 },
    note:
      'The original reference — 11:32 CEST — and the only chart every earlier ' +
      'calibration in this project ever saw. First and unchanged so the numbers ' +
      'measured before the panel stay comparable with the numbers measured after ' +
      'it. Structurally it is a middling chart: a four-body Mercury-Venus-Sun-Mars ' +
      'stellium spanning 12.6 degrees, nine composites in all, seven stories. It ' +
      'is also, measured across four consecutive decades, the steadiest chart in ' +
      'the panel (1.23, 1.45, 1.58, 1.15 windows per quarter) — which is why one ' +
      'chart made the funnel look better calibrated than it is.',
  },
  {
    id: 'madrid-2000',
    whenUtc: { year: 2000, month: 5, day: 3, hour: 12, minute: 0 },
    geo: { lat: 40.4168, lon: -3.7038 },
    note:
      'The stellium end of the clustering axis, and the most extreme one the ' +
      'search found: the May 2000 Taurus alignment. Measured, Sun, Moon, Mercury, ' +
      'Venus, Jupiter and Saturn chain into a SINGLE composite, seven points once ' +
      'the Midheaven joins at 14:00 local. Seven composites, only four stories — ' +
      'clustering collapses the aspect list, so the funnel has few stories to ' +
      'work with and reaches them all repeatedly. This is the low-story-count ' +
      'extreme.',
  },
  {
    id: 'wellington-1973',
    whenUtc: { year: 1973, month: 2, day: 16, hour: 19, minute: 0 },
    geo: { lat: -41.2866, lon: 174.7756 },
    note:
      'The scattered end of the same axis, and the deliberate opposite of Madrid. ' +
      'Found by scanning 1965-1985 at two-day steps for the instant with the ' +
      'fewest composite groups: here no two of the twelve default bodies fall ' +
      'within the 10-degree composite orb, so every body is its own composite and ' +
      'the twelve of them occupy 294 of 360 degrees. Twelve composites produce ' +
      'twelve stories — the high-story-count extreme. Also southern hemisphere at ' +
      '41.3S, the mirror of Rome, so hemisphere and clustering do not vary ' +
      'together.',
  },
  {
    id: 'helsinki-1955',
    whenUtc: { year: 1955, month: 11, day: 2, hour: 16, minute: 5 },
    geo: { lat: 60.1699, lon: 24.9384 },
    note:
      'The high-latitude case, 60.2N, 18:05 local. Placidus is still defined here ' +
      'but the houses are badly unequal, which is exactly the regime that breaks ' +
      'naive implementations; the panel needs one chart in it. Mars, Mercury and ' +
      'Neptune form a three-body composite, so it also covers the middle of the ' +
      'clustering range.',
  },
  {
    id: 'paris-1945',
    whenUtc: { year: 1945, month: 5, day: 8, hour: 20, minute: 40 },
    geo: { lat: 48.8566, lon: 2.3522 },
    note:
      'The earliest birth year in the panel, 22:40 local. Chiron, Jupiter and ' +
      'Neptune sit inside one composite with the Midheaven, and the twelve bodies ' +
      'occupy only 179 degrees — the tightest overall spread in the panel, ' +
      'Madrid included. Concentration in one half of the zodiac and one large ' +
      'stellium are different kinds of clustering and the panel carries both. It ' +
      'also puts the ten-year window in 1965-1975, the earliest transit sky here.',
  },
  {
    id: 'mexico-city-1968',
    whenUtc: { year: 1968, month: 10, day: 12, hour: 3, minute: 40 },
    geo: { lat: 19.4326, lon: -99.1332 },
    note:
      'Low northern latitude, 19.4N, 21:40 local the previous evening. Carries ' +
      'the Uranus-Pluto conjunction of the 1960s as a natal composite with ' +
      'Jupiter, a configuration no other chart in the panel has: two slow bodies ' +
      'tight enough to act as one, so a single transit reaches both archetypes at ' +
      'once. Three stories on eight composites makes it one of the sparser charts.',
  },
  {
    id: 'buenos-aires-1975',
    whenUtc: { year: 1975, month: 6, day: 21, hour: 23, minute: 45 },
    geo: { lat: -34.6037, lon: -58.3816 },
    note:
      'Southern hemisphere at 34.6S, 20:45 local. Two separate three-body ' +
      'composites — Chiron-Jupiter-Mars and Moon-Neptune-node — rather than one ' +
      'large one, so it tests clustering that is distributed instead of ' +
      'concentrated. Nine composites, six stories.',
  },
  {
    id: 'london-1962',
    whenUtc: { year: 1962, month: 2, day: 5, hour: 0, minute: 10 },
    geo: { lat: 51.5074, lon: -0.1278 },
    note:
      'The February 1962 Aquarius stellium, ten minutes past midnight local. Sun, ' +
      'Moon, Mercury, Venus and Jupiter in one five-body composite: a second, ' +
      'independent stellium chart, so that end of the axis does not rest on ' +
      'Madrid alone. It earns its place twice over, because it is also the ' +
      "panel's degenerate case — 0.18 windows per quarter over its ten-year " +
      'window, seven key dates in a decade. Kept precisely because it is ' +
      'degenerate: see the golden for the measurement showing the drought is the ' +
      'decade, not the chart.',
  },
  {
    id: 'quito-1995',
    whenUtc: { year: 1995, month: 9, day: 10, hour: 6, minute: 0 },
    geo: { lat: -0.1807, lon: -78.4678 },
    note:
      'The equator, 01:00 local. At latitude zero the quadrant houses come out ' +
      'nearly equal, the opposite regime from Helsinki, and the reason both are ' +
      'here. Seven composites, six stories, no group larger than three. It is ' +
      "also the panel's dense end at 2.68 windows per quarter, the other side of " +
      'the same epoch effect that starves London.',
  },
  {
    id: 'tokyo-2010',
    whenUtc: { year: 2010, month: 3, day: 15, hour: 22, minute: 10 },
    geo: { lat: 35.6762, lon: 139.6503 },
    note:
      'The latest birth year in the panel, 07:10 local on 16 March, and the only ' +
      'far-eastern longitude. Its ten-year window falls in 2030-2040, the only ' +
      'part of the panel that measures the engine against a sky it has to ' +
      'extrapolate rather than one already lived through.',
  },
];

/**
 * The window every panel measurement uses: age twenty to thirty.
 *
 * Taken from tests/golden/funnel.golden.test.ts unchanged, including its
 * 365-day year. Ten years is long enough for the slow bodies to open and close
 * windows and short enough to keep ten charts inside a runnable test; the
 * offset matters less than the fact that it is the same offset the Rome
 * measurements were taken at, so chart 1 remains directly comparable.
 */
export const PANEL_WINDOW_FROM_DAYS = 365 * 20;
export const PANEL_WINDOW_TO_DAYS = 365 * 30;

export interface ChartSetup {
  readonly natalJd: JulianDayUT;
  /** The twelve default bodies plus the two angles, as the funnel expects them. */
  readonly points: readonly AspectPoint[];
  readonly fromJd: JulianDayUT;
  readonly toJd: JulianDayUT;
}

/**
 * One panel chart, resolved into the inputs `identifyStories` and `buildFunnel`
 * take.
 *
 * It lives beside the data rather than in either caller because the script that
 * produces the numbers and the golden that asserts them have to build the chart
 * identically — a difference of one natal point between them would make the
 * asserted bounds describe a chart nobody measured.
 */
export function setUpChart(chart: ReferenceChart): ChartSetup {
  const natalJd = jdFromUtc(chart.whenUtc);
  const houses = housesFor(natalJd, chart.geo.lat, chart.geo.lon, 'P');

  return {
    natalJd,
    points: [
      ...DEFAULT_BODIES.map((id) => ({ id, lon: bodyState(natalJd, id).lon })),
      { id: 'ascendant', lon: houses.ascendant },
      { id: 'midheaven', lon: houses.midheaven },
    ],
    fromJd: (natalJd + PANEL_WINDOW_FROM_DAYS) as JulianDayUT,
    toJd: (natalJd + PANEL_WINDOW_TO_DAYS) as JulianDayUT,
  };
}

/**
 * The shape of a funnel path: which bodies met, by which aspects, at each of
 * the three levels — Neptune square something, then Saturn trine it, then Mars
 * conjunct it.
 *
 * Counting distinct shapes asks how much interpretive VARIETY a chart yields,
 * which is the quantity FUNNEL_DEFAULT was tuned on alongside density (61
 * shapes against 37 and 36 for the alternatives it beat). The natal point is
 * deliberately excluded: the same three-body chain reaching the Sun or the Moon
 * is the same kind of event, and including the member would only re-count the
 * chart's point list.
 *
 * It lives here, beside the panel, because the script that produces the numbers
 * and the golden that asserts them have to count the same thing.
 */
export function pathShape(path: FunnelPath): string {
  return (
    `${path.slow.body} ${path.slow.aspect} > ` +
    `${path.social.body} ${path.social.aspect} > ` +
    `${path.fast.body} ${path.fast.aspect}`
  );
}
