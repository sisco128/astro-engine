/**
 * The compute pool, and the property it exists for: that a heavy calculation
 * does not stop the service answering.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

const BIRTH = {
  when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  // Worker startup is asynchronous: each forks, initialises its own ephemeris
  // and reports back over IPC. app.ready() does not wait for that, and it
  // should not — /v1/ready returning 503 in the meantime is the correct
  // answer, not a race to hide.
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('the pool starts', () => {
  it('has at least one worker ready', () => {
    expect(app.pool.ready).toBe(true);
  });

  it('starts with an empty queue', () => {
    expect(app.pool.depth).toBe(0);
  });
});

describe('the event loop keeps answering', () => {
  /**
   * The reason the pool exists. Every Swiss Ephemeris call is synchronous C —
   * the old binding's "callbacks" were invoked inline too — so computing on
   * the request thread blocks everything, including health checks, for the
   * whole duration.
   *
   * Measured against the running service: a twelve-year span takes 15.8
   * seconds in a worker, and /v1/health answers in 1 to 2 milliseconds
   * throughout.
   */
  it('serves health checks while a calculation is in flight', async () => {
    const heavy = app.inject({
      method: 'POST',
      url: '/v1/transits/key-dates',
      payload: { ...BIRTH, from: '2015-01-01', to: '2025-01-01' },
    });

    // Sampled while the worker is busy.
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const startedAt = performance.now();
      const health = await app.inject({ method: 'GET', url: '/v1/health' });
      timings.push(performance.now() - startedAt);
      expect(health.statusCode).toBe(200);
    }

    const result = await heavy;
    expect(result.statusCode).toBe(200);

    // Generous against the 1-2ms observed, but far below the seconds a
    // blocked event loop would produce.
    const slowest = Math.max(...timings);
    expect(slowest).toBeLessThan(250);
  }, 120_000);
});

describe('the second line of defence', () => {
  /**
   * @fastify/under-pressure sat in package.json unregistered for the whole of
   * this project's history — the failure mode of a plugin that is a
   * dependency and nothing else. These two assertions are what keep it wired.
   */
  it('is registered', () => {
    expect(typeof app.isUnderPressure).toBe('function');
  });

  it('does not consider a healthy process to be under pressure', () => {
    // Also a check on the thresholds themselves. An event-loop budget or a
    // heap ceiling set too low would shed load permanently while looking like
    // a correctly configured service, and this suite has just run a 15-second
    // calculation through the pool without tripping it.
    expect(app.isUnderPressure()).toBe(false);
  });
});

describe('bounds and failures', () => {
  it('runs several requests concurrently without interleaving results', async () => {
    // Each worker has its own Swiss Ephemeris state, so concurrent work
    // cannot contend on the library's process-global struct. Two different
    // spans must come back with their own answers.
    const [shortSpan, longSpan] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/transits/key-dates',
        payload: { ...BIRTH, from: '2024-01-01', to: '2024-07-01' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/transits/key-dates',
        payload: { ...BIRTH, from: '2020-01-01', to: '2024-01-01' },
      }),
    ]);

    expect(shortSpan.statusCode).toBe(200);
    expect(longSpan.statusCode).toBe(200);

    const short = shortSpan.json<{ span: { days: number }; density: { windows: number } }>();
    const long = longSpan.json<{ span: { days: number }; density: { windows: number } }>();

    expect(short.span.days).toBeLessThan(long.span.days);
    expect(long.density.windows).toBeGreaterThanOrEqual(short.density.windows);
  }, 120_000);

  it('still refuses a span beyond the limit, before reaching a worker', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transits/key-dates',
      payload: { ...BIRTH, from: '2000-01-01', to: '2500-01-01' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('WINDOW_TOO_LARGE');
  });
});
