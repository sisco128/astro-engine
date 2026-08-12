/**
 * How long the funnel can go without saying anything.
 *
 * Every density measurement in this repository is an average — windows per
 * quarter over a decade or three. That number was inside its target while the
 * chart it was tuned on had nothing at all to show a reader: opening Navigate
 * on 12 August 2026 gave zero key dates within six months in either direction,
 * and the chart's highest-scoring story had never lit.
 *
 * An average cannot catch that. This measures the thing a reader actually
 * feels — the longest gap between key dates — alongside the density, so the
 * two can be read together. It is the evidence behind admitting the soft
 * aspects at the slow tier; see the note on FUNNEL_DEFAULT.
 *
 *   SE_EPHE_PATH=./ephem pnpm tsx scripts/measure-silence.ts [chart-id] [iso-day]
 */

import { identifyComposites } from '../src/domain/composites.js';
import type { Story } from '../src/domain/themes.js';
import { identifyStories } from '../src/domain/themes.js';
import type { FunnelConfig } from '../src/domain/timescales.js';
import { FUNNEL_DEFAULT, FUNNEL_PRESETS } from '../src/domain/timescales.js';
import { jdFromUtc, setEphemerisPath, setForbidFallback } from '../src/ephemeris/swe.js';
import { buildFunnel } from '../src/transits/funnel.js';
import { pathShape, REFERENCE_CHARTS, setUpChart } from '../tests/fixtures/reference-charts.js';

setEphemerisPath(process.env['SE_EPHE_PATH'] ?? './ephem');
setForbidFallback(true);

const wantedId = process.argv[2] ?? 'rome-1987';
const todayIso = process.argv[3] ?? '2026-08-12';

const chart = REFERENCE_CHARTS.find((c) => c.id === wantedId);
if (chart === undefined) {
  throw new Error(`no chart ${wantedId}; have ${REFERENCE_CHARTS.map((c) => c.id).join(', ')}`);
}

const { points } = setUpChart(chart);
const [y, m, d] = todayIso.split('-').map(Number);
const todayJd = jdFromUtc({ year: y ?? 2026, month: m ?? 1, day: d ?? 1, hour: 0, minute: 0 });

console.log(`chart ${chart.id}, "today" = ${todayIso}\n`);

const composites = identifyComposites(
  points.map((p) => ({ id: p.id, lon: p.lon })),
  8,
);
const { stories } = identifyStories(points);

console.log('STORIES, heaviest first');
for (const story of stories) {
  console.log(`  ${story.score.toFixed(2)}  ${story.id}`);
}
const biggest = composites.reduce((a, b) => (b.members.length > a.members.length ? b : a));
console.log(`\nlargest composite: ${biggest.members.join('+')} — never a story on its own,`);
console.log('because identifyStories pairs composites and never looks at one alone.\n');

function months(jd: number): number {
  return Math.round(((jd - todayJd) / 365.25) * 12);
}

/** Density, longest silence and variety, which is the whole point of this file. */
function report(label: string, config: FunnelConfig, backMonths: number, fwdMonths: number): void {
  const fromJd = todayJd - backMonths * 30.44;
  const toJd = todayJd + fwdMonths * 30.44;
  const funnel = buildFunnel({
    stories,
    natalPoints: points,
    fromJd: fromJd as typeof todayJd,
    toJd: toJd as typeof todayJd,
    config,
  });

  const days = funnel.windows.map((w) => w.peak.keyJd).sort((a, b) => a - b);
  let worst = 0;
  for (let i = 1; i < days.length; i += 1)
    worst = Math.max(worst, (days[i] ?? 0) - (days[i - 1] ?? 0));

  const near = funnel.windows.filter((w) => Math.abs(months(w.peak.keyJd)) <= 6);
  const lit = new Set(funnel.windows.map((w) => w.storyId));
  const top: Story | undefined = stories[0];

  console.log(
    `  ${label.padEnd(20)} ${String(funnel.windows.length).padStart(4)} win  ` +
      `${funnel.windowsPerQuarter.toFixed(2)}/qtr  ` +
      `worst gap ${(worst / 365.25).toFixed(1)}y  ` +
      `within 6mo ${String(near.length).padStart(2)}  ` +
      `lit ${String(lit.size)}/${String(stories.length)}  ` +
      `top story ${top !== undefined && lit.has(top.id) ? 'LIT' : 'dark'}  ` +
      `shapes ${String(new Set(funnel.paths.map(pathShape)).size)}`,
  );
}

console.log('THE THREE YEARS A READER IS ACTUALLY IN');
for (const [name, config] of Object.entries(FUNNEL_PRESETS)) report(name, config, 18, 18);

console.log('\nTHIRTY YEARS, THE BASIS THE DEFAULT WAS TUNED ON');
report('funnel.default', FUNNEL_DEFAULT, 180, 180);
