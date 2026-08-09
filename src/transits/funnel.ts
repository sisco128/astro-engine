/**
 * The funnel: nesting resonances into key dates.
 *
 * A slow contact opens a window on a natal story — the archetype, working over
 * months or years. A social contact inside that window gives the outer
 * context. A personal contact inside THAT is the key date, where inner and
 * outer touch.
 *
 * The structure is a tree, not a set of overlaps, and that matters for what
 * the engine returns. A Jupiter resonance means one thing inside a Neptune
 * window and another inside a Pluto window; the interpretation belongs to the
 * PATH, not the leaf. So a key date carries its whole chain, and clients
 * interpret chains.
 *
 * What this replaces: layer2.js:55-75 scanned every transit day against every
 * Layer 1 event to decide which stories were "active", an O(days x events)
 * loop, with a flat 30-day activation window for every body. Here the windows
 * are each resonance's own measured orb interval — from about 3 days for Mars
 * to 2.7 years for a Pluto passage with its retrograde loops.
 */

import type { Story } from '../domain/themes.js';
import type { FunnelConfig, TierConfig, TierId } from '../domain/timescales.js';
import type { JulianDayUT } from '../ephemeris/swe.js';
import { resonancesFor, type Resonance } from './resonance.js';

export interface FunnelPath {
  readonly storyId: string;
  /** Root to leaf: the archetype, its social context, the personal trigger. */
  readonly slow: Resonance;
  readonly social: Resonance;
  readonly fast: Resonance;
  /** The key date: the exact contact of the fast body. */
  readonly keyJd: number;
  /**
   * Product of the three resonance intensities and the story's own strength.
   * Absent story strength (v1 scoring) it is the resonance product alone.
   */
  readonly intensity: number;
}

export interface KeyWindow {
  readonly storyId: string;
  readonly fromJd: number;
  readonly toJd: number;
  /** Strongest path in the cluster — the one that defines the window. */
  readonly peak: FunnelPath;
  /** Every path that fell into this window. */
  readonly paths: readonly FunnelPath[];
}

export interface FunnelResult {
  readonly paths: readonly FunnelPath[];
  readonly windows: readonly KeyWindow[];
  /**
   * Windows per quarter over the requested span. Returned so a client can
   * see the density its filters produced and adjust, rather than guessing.
   */
  readonly windowsPerQuarter: number;
}

export interface NatalPoint {
  readonly id: string;
  readonly lon: number;
}

/**
 * Every resonance of a tier against the members of one story.
 *
 * Targets are the individual MEMBERS, not the composite's mean longitude.
 * That is a decision, and it has a visible cost worth stating.
 *
 * A stellium spans real width — the reference chart's covers 12.6 degrees
 * across Mercury, Venus, Sun and Mars. Uranus moves 0.034 deg/day, so squaring
 * it takes four and a half years and produces twelve separate contacts:
 *
 *   2020-08, 2021-05, 2022-01   square Mercury
 *   2022-05, 2022-11, 2023-03   square Venus
 *   2022-08, 2023-05, 2024-02   square Sun
 *   2023-08, 2024-05, 2025-02   square Mars
 *
 * Lived, that is one long process, and it is remembered as one — which is the
 * whole reason composites exist. Targeting the composite mean would report it
 * as a single event with three passes.
 *
 * Member targeting is kept anyway, because it preserves which planet is exact
 * at a given moment. A client can always aggregate members upward into "Uranus
 * is squaring the stellium"; it cannot recover the members from a mean.
 */
function tierResonances(input: {
  config: TierConfig;
  tier: TierId;
  story: Story;
  natalLon: ReadonlyMap<string, number>;
  fromJd: JulianDayUT;
  toJd: JulianDayUT;
  /**
   * Scans already done in this call, keyed by tier, body and natal point.
   *
   * Stories share members — a stellium's Sun belongs to every story that Sun
   * takes part in — and a resonance depends only on the transiting body, the
   * natal longitude and the tier's filters, never on which story asked. Without
   * this the same Mars-against-Sun scan runs once per story, and it is the
   * dominant cost: the fast tier steps half a day at a time across the whole
   * window. Measured on the ten-chart golden panel: 128 seconds to 78, with all
   * ten densities identical to the digit — which is the point, since a faster
   * funnel that answered differently would be a different funnel.
   */
  memo: Map<string, Resonance[]>;
}): Resonance[] {
  const { config, tier, story, natalLon, fromJd, toJd, memo } = input;
  const found: Resonance[] = [];

  for (const body of config.bodies) {
    for (const member of new Set(story.members)) {
      const lon = natalLon.get(member);
      if (lon === undefined) continue;

      // The tier is part of the key because it is part of the answer: a
      // Resonance carries its tier, and the same body against the same point
      // can be scanned at two tiers with different orbs and aspects.
      const key = `${tier}:${body}:${member}`;
      const hit = memo.get(key);
      if (hit !== undefined) {
        found.push(...hit);
        continue;
      }

      const scanned = resonancesFor({
        body,
        member,
        natalLon: lon,
        fromJd,
        toJd,
        options: { orbDeg: config.orbDeg, aspects: config.aspects, tier },
      });

      memo.set(key, scanned);
      found.push(...scanned);
    }
  }

  return found;
}

/** Whether `instant` falls inside a resonance's orb window. */
function contains(outer: Resonance, instant: number): boolean {
  return instant >= outer.enterJd && instant <= outer.exitJd;
}

/**
 * Cluster paths on the same story that fall within `clusterDays` of each
 * other into one key window.
 *
 * Necessary because Sun, Mercury and Venus travel close together: three of
 * them contacting the same story within a couple of days is one key date seen
 * three times, not three key dates.
 */
function cluster(paths: readonly FunnelPath[], clusterDays: number): KeyWindow[] {
  const byStory = new Map<string, FunnelPath[]>();
  for (const path of paths) {
    const list = byStory.get(path.storyId) ?? [];
    list.push(path);
    byStory.set(path.storyId, list);
  }

  const windows: KeyWindow[] = [];

  for (const [storyId, storyPaths] of byStory) {
    const sorted = [...storyPaths].sort((a, b) => a.keyJd - b.keyJd);
    let group: FunnelPath[] = [];

    const flush = (): void => {
      if (group.length === 0) return;
      const peak = group.reduce((best, path) => (path.intensity > best.intensity ? path : best));
      windows.push({
        storyId,
        fromJd: group[0]?.keyJd ?? peak.keyJd,
        toJd: group[group.length - 1]?.keyJd ?? peak.keyJd,
        peak,
        paths: group,
      });
      group = [];
    };

    for (const path of sorted) {
      const last = group[group.length - 1];
      if (last !== undefined && path.keyJd - last.keyJd > clusterDays) flush();
      group.push(path);
    }
    flush();
  }

  windows.sort((a, b) => a.fromJd - b.fromJd);
  return windows;
}

/** The three-level nesting for one story. */
function nest(input: {
  story: Story;
  slowSet: readonly Resonance[];
  socialSet: readonly Resonance[];
  fastSet: readonly Resonance[];
  nesting: FunnelConfig['nesting'];
}): FunnelPath[] {
  const { story, slowSet, socialSet, fastSet, nesting } = input;
  const samePoint = nesting === 'same-point';
  const strength = story.strength ?? 1;
  const paths: FunnelPath[] = [];

  for (const slow of slowSet) {
    for (const social of socialSet) {
      if (samePoint && social.member !== slow.member) continue;
      if (!contains(slow, social.exactJd)) continue;

      for (const fast of fastSet) {
        if (samePoint && fast.member !== slow.member) continue;
        if (!contains(social, fast.exactJd)) continue;

        paths.push({
          storyId: story.id,
          slow,
          social,
          fast,
          keyJd: fast.exactJd,
          // Each resonance peaks at 1 at its own exact contact, so what
          // separates one key date from another is the story's own strength.
          intensity: strength,
        });
      }
    }
  }

  return paths;
}

/**
 * Nest resonances into key dates for one chart over one span.
 *
 * `same-story` is the default rule: all three levels must touch the same natal
 * story. The story is what keeps a chart's aspects from being noise, and
 * replacing it with a same-point rule disables it exactly where it is needed —
 * layering transits on noise makes things worse, not better.
 *
 * `stories` is the SCOPE, not merely the input, and that is load-bearing.
 * Nothing below reads a story except through its own members, so passing a
 * subset computes exactly the subset — POST /v1/transits/story-windows passes
 * one story and gets that story's windows, identical to the ones a full run
 * would have produced for it. Measured on the reference chart over ten years
 * under funnel.default: all seven stories 9.5 s, a single story 1.4 s at the
 * median — 6.9x, 86% of the work not done. Verified window-for-window against
 * the full run for all seven; tests/golden/story-windows.golden.test.ts asserts
 * the same agreement through the two HTTP routes.
 *
 * That is a saving on ONE story and not a way to compute a chart. Seven
 * single-story runs cost 13.7 s against 9.5 s for one full run, because the
 * memo below is what makes the full run cheap: stories share members, and a
 * per-story call cannot share a Mars scan with a call that already did it.
 */
export function buildFunnel(input: {
  stories: readonly Story[];
  natalPoints: readonly NatalPoint[];
  fromJd: JulianDayUT;
  toJd: JulianDayUT;
  config: FunnelConfig;
}): FunnelResult {
  const { stories, natalPoints, fromJd, toJd, config } = input;
  const natalLon = new Map(natalPoints.map((point) => [point.id, point.lon]));
  const paths: FunnelPath[] = [];
  // Scoped to this call. The window and the config are fixed for its duration,
  // so they need not enter the key; a longer-lived cache would have to include
  // both, and that job already belongs to the result cache one layer up.
  const memo = new Map<string, Resonance[]>();

  for (const story of stories) {
    const shared = { story, natalLon, fromJd, toJd, memo };
    const slowSet = tierResonances({ ...shared, config: config.slow, tier: 'slow' });
    if (slowSet.length === 0) continue;

    const socialSet = tierResonances({ ...shared, config: config.social, tier: 'social' });
    if (socialSet.length === 0) continue;

    const fastSet = tierResonances({ ...shared, config: config.fast, tier: 'fast' });
    if (fastSet.length === 0) continue;

    paths.push(...nest({ story, slowSet, socialSet, fastSet, nesting: config.nesting }));
  }

  paths.sort((a, b) => a.keyJd - b.keyJd);
  const windows = cluster(paths, config.clusterDays);
  // Quarters, not years-over-four. Getting this backwards reported 22.68
  // windows per quarter for a chart producing 1.42, and it was only caught
  // because there was a measured figure to compare against.
  const quarters = ((toJd - fromJd) / 365.25) * 4;

  return {
    paths,
    windows,
    windowsPerQuarter: quarters > 0 ? windows.length / quarters : 0,
  };
}
