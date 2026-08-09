/**
 * Contract tests for GET /v1/meta/stats.
 *
 * Two things are being asserted, and the second matters more than the first.
 * That the counters are live — a stats endpoint returning three permanent
 * zeros would pass any shape-only test — and that the payload is *only*
 * counters. The prototype attached a `performance` block carrying process
 * memory statistics to every chart response it sent to every caller; a stats
 * endpoint is precisely where that comes back, so the exclusion is pinned here
 * rather than left to review.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';
process.env['API_KEYS'] = '';
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');

interface Stats {
  cache: { hits: number; misses: number; size: number };
  pool: { ready: boolean; queueDepth: number };
  process: { uptimeSeconds: number };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

async function stats(): Promise<Stats> {
  const response = await app.inject({ method: 'GET', url: '/v1/meta/stats' });
  expect(response.statusCode).toBe(200);
  return response.json<Stats>();
}

describe('the shape', () => {
  it('carries exactly three groups', async () => {
    expect(Object.keys(await stats()).sort()).toEqual(['cache', 'pool', 'process']);
  });

  it('reports the cache as hits, misses and size', async () => {
    const { cache } = await stats();

    expect(Object.keys(cache).sort()).toEqual(['hits', 'misses', 'size']);
    for (const value of Object.values(cache)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports the pool as readiness and queue depth', async () => {
    const { pool } = await stats();

    expect(Object.keys(pool).sort()).toEqual(['queueDepth', 'ready']);
    expect(pool.ready).toBe(true);
    expect(pool.queueDepth).toBe(0);
  });

  it('reports process uptime and nothing else about the process', async () => {
    const { process: proc } = await stats();

    expect(Object.keys(proc)).toEqual(['uptimeSeconds']);
    expect(proc.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('what it must never carry', () => {
  it('mentions no memory internals anywhere in the payload', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/stats' });

    // Against the serialised body, not the parsed object: a nested field named
    // `rss` three levels down is the version of this mistake that a key-by-key
    // check would miss.
    expect(response.body).not.toMatch(/heap|rss|memory|external|arrayBuffers/i);
  });

  it('leaks no configuration a caller could use', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/stats' });

    // Not the ephemeris path, not the key list, not the origins, not the
    // engine's own limits. Operational counters are the whole contract.
    expect(response.body).not.toMatch(/path|key|origin|env|version|host|port/i);
  });
});

describe('the counters are live', () => {
  it('moves hits and misses as results are cached and re-served', async () => {
    // The returns route is the cheapest one that goes through the cache: one
    // body, a short horizon. The first call misses and stores, the second hits.
    const payload = {
      when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
      bodies: ['jupiter'],
      horizonYears: 14,
    };

    const before = await stats();

    const first = await app.inject({ method: 'POST', url: '/v1/transits/returns', payload });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');

    const afterMiss = await stats();
    expect(afterMiss.cache.misses).toBeGreaterThan(before.cache.misses);
    expect(afterMiss.cache.size).toBeGreaterThan(before.cache.size);

    const second = await app.inject({ method: 'POST', url: '/v1/transits/returns', payload });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('hit');

    const afterHit = await stats();
    expect(afterHit.cache.hits).toBeGreaterThan(afterMiss.cache.hits);
  }, 120_000);
});
