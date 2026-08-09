/**
 * The result cache.
 *
 * Responses are deterministic functions of their input, so there is no
 * staleness risk from the calculation. The risk is the ENGINE changing
 * underneath, which is what the key's version and ephemeris fingerprint exist
 * to catch.
 */

import { describe, expect, it } from 'vitest';

import { ResultCache } from '../../src/cache/result-cache.js';

describe('keys', () => {
  it('gives the same input the same key', () => {
    const cache = new ResultCache('1.0.0');
    const input = { chartRef: 'cr1_abc', fromJd: 100, toJd: 200 };
    expect(cache.key(input)).toBe(cache.key({ ...input }));
  });

  it('gives different inputs different keys', () => {
    const cache = new ResultCache('1.0.0');
    expect(cache.key({ span: 1 })).not.toBe(cache.key({ span: 2 }));
  });

  it('changes every key when the engine version changes', () => {
    // A deploy must invalidate results computed by the previous build, without
    // anyone remembering to flush.
    const before = new ResultCache('1.0.0');
    const after = new ResultCache('1.0.1');
    const input = { chartRef: 'cr1_abc' };
    expect(before.key(input)).not.toBe(after.key(input));
  });

  it('carries an ephemeris fingerprint in the key', () => {
    // The manifest hash is part of the namespace, so a re-seed or an upstream
    // data revision — like the one that moved Chiron by 0.01 arcseconds —
    // invalidates cached results automatically.
    const cache = new ResultCache('1.0.0');
    const key = cache.key({ anything: true });
    // version : fingerprint : digest
    expect(key.split(':')).toHaveLength(3);
    expect(key.startsWith('1.0.0:')).toBe(true);
  });
});

describe('storage', () => {
  it('returns what was stored', () => {
    const cache = new ResultCache('1.0.0');
    const key = cache.key({ a: 1 });
    cache.set(key, { windows: [1, 2, 3] });
    expect(cache.get<{ windows: number[] }>(key)?.windows).toEqual([1, 2, 3]);
  });

  it('returns undefined for a key it does not hold', () => {
    const cache = new ResultCache('1.0.0');
    expect(cache.get(cache.key({ missing: true }))).toBeUndefined();
  });

  it('counts hits and misses', () => {
    const cache = new ResultCache('1.0.0');
    const key = cache.key({ a: 1 });

    cache.get(key);
    cache.set(key, { value: 1 });
    cache.get(key);
    cache.get(key);

    expect(cache.stats).toMatchObject({ hits: 2, misses: 1, size: 1 });
  });

  it('hands back a copy, not the stored object', () => {
    // Entries are serialised, so a caller mutating a result cannot corrupt
    // what the next caller receives.
    const cache = new ResultCache('1.0.0');
    const key = cache.key({ a: 1 });
    cache.set(key, { list: [1] });

    const first = cache.get<{ list: number[] }>(key);
    first?.list.push(99);

    expect(cache.get<{ list: number[] }>(key)?.list).toEqual([1]);
  });
});

describe('bounds', () => {
  it('evicts by entry count', () => {
    const cache = new ResultCache('1.0.0', { maxItems: 3, maxBytes: 10 ** 9 });

    const keys = [1, 2, 3, 4].map((n) => cache.key({ n }));
    for (const key of keys) cache.set(key, { payload: 'x' });

    // The oldest is gone; the newest survives.
    expect(cache.get(keys[0] ?? '')).toBeUndefined();
    expect(cache.get(keys[3] ?? '')).toBeDefined();
  });

  it('evicts by bytes, not only by count', () => {
    // A cache bounded only by entry count will happily hold a hundred
    // multi-megabyte payloads. Key-dates responses are large.
    const cache = new ResultCache('1.0.0', { maxItems: 1000, maxBytes: 400 });

    const first = cache.key({ n: 1 });
    cache.set(first, { blob: 'a'.repeat(300) });
    cache.set(cache.key({ n: 2 }), { blob: 'b'.repeat(300) });

    expect(cache.get(first)).toBeUndefined();
  });

  it('empties on clear', () => {
    const cache = new ResultCache('1.0.0');
    cache.set(cache.key({ a: 1 }), { value: 1 });
    cache.clear();
    expect(cache.stats.size).toBe(0);
  });
});
