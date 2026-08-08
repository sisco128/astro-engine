/**
 * Composite bodies: groups of points close enough to act as one.
 *
 * A proper weighted union-find replaces the prototype's hand-rolled merge
 * (themes.js:84-158). The rewrite fixes a specific defect rather than a vague
 * tidiness concern:
 *
 *   When two bodies already in the same group were found conjunct, the
 *   prototype pushed the new orb onto the group (themes.js:109) and did NOT
 *   recompute cohesion. Cohesion is only recalculated inside the merge branch
 *   at :120. So for any stellium of three or more, whichever conjunctions
 *   arrive after the group has formed contribute their orb to the list but
 *   never to the average — the reported cohesion is stale, computed from a
 *   subset of the orbs it claims to summarise.
 *
 * Union by size with path compression also removes the class of problem where
 * `groups[i]` and `planetToGroup` could disagree, which the prototype worked
 * around by re-deriving membership from the map afterwards (themes.js:135-157)
 * and never reading `group.planets` for anything load-bearing.
 */

import { separation, wrap360 } from '../math/angle.js';

export interface CompositeInput {
  readonly id: string;
  readonly lon: number;
}

export interface CompositeBody {
  /** One id for a lone body; two or more, sorted, for a fused group. */
  readonly members: readonly string[];
  /** 'single' | 'conjunction' (2) | 'stellium' (3+). */
  readonly type: 'single' | 'conjunction' | 'stellium';
  /** Circular mean of the members' longitudes. */
  readonly lon: number;
  /** Every pairwise orb that contributed to the fusion. */
  readonly orbs: readonly number[];
  /** Mean of `orbs`; 0 for a lone body. */
  readonly cohesion: number;
}

/**
 * Circular mean.
 *
 * A plain arithmetic mean is wrong for longitudes and wrong in exactly the
 * case that matters: a stellium straddling 0 Aries. Bodies at 359 and 1 have
 * a true midpoint of 0, and averaging the raw numbers gives 180 — the
 * diametric opposite. The prototype averaged raw values.
 */
function circularMean(longitudes: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const lon of longitudes) {
    const rad = (lon * Math.PI) / 180;
    x += Math.cos(rad);
    y += Math.sin(rad);
  }
  return wrap360((Math.atan2(y, x) * 180) / Math.PI);
}

class UnionFind {
  private readonly parent: number[];
  private readonly size: number[];

  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, i) => i);
    this.size = Array.from({ length: count }, () => 1);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) {
      root = this.parent[root] ?? root;
    }
    // Path compression: everything on the way up points straight at the root.
    let cursor = node;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor] ?? root;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const [large, small] =
      (this.size[rootA] ?? 0) >= (this.size[rootB] ?? 0) ? [rootA, rootB] : [rootB, rootA];

    this.parent[small] = large;
    this.size[large] = (this.size[large] ?? 0) + (this.size[small] ?? 0);
  }
}

/**
 * Fuse points that are within `orbDeg` of each other, transitively.
 *
 * Transitive by design: A conjunct B and B conjunct C puts all three in one
 * group even when A and C are further apart than the orb. That is the
 * prototype's behaviour and standard practice for stelliums.
 */
interface ConjunctPair {
  readonly a: number;
  readonly b: number;
  readonly orb: number;
}

/** Every pair within the orb, and the unions they imply. */
function findConjunctPairs(
  points: readonly CompositeInput[],
  orbDeg: number,
  uf: UnionFind,
): ConjunctPair[] {
  const pairs: ConjunctPair[] = [];

  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (a === undefined || b === undefined) continue;

      const orb = separation(a.lon, b.lon);
      if (orb <= orbDeg) {
        pairs.push({ a: i, b: j, orb });
        uf.union(i, j);
      }
    }
  }

  return pairs;
}

function groupBy(count: number, key: (index: number) => number): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const root = key(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }
  return groups;
}

function typeFor(memberCount: number): CompositeBody['type'] {
  if (memberCount === 1) return 'single';
  if (memberCount === 2) return 'conjunction';
  return 'stellium';
}

export function identifyComposites(
  points: readonly CompositeInput[],
  orbDeg: number,
): CompositeBody[] {
  const uf = new UnionFind(points.length);
  const pairs = findConjunctPairs(points, orbDeg, uf);

  // Attribute every contributing orb to the FINAL root, after all unions have
  // settled. This is the step the prototype could not do: it accrued orbs onto
  // whichever group happened to exist at the time, and never revisited the
  // average once a later pair joined an already-formed group.
  const orbsByRoot = new Map<number, number[]>();
  for (const pair of pairs) {
    const root = uf.find(pair.a);
    const list = orbsByRoot.get(root) ?? [];
    list.push(pair.orb);
    orbsByRoot.set(root, list);
  }

  const membersByRoot = groupBy(points.length, (index) => uf.find(index));
  const composites: CompositeBody[] = [];

  for (const [root, indices] of membersByRoot) {
    const members = indices
      .map((index) => points[index]?.id)
      .filter((id): id is string => id !== undefined)
      .sort();

    const longitudes = indices
      .map((index) => points[index]?.lon)
      .filter((lon): lon is number => lon !== undefined);

    const orbs = orbsByRoot.get(root) ?? [];
    const cohesion = orbs.length > 0 ? orbs.reduce((sum, orb) => sum + orb, 0) / orbs.length : 0;

    composites.push({
      members,
      type: typeFor(members.length),
      lon: circularMean(longitudes),
      orbs,
      cohesion,
    });
  }

  // Stable output order so a chartRef stays a content hash.
  composites.sort((a, b) => (a.members[0] ?? '').localeCompare(b.members[0] ?? ''));
  return composites;
}
