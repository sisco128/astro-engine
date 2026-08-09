/**
 * The measurement behind tests/golden/density-panel.golden.test.ts.
 *
 * scripts/simulate-nesting.ts answered "does strict nesting produce anything at
 * all?" on one chart with a coarse daily simulation. This answers the next
 * question with the real implementation: how much does the funnel's density
 * vary from chart to chart, and is the one-to-two windows per quarter target a
 * property of the preset or a property of the 1987 Rome sky it was tuned on?
 *
 * For each chart in tests/fixtures/reference-charts.ts it prints the clustering
 * that justifies the chart's note, then runs identifyStories + buildFunnel with
 * FUNNEL_DEFAULT over the same ten-year window the funnel golden uses. The
 * bounds asserted in the golden come from this output and nowhere else, so the
 * numbers must be reproducible:
 *
 *   SE_EPHE_PATH=... pnpm tsx scripts/measure-density-panel.ts
 */

import { identifyComposites } from '../src/domain/composites.js';
import { SCORING_V1 } from '../src/domain/scoring-weights.js';
import { identifyStories } from '../src/domain/themes.js';
import { FUNNEL_DEFAULT } from '../src/domain/timescales.js';
import { DEFAULT_BODIES } from '../src/ephemeris/bodies.js';
import { setEphemerisPath, setForbidFallback } from '../src/ephemeris/swe.js';
import { buildFunnel } from '../src/transits/funnel.js';
import { pathShape, REFERENCE_CHARTS, setUpChart } from '../tests/fixtures/reference-charts.js';

setEphemerisPath(process.env['SE_EPHE_PATH'] ?? './ephem');
setForbidFallback(true);

const BODY_IDS: readonly string[] = DEFAULT_BODIES;

/**
 * How much of the zodiac the bodies actually occupy, in degrees.
 *
 * Measured as 360 minus the largest empty gap between adjacent longitudes,
 * which is the only spread statistic that behaves correctly on a circle: a mean
 * or a standard deviation of longitudes depends on where you cut the circle,
 * this does not. Near 360 is scattered, near 0 is a single stellium.
 *
 * Over the twelve default bodies and not the angles, because the composite
 * grouping that decides how many stories a chart has runs over bodies; the
 * Ascendant and Midheaven are artefacts of place and clock time, and letting
 * them fill a gap would make a scattered chart look clustered for a reason that
 * has nothing to do with the sky.
 */
function occupiedArcDeg(longitudes: readonly number[]): number {
  const sorted = [...longitudes].sort((a, b) => a - b);
  let largestGap = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i] ?? 0;
    const next = sorted[(i + 1) % sorted.length] ?? 0;
    const gap = i === sorted.length - 1 ? next + 360 - current : next - current;
    if (gap > largestGap) largestGap = gap;
  }

  return 360 - largestGap;
}

interface Row {
  readonly id: string;
  readonly composites: number;
  readonly largest: number;
  readonly largestBodies: number;
  readonly arcDeg: number;
  readonly stories: number;
  readonly paths: number;
  readonly windows: number;
  readonly perQuarter: number;
  readonly shapes: number;
  readonly seconds: number;
}

const rows: Row[] = [];

for (const chart of REFERENCE_CHARTS) {
  const { points, fromJd, toJd } = setUpChart(chart);
  const bodies = points.filter((point) => BODY_IDS.includes(point.id));

  const composites = identifyComposites(
    points.map((point) => ({ id: point.id, lon: point.lon })),
    SCORING_V1.compositeConjunctionOrbDeg,
  );
  const bodyComposites = identifyComposites(
    bodies.map((point) => ({ id: point.id, lon: point.lon })),
    SCORING_V1.compositeConjunctionOrbDeg,
  );

  const { stories } = identifyStories(points);

  const startedAt = Date.now();
  const result = buildFunnel({
    stories,
    natalPoints: points,
    fromJd,
    toJd,
    config: FUNNEL_DEFAULT,
  });
  const seconds = (Date.now() - startedAt) / 1000;

  const row: Row = {
    id: chart.id,
    composites: composites.length,
    largest: Math.max(...composites.map((composite) => composite.members.length)),
    largestBodies: Math.max(...bodyComposites.map((composite) => composite.members.length)),
    arcDeg: occupiedArcDeg(bodies.map((point) => point.lon)),
    stories: stories.length,
    paths: result.paths.length,
    windows: result.windows.length,
    perQuarter: result.windowsPerQuarter,
    shapes: new Set(result.paths.map(pathShape)).size,
    seconds,
  };
  rows.push(row);

  console.log(
    `${row.id.padEnd(18)} composites ${String(row.composites).padStart(2)}  ` +
      `largest ${String(row.largest)} (bodies ${String(row.largestBodies)})  ` +
      `arc ${row.arcDeg.toFixed(0).padStart(3)}  ` +
      `stories ${String(row.stories).padStart(2)}  paths ${String(row.paths).padStart(4)}  ` +
      `windows ${String(row.windows).padStart(3)}  ` +
      `per quarter ${row.perQuarter.toFixed(2).padStart(5)}  ` +
      `shapes ${String(row.shapes).padStart(3)}  ${row.seconds.toFixed(1)}s`,
  );
}

// --- the table that goes in the commit message -------------------------------

console.log(`\n| chart | largest composite | arc | stories | windows | per quarter | shapes |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- |`);
for (const row of rows) {
  console.log(
    `| ${row.id} | ${String(row.largest)} | ${row.arcDeg.toFixed(0)} | ` +
      `${String(row.stories)} | ${String(row.windows)} | ` +
      `${row.perQuarter.toFixed(2)} | ${String(row.shapes)} |`,
  );
}

const densities = rows.map((row) => row.perQuarter).sort((a, b) => a - b);
const total = densities.reduce((sum, value) => sum + value, 0);
const middle = densities.length / 2;
const median =
  densities.length % 2 === 0
    ? ((densities[middle - 1] ?? 0) + (densities[middle] ?? 0)) / 2
    : (densities[Math.floor(middle)] ?? 0);

console.log(
  `\nwindows per quarter across the panel: ` +
    `min ${(densities[0] ?? 0).toFixed(2)}  ` +
    `median ${median.toFixed(2)}  ` +
    `mean ${(total / densities.length).toFixed(2)}  ` +
    `max ${(densities[densities.length - 1] ?? 0).toFixed(2)}`,
);
console.log(
  `inside the [0.5, 2.5] target band: ` +
    `${String(densities.filter((value) => value >= 0.5 && value <= 2.5).length)} of ${String(densities.length)}`,
);
console.log(`total funnel time: ${rows.reduce((sum, row) => sum + row.seconds, 0).toFixed(1)}s`);
