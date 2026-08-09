/**
 * An in-process result cache.
 *
 * Every response is a deterministic function of its input, so caching is
 * purely a cost question — there is no staleness risk from the calculation
 * itself. The risk is staleness from the ENGINE changing underneath, which is
 * why the key carries the engine version and the ephemeris manifest hash: a
 * deploy or a data change invalidates everything without anyone remembering to
 * flush. The prototype's only cache was an unbounded `Map` of geocoding
 * results (server/geocoding.js:8) that never expired and grew forever.
 *
 * Bounded by entry count and by bytes. An LRU that only counts entries will
 * happily hold a hundred multi-megabyte payloads.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { LRUCache } from 'lru-cache';

import { env } from '../config/env.js';

/**
 * A fingerprint of the data the engine computes against.
 *
 * Read once at startup. If the manifest changes — a re-seed, a different
 * profile, an upstream revision like the one that moved Chiron by 0.01
 * arcseconds — every cached result becomes invalid, and this makes that
 * automatic rather than a thing to remember.
 */
function ephemerisFingerprint(): string {
  try {
    const manifest = readFileSync('ephemeris.manifest.json', 'utf8');
    return createHash('sha256').update(manifest).digest('base64url').slice(0, 12);
  } catch {
    // No manifest reachable (a test, or a checkout without one). Fall back to
    // a marker rather than a constant, so such a process never shares a key
    // space with one that has real data.
    return 'no-manifest';
  }
}

const FINGERPRINT = ephemerisFingerprint();

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export class ResultCache {
  private readonly lru: LRUCache<string, string>;
  private readonly version: string;
  private hits = 0;
  private misses = 0;

  constructor(version: string, options: { maxItems?: number; maxBytes?: number } = {}) {
    this.version = version;
    this.lru = new LRUCache<string, string>({
      max: options.maxItems ?? env.cacheMaxItems,
      maxSize: options.maxBytes ?? env.cacheMaxBytes,
      sizeCalculation: (value) => Buffer.byteLength(value, 'utf8'),
      ttl: 60 * 60 * 1000,
    });
  }

  /**
   * A content-addressed key.
   *
   * `canonical` must contain everything that determines the result and nothing
   * that does not — a request id or a timestamp in here would make every
   * lookup a miss while looking like it worked.
   */
  key(canonical: unknown): string {
    const digest = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('base64url')
      .slice(0, 22);
    return `${this.version}:${FINGERPRINT}:${digest}`;
  }

  /**
   * The `T` here is an assertion, not an inference — nothing checks that what
   * comes back off the wire matches it, because the entry was serialised and
   * the type went with it. Kept because the alternative is `as` at every call
   * site, which hides the same assumption in more places.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  get<T>(key: string): T | undefined {
    const raw = this.lru.get(key);
    if (raw === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return JSON.parse(raw) as T;
  }

  set(key: string, value: unknown): void {
    this.lru.set(key, JSON.stringify(value));
  }

  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.lru.size };
  }

  clear(): void {
    this.lru.clear();
  }
}
