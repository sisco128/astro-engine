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

/** Every resonance of a tier against the members of one story. */
function tierResonances(input: {
  config: TierConfig;
  tier: TierId;
  story: Story;
  natalLon: ReadonlyMap<string, number>;
  fromJd: JulianDayUT;
  toJd: JulianDayUT;
}): Resonance[] {
  const { config, tier, story, natalLon, fromJd, toJd } = input;
  const found: Resonance[] = [];

  for (const body of config.bodies) {
    for (const member of new Set(story.members)) {
      const lon = natalLon.get(member);
      if (lon === undefined) continue;

      found.push(
        ...resonancesFor({
          body,
          member,
          natalLon: lon,
          fromJd,
          toJd,
          options: { orbDeg: config.orbDeg, aspects: config.aspects, tier },
        }),
      );
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

  for (const story of stories) {
    const shared = { story, natalLon, fromJd, toJd };
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
