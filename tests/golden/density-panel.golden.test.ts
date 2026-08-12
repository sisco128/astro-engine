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
 * (scripts/measure-density-panel.ts reproduces every number). Both columns are
 * kept because the second exists BECAUSE of the first — the "was" is the
 * restricted slow tier this file used to document:
 *
 *   chart              stories  windows  per quarter   was
 *   rome-1987                7       88         2.20   1.23
 *   madrid-2000              4       72         1.80   1.65
 *   wellington-1973         12       62         1.55   0.80
 *   helsinki-1955            4       50         1.25   0.53
 *   paris-1945               5       33         0.83   0.60
 *   mexico-city-1968         3       37         0.93   0.75
 *   buenos-aires-1975        6       56         1.40   0.85
 *   london-1962              7       38         0.95   0.18
 *   quito-1995               6      164         4.10   2.68
 *   tokyo-2010               3       55         1.38   1.05
 *
 *   min 0.83   median 1.39   mean 1.64   max 4.10
 *
 * The point of the change is the first column, not the last: the floor moves
 * from 0.18 to 0.83 and the median from below the target into it. london-1962
 * at 0.18 was seven key windows in a decade — the funnel had almost nothing to
 * say about that person for ten years — and it is now 38.
 *
 * Three things follow, and the assertions below are those three things.
 *
 * 1. The spread is fivefold, down from fifteen. A chart-to-chart range is
 *    inherent — some skies are busier than others — but a fifteen-fold spread
 *    meant the quiet end was not sparse, it was silent.
 *
 * 2. The target band is met by nine of ten. That is the honest version of
 *    "the preset hits one to two per quarter" — it is a statement about the
 *    middle of a distribution, not about a chart.
 *
 * 3. The centre now sits INSIDE the target, at a median of 1.39. This file
 *    used to record the opposite and say so plainly: "the centre sits BELOW
 *    the target, at a median of 0.83 … nothing here retunes the preset —
 *    retuning against ten charts is its own piece of work". This is that piece
 *    of work, and what forced it was not the panel but a live screen: on the
 *    chart the target was set on, opening the app in August 2026 gave zero key
 *    dates within six months either way.
 *
 * The two charts outside the band were investigated before the bounds were
 * widened for them, and both are the sky rather than the fixture:
 *
 *   london-1962, once 0.18 and now 0.95 — the natal points sit in one
 *     Aquarius-Leo axis, so aspects from the slow bodies can only arrive from
 *     a few zodiacal regions. When the slow tier took hard aspects only, those
 *     regions were two, and across 1982-1992 they were reached in two short
 *     epochs while Jupiter and Saturn were elsewhere for most of both. Trines
 *     and sextiles reach that axis from four more regions, which is precisely
 *     why admitting them lifts the floor rather than merely adding noise.
 *
 *   quito-1995 at 4.10 — the opposite face of the same effect. Its window,
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
 * Derived from the measurements above and nothing else. The floor sits below
 * the measured minimum of 0.83, the ceiling above the measured maximum of
 * 4.10. Both are stated in units that mean something rather than as a
 * percentage margin: below 0.5 a chart yields fewer than twenty key windows in
 * a decade, which is one every six months and the point at which the funnel
 * stops describing a life; above 4.5 it yields more than one a month, at which
 * point it has stopped choosing.
 *
 * The floor is where the real tightening happened — it was 0.15, chosen to
 * accommodate a chart measuring 0.18. Nothing may be that quiet now.
 *
 * Widening either of these is a re-calibration, not a fix. The measured value
 * that justified the change belongs in this comment before the number moves.
 */
const PANEL_FLOOR = 0.5;
const PANEL_CEILING = 4.5;

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
    // The weakest chart in the panel now produces 33 windows across 44 shapes
    // in a decade. It produced seven, and this floor was five — a bound set to
    // accommodate the silence rather than to forbid it.
    //
    // Twenty-five is one window every five months on the weakest chart. Below
    // that the funnel has stopped describing a life, which is a different
    // failure from being sparse and is worth separating.
    for (const chart of REFERENCE_CHARTS) {
      const { windows, shapes } = measure(chart);
      expect(windows).toBeGreaterThanOrEqual(25);
      expect(shapes).toBeGreaterThanOrEqual(25);
    }
  });

  it('keeps the Rome reference inside the bounds the funnel golden asserts', () => {
    // Chart 1 is the continuity anchor. Measured at 2.20 over this ten-year
    // window; the funnel golden asserts the same chart against 0.7 to 2.6 and
    // must keep agreeing with the panel about it.
    const rome = REFERENCE_CHARTS[0];
    expect(rome?.id).toBe('rome-1987');
    if (rome === undefined) return;

    const { perQuarter } = measure(rome);
    expect(perQuarter).toBeGreaterThan(0.7);
    expect(perQuarter).toBeLessThan(2.6);
  });
});

describe('the target band, as a statement about ten charts', () => {
  it('holds on nine of the ten, and names the one it does not', () => {
    const outside = REFERENCE_CHARTS.filter((chart) => {
      const { perQuarter } = measure(chart);
      return perQuarter < TARGET_LOW || perQuarter > TARGET_HIGH;
    }).map((chart) => chart.id);

    // Asserted by name, not by count. If a second chart leaves the band, or a
    // different one does, that is a change in the model and the person making
    // it should have to look at this list. london-1962 used to be on it at
    // 0.18 and is now inside at 0.95.
    expect(outside.sort()).toEqual(['quito-1995']);
  });

  it('centres inside the target, which it did not before', () => {
    const sorted = panel()
      .map((measured) => measured.perQuarter)
      .sort((a, b) => a - b);
    const median = ((sorted[4] ?? 0) + (sorted[5] ?? 0)) / 2;

    // Measured 1.39. This assertion used to run the other way — it asserted
    // that the centre sat BELOW the target at 0.83, because that was true and
    // worth pinning. It is the one number that says whether the preset suits
    // ten skies or only the one it was tuned on.
    expect(median).toBeGreaterThan(1.0);
    expect(median).toBeLessThan(2.0);
  });

  it('still spreads several-fold, because skies differ', () => {
    const values = panel().map((measured) => measured.perQuarter);
    const low = Math.min(...values);
    const high = Math.max(...values);

    // Measured 4.10 / 0.83 = 4.9, down from 14.9. The spread is real and not
    // a defect — some decades are busier than others, and Rome's own
    // decade-to-decade range is a factor of 1.4, so one chart could never
    // show it. What was a defect was the bottom of that range: a chart at
    // 0.18 was not sparse, it was silent.
    expect(high / low).toBeGreaterThan(3);
    expect(high / low).toBeLessThan(8);
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
