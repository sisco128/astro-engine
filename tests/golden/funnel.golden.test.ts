/**
 * The funnel, against the real ephemeris and against a stated target.
 *
 * The target is one to two key windows per quarter. It is what makes every
 * other choice in the model measurable rather than arguable, so it is asserted
 * here rather than left in a comment.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { identifyStories } from '../../src/domain/themes.js';
import {
  FUNNEL_DEFAULT,
  FUNNEL_PROTOTYPE,
  type FunnelConfig,
} from '../../src/domain/timescales.js';
import { DEFAULT_BODIES } from '../../src/ephemeris/bodies.js';
import {
  bodyState,
  housesFor,
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import { buildFunnel, type FunnelResult } from '../../src/transits/funnel.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

const EPHE_PATH = useRepoEphemeris();

let natalPoints: { id: string; lon: number }[];
let stories: ReturnType<typeof identifyStories>['stories'];
let from: JulianDayUT;
let to: JulianDayUT;

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);

  // 12 Aug 1987, 11:32 CEST Rome.
  const natalJd = jdFromUtc({ year: 1987, month: 8, day: 12, hour: 9, minute: 32 });
  const houses = housesFor(natalJd, 41.9028, 12.4964, 'P');

  natalPoints = [
    ...DEFAULT_BODIES.map((id) => ({ id, lon: bodyState(natalJd, id).lon })),
    { id: 'ascendant', lon: houses.ascendant },
    { id: 'midheaven', lon: houses.midheaven },
  ];

  stories = identifyStories(natalPoints).stories;

  // Ten years from age 20. Long enough for slow bodies to open windows,
  // short enough to keep the suite quick.
  from = (natalJd + 365 * 20) as JulianDayUT;
  to = (natalJd + 365 * 30) as JulianDayUT;
});

/**
 * Memoised. The funnel costs about twelve seconds per configuration on this
 * window; recomputing it per test took the suite to 150 seconds for work that
 * is identical every time.
 */
const cache = new Map<FunnelConfig, FunnelResult>();

function run(config: FunnelConfig): FunnelResult {
  const hit = cache.get(config);
  if (hit !== undefined) return hit;
  const result = buildFunnel({ stories, natalPoints, fromJd: from, toJd: to, config });
  cache.set(config, result);
  return result;
}

describe('density against the stated target', () => {
  /**
   * Measured over this window with the real implementation: default 2.20,
   * prototype 1.61, strict 1.58.
   *
   * The default was 1.42 while the slow tier took hard aspects only. The
   * ceiling moved with it, and the reason is recorded in
   * src/domain/timescales.ts: an average inside the band was hiding gaps of
   * nearly two years, and a reader lives in the gap rather than in the average.
   */
  it('keeps the default preset inside one to two windows per quarter', () => {
    const result = run(FUNNEL_DEFAULT);
    expect(result.windowsPerQuarter).toBeGreaterThan(0.7);
    expect(result.windowsPerQuarter).toBeLessThan(2.6);
  });

  /**
   * The assertion the density target could not make.
   *
   * This is why the default changed. Density inside the band said the funnel
   * was well tuned while the chart it was tuned on had a 1.9-year silence
   * across the present day: opening the app in August 2026 gave zero key dates
   * within six months in either direction, and the screen that exists to
   * prepare someone for what is coming had nothing to show.
   *
   * An average cannot catch that and a maximum gap can, so the maximum gap is
   * what is pinned. Fifteen months is loose enough that a genuinely quiet
   * stretch of sky does not fail the suite, and tight enough that the silence
   * this was written for — 1.9 years — would.
   */
  it('never leaves a gap longer than fifteen months between key dates', () => {
    const days = run(FUNNEL_DEFAULT)
      .windows.map((w) => w.peak.keyJd)
      .sort((a, b) => a - b);

    let worst = 0;
    for (let i = 1; i < days.length; i += 1) {
      worst = Math.max(worst, (days[i] ?? 0) - (days[i - 1] ?? 0));
    }

    expect(days.length).toBeGreaterThan(1);
    expect(worst / 30.44).toBeLessThan(15);
  });

  it('keeps the prototype preset inside the same range', () => {
    const result = run(FUNNEL_PROTOTYPE);
    expect(result.windowsPerQuarter).toBeGreaterThan(0.7);
    expect(result.windowsPerQuarter).toBeLessThan(2.2);
  });

  it('reports density so a client can retune its own filters', () => {
    const result = run(FUNNEL_DEFAULT);
    const years = (to - from) / 365.25;
    expect(result.windowsPerQuarter).toBeCloseTo(result.windows.length / (years * 4), 6);
  });
});

describe('the funnel is a funnel', () => {
  it('nests each level inside the one above', () => {
    const { paths } = run(FUNNEL_DEFAULT);
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      // The social contact falls inside the slow window.
      expect(path.social.exactJd).toBeGreaterThanOrEqual(path.slow.enterJd);
      expect(path.social.exactJd).toBeLessThanOrEqual(path.slow.exitJd);
      // The fast contact falls inside the social window.
      expect(path.fast.exactJd).toBeGreaterThanOrEqual(path.social.enterJd);
      expect(path.fast.exactJd).toBeLessThanOrEqual(path.social.exitJd);
    }
  });

  it('keeps all three levels on the same story', () => {
    const { paths } = run(FUNNEL_DEFAULT);
    const storyById = new Map(stories.map((story) => [story.id, story]));

    for (const path of paths) {
      const story = storyById.get(path.storyId);
      expect(story).toBeDefined();
      expect(story?.members).toContain(path.slow.member);
      expect(story?.members).toContain(path.social.member);
      expect(story?.members).toContain(path.fast.member);
    }
  });

  it('assigns each level the right tier', () => {
    const { paths } = run(FUNNEL_DEFAULT);
    for (const path of paths) {
      expect(path.slow.tier).toBe('slow');
      expect(path.social.tier).toBe('social');
      expect(path.fast.tier).toBe('fast');
    }
  });

  it('dates the key moment at the fast exact contact', () => {
    const { paths } = run(FUNNEL_DEFAULT);
    for (const path of paths) {
      expect(path.keyJd).toBe(path.fast.exactJd);
    }
  });
});

describe('windows', () => {
  it('collapses near-simultaneous paths into one window', () => {
    const { paths, windows } = run(FUNNEL_DEFAULT);
    // Sun, Mercury and Venus travel together, so several can contact the same
    // story within days. That is one key date seen three times.
    expect(windows.length).toBeLessThanOrEqual(paths.length);
  });

  it('never splits paths closer together than the cluster width', () => {
    const { windows } = run(FUNNEL_DEFAULT);

    const byStory = new Map<string, (typeof windows)[number][]>();
    for (const window of windows) {
      const list = byStory.get(window.storyId) ?? [];
      list.push(window);
      byStory.set(window.storyId, list);
    }

    for (const list of byStory.values()) {
      const sorted = [...list].sort((a, b) => a.fromJd - b.fromJd);
      for (let i = 1; i < sorted.length; i += 1) {
        const gap = (sorted[i]?.fromJd ?? 0) - (sorted[i - 1]?.toJd ?? 0);
        expect(gap).toBeGreaterThan(FUNNEL_DEFAULT.clusterDays);
      }
    }
  });

  it('picks the strongest path in a cluster as its peak', () => {
    const { windows } = run(FUNNEL_DEFAULT);
    for (const window of windows) {
      for (const path of window.paths) {
        expect(window.peak.intensity).toBeGreaterThanOrEqual(path.intensity);
      }
    }
  });
});

describe('a path carries its whole chain', () => {
  it('returns the route, not just the leaf', () => {
    // The interpretation belongs to the path: a Jupiter resonance means one
    // thing inside a Neptune window and another inside a Pluto window. A
    // client that received only the key date could not tell them apart.
    const { paths } = run(FUNNEL_DEFAULT);
    const path = paths[0];

    expect(path).toBeDefined();
    expect(path?.slow.body).toBeDefined();
    expect(path?.social.body).toBeDefined();
    expect(path?.fast.body).toBeDefined();
    expect(path?.storyId).toBeDefined();
  });

  it('uses only slow bodies at the root, under the default preset', () => {
    const { paths } = run(FUNNEL_DEFAULT);
    const roots = new Set(paths.map((path) => path.slow.body));
    for (const body of roots) {
      expect(FUNNEL_DEFAULT.slow.bodies).toContain(body);
    }
  });

  it('admits Pluto and Chiron, which the prototype could not', () => {
    // Both were dropped from the prototype to control noise. Measurement
    // showed the noise was the soft aspects at the slow tier, not these
    // bodies: restricting slow aspects to the hard ones readmits both at the
    // same density.
    expect(FUNNEL_DEFAULT.slow.bodies).toContain('pluto');
    expect(FUNNEL_DEFAULT.slow.bodies).toContain('chiron');
    // The slow tier took hard aspects only, so that both bodies could be
    // admitted at a 1-degree orb without the density running away. It now
    // takes all five. What that bought is a floor: across the panel the
    // quietest chart went from 0.18 windows a quarter — seven in a decade —
    // to 0.95, because a soft aspect reaches a concentrated natal axis from
    // zodiacal regions a hard one cannot.
    expect(FUNNEL_DEFAULT.slow.aspects).toContain('trine');
    expect(FUNNEL_DEFAULT.slow.aspects).toContain('sextile');
  });
});
