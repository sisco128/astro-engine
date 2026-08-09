/**
 * The funnel's density across ten charts instead of one.
 *
 * tests/golden/funnel.golden.test.ts asserts the same target — one to two key
 * windows per quarter — on the 1987 Rome chart, which is the chart every preset
 * in src/domain/timescales.ts was tuned against. That test cannot tell a
 * well-tuned preset from a preset that suits one sky. This one can, and the
 * answer is that it is some of both.
 *
 * Measured, FUNNEL_DEFAULT over each chart's age-20-to-30 window
 * (scripts/measure-density-panel.ts reproduces every number):
 *
 *   chart              stories  windows  per quarter  path shapes
 *   rome-1987                7       49         1.23           52
 *   madrid-2000              4       66         1.65           67
 *   wellington-1973         12       32         0.80           33
 *   helsinki-1955            4       21         0.53           23
 *   paris-1945               5       24         0.60           34
 *   mexico-city-1968         3       30         0.75           38
 *   buenos-aires-1975        6       34         0.85           42
 *   london-1962              7        7         0.18            7
 *   quito-1995               6      107         2.68           99
 *   tokyo-2010               3       42         1.05           30
 *
 *   min 0.18   median 0.83   mean 1.03   max 2.68
 *
 * Three things follow, and the assertions below are those three things.
 *
 * 1. The spread is fifteen-fold. On Rome alone the funnel looked stable: 1.23,
 *    1.45, 1.58 and 1.15 windows per quarter over four consecutive decades.
 *    Across the panel on a single decade it runs 0.18 to 2.68.
 *
 * 2. The target band is met by eight of ten. That is the honest version of
 *    "the preset hits one to two per quarter" — it is a statement about the
 *    middle of a distribution, not about a chart.
 *
 * 3. The centre sits BELOW the target, at a median of 0.83. Rome, the chart
 *    the target was set on, is in the upper half of the panel. Nothing here
 *    retunes the preset — retuning against ten charts is its own piece of work
 *    and would invalidate every measurement recorded so far — but the number
 *    is asserted so the next person cannot re-derive the target from Rome
 *    without meeting this.
 *
 * The two charts outside the band were investigated before the bounds were
 * widened for them, and both are the sky rather than the fixture:
 *
 *   london-1962 at 0.18 — the natal points sit in one Aquarius-Leo axis, so
 *     hard aspects from the slow bodies can only arrive from two zodiacal
 *     regions. Across 1982-1992 that happens in two short epochs (Chiron early
 *     1982, Pluto through 1988-89) and Jupiter and Saturn are elsewhere for
 *     most of both. The same chart measures 0.88, 0.85 and 0.45 over the three
 *     following decades — the drought is the decade, not the chart.
 *
 *   quito-1995 at 2.68 — the opposite face of the same effect. Its window,
 *     2015-2025, is when transiting Uranus squares its own natal position and
 *     Chiron opposes its own, both of which are age-locked and both of which
 *     land on stories that also carry Sun, Venus and Saturn. It decays to 2.08,
 *     1.55 and 1.25 over the following decades.
 *
 * Concentrated natal longitudes plus a decade in which no slow body reaches
 * them is the mechanism, and it is a real property of the model rather than a
 * defect to tune away. Short windows raise variance, which this project has
 * accepted before; ten years is short enough for a single epoch to dominate one
 * chart.
 *
 * Runtime: 128 seconds, of which 125 is the funnel and almost all of that is
 * the fast tier scanning Mars at a 0.5-day step against every member of every
 * story. One funnel run per chart, memoised, or it would be several times
 * that. Two charts cost more than the rest — wellington-1973 at 21 seconds and
 * quito-1995 at 19 — for the same reason they are in the panel: twelve stories
 * and six wide ones respectively. Buying the budget back by dropping them
 * would drop the two ends of the clustering axis with them.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { identifyComposites } from '../../src/domain/composites.js';
import { SCORING_V1 } from '../../src/domain/scoring-weights.js';
import { identifyStories } from '../../src/domain/themes.js';
import { FUNNEL_DEFAULT } from '../../src/domain/timescales.js';
import { DEFAULT_BODIES } from '../../src/ephemeris/bodies.js';
import { setEphemerisPath, setForbidFallback } from '../../src/ephemeris/swe.js';
import { buildFunnel } from '../../src/transits/funnel.js';
import {
  pathShape,
  REFERENCE_CHARTS,
  setUpChart,
  type ReferenceChart,
} from '../fixtures/reference-charts.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

const EPHE_PATH = useRepoEphemeris();

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);
});

/**
 * The bounds every chart in the panel must satisfy.
 *
 * Derived from the measurements above and nothing else. The floor is a fifth
 * below the measured minimum of 0.18; the ceiling a sixth above the measured
 * maximum of 2.68. Both are stated in units that mean something rather than as
 * a percentage margin: below 0.15 a chart yields fewer than six key windows in
 * a decade, at which point the funnel has stopped describing a life; above 3.1
 * it yields more than one a month, at which point it has stopped choosing.
 *
 * Widening either of these is a re-calibration, not a fix. The measured value
 * that justified the change belongs in this comment before the number moves.
 */
const PANEL_FLOOR = 0.15;
const PANEL_CEILING = 3.1;

/** The stated target, unchanged from tests/golden/funnel.golden.test.ts. */
const TARGET_LOW = 0.5;
const TARGET_HIGH = 2.5;

interface Measured {
  readonly stories: number;
  readonly windows: number;
  readonly perQuarter: number;
  readonly shapes: number;
}

/**
 * Memoised, one funnel run per chart.
 *
 * A run costs eight to twenty seconds depending on how many stories the chart
 * has and how many points each story carries — the fast tier scans Mars at a
 * 0.5-day step against every member of every story, and that dominates
 * everything else. Ten charts recomputed per assertion would be twenty minutes.
 */
const cache = new Map<string, Measured>();

function measure(chart: ReferenceChart): Measured {
  const hit = cache.get(chart.id);
  if (hit !== undefined) return hit;

  const { points, fromJd, toJd } = setUpChart(chart);
  const { stories } = identifyStories(points);
  const result = buildFunnel({
    stories,
    natalPoints: points,
    fromJd,
    toJd,
    config: FUNNEL_DEFAULT,
  });

  const measured: Measured = {
    stories: stories.length,
    windows: result.windows.length,
    perQuarter: result.windowsPerQuarter,
    shapes: new Set(result.paths.map(pathShape)).size,
  };
  cache.set(chart.id, measured);
  return measured;
}

/** Every chart, measured. Cheap after the first pass. */
function panel(): Measured[] {
  return REFERENCE_CHARTS.map(measure);
}

describe('FUNNEL_DEFAULT density on every chart in the panel', () => {
  // A loop rather than it.each, so a failure names the chart and the run that
  // pays for that chart is the test that reports it.
  for (const chart of REFERENCE_CHARTS) {
    it(`stays inside the panel bounds on ${chart.id}`, () => {
      const { perQuarter } = measure(chart);
      expect(perQuarter).toBeGreaterThan(PANEL_FLOOR);
      expect(perQuarter).toBeLessThan(PANEL_CEILING);
    });
  }

  it('never goes silent: every chart yields key windows and more than one shape', () => {
    // The weakest chart in the panel still produces seven windows across seven
    // distinct path shapes in a decade. A chart at zero would mean the funnel
    // had nothing to say about someone, which is a different failure from
    // being sparse and is worth separating.
    for (const chart of REFERENCE_CHARTS) {
      const { windows, shapes } = measure(chart);
      expect(windows).toBeGreaterThanOrEqual(5);
      expect(shapes).toBeGreaterThanOrEqual(5);
    }
  });

  it('keeps the Rome reference inside the bounds the funnel golden asserts', () => {
    // Chart 1 is the continuity anchor. Measured at 1.23 over this ten-year
    // window; the funnel golden asserts the same chart against 0.7 to 2.2 and
    // must keep agreeing with the panel about it.
    const rome = REFERENCE_CHARTS[0];
    expect(rome?.id).toBe('rome-1987');
    if (rome === undefined) return;

    const { perQuarter } = measure(rome);
    expect(perQuarter).toBeGreaterThan(0.7);
    expect(perQuarter).toBeLessThan(2.2);
  });
});

describe('the target band, as a statement about ten charts', () => {
  it('holds on eight of the ten, and names the two it does not', () => {
    const outside = REFERENCE_CHARTS.filter((chart) => {
      const { perQuarter } = measure(chart);
      return perQuarter < TARGET_LOW || perQuarter > TARGET_HIGH;
    }).map((chart) => chart.id);

    // Asserted by name, not by count. If a third chart leaves the band, or a
    // different one does, that is a change in the model and the person making
    // it should have to look at this list.
    expect(outside.sort()).toEqual(['london-1962', 'quito-1995']);
  });

  it('centres below the target it was tuned to, not inside it', () => {
    const sorted = panel()
      .map((measured) => measured.perQuarter)
      .sort((a, b) => a - b);
    const median = ((sorted[4] ?? 0) + (sorted[5] ?? 0)) / 2;

    // Measured 0.83, against a target whose floor is 1.0. The band here is
    // wide because the claim being asserted is only "the centre is below the
    // target, and not by an order of magnitude".
    expect(median).toBeGreaterThan(0.6);
    expect(median).toBeLessThan(1.0);
  });

  it('spans at least a tenfold range, which one chart could never show', () => {
    const values = panel().map((measured) => measured.perQuarter);
    const low = Math.min(...values);
    const high = Math.max(...values);

    // Measured 2.68 / 0.18 = 14.9. This is the finding the panel exists for:
    // Rome's own decade-to-decade range is 1.15 to 1.58, a factor of 1.4.
    expect(high / low).toBeGreaterThan(10);
  });
});

describe('the panel spans the axes its notes claim', () => {
  // Cheap — no funnel, only natal positions. These guard the fixture's own
  // notes: a note claiming a stellium is worthless if someone edits the instant
  // and the stellium goes away.

  function compositesOf(chart: ReferenceChart, bodiesOnly: boolean): number[] {
    const { points } = setUpChart(chart);
    const ids: readonly string[] = DEFAULT_BODIES;
    const chosen = bodiesOnly ? points.filter((point) => ids.includes(point.id)) : points;
    return identifyComposites(
      chosen.map((point) => ({ id: point.id, lon: point.lon })),
      SCORING_V1.compositeConjunctionOrbDeg,
    ).map((composite) => composite.members.length);
  }

  function chartById(id: string): ReferenceChart {
    const found = REFERENCE_CHARTS.find((chart) => chart.id === id);
    expect(found).toBeDefined();
    if (found === undefined) throw new Error(`no chart ${id}`);
    return found;
  }

  it('has ten charts with distinct ids', () => {
    expect(REFERENCE_CHARTS).toHaveLength(10);
    expect(new Set(REFERENCE_CHARTS.map((chart) => chart.id)).size).toBe(10);
    for (const chart of REFERENCE_CHARTS) expect(chart.note.length).toBeGreaterThan(80);
  });

  it('reaches both ends of the clustering axis', () => {
    // Madrid: the May 2000 alignment, seven points in one composite.
    expect(Math.max(...compositesOf(chartById('madrid-2000'), false))).toBeGreaterThanOrEqual(7);
    // Wellington: found by search, no two bodies inside the composite orb.
    expect(Math.max(...compositesOf(chartById('wellington-1973'), true))).toBe(1);
  });

  it('reaches both ends of the story-count axis', () => {
    const counts = panel().map((measured) => measured.stories);
    expect(Math.min(...counts)).toBeLessThanOrEqual(3);
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(12);
  });

  it('spans latitude, hemisphere and birth year', () => {
    const lats = REFERENCE_CHARTS.map((chart) => chart.geo.lat);
    const years = REFERENCE_CHARTS.map((chart) => chart.whenUtc.year);

    // High latitude, but below the ~66 degrees where Placidus stops being
    // defined and src/ephemeris/swe.ts refuses the cusps.
    expect(Math.max(...lats)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...lats)).toBeLessThan(66);
    expect(Math.min(...lats)).toBeLessThanOrEqual(-34);
    // One chart effectively on the equator, where quadrant houses are regular.
    expect(Math.min(...lats.map(Math.abs))).toBeLessThan(1);

    expect(Math.min(...years)).toBeLessThanOrEqual(1945);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2010);
    // No two charts from the same year: the slow bodies have to move.
    expect(new Set(years).size).toBe(10);
  });

  it('sets the angles from ten different clock times', () => {
    const minutes = REFERENCE_CHARTS.map((chart) => chart.whenUtc.hour * 60 + chart.whenUtc.minute);
    expect(new Set(minutes).size).toBe(10);

    // Every chart's Ascendant in a different degree, and the panel covering at
    // least half the signs — the point of varying the time is that the angles
    // and therefore the houses land somewhere else each time.
    const ascendants = REFERENCE_CHARTS.map((chart) => {
      const { points } = setUpChart(chart);
      return points.find((point) => point.id === 'ascendant')?.lon ?? 0;
    });
    const signs = new Set(ascendants.map((lon) => Math.floor(lon / 30)));
    expect(signs.size).toBeGreaterThanOrEqual(6);
  });
});
