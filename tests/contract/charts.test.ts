/**
 * Contract tests for POST /v1/charts.
 *
 * These use Fastify's `inject`, so no port is bound. That is only possible
 * because `buildApp()` is pure: the prototype called `app.listen()` at module
 * load *and* exported the app (server/index.js:81-86), so importing it for a
 * test started a real server.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env['SE_EPHE_PATH'] ??= join(homedir(), 'Desktop/astro-engine/ephem');
// These tests assert on responses, not on stdout.
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** 12 Aug 1987, 11:32 CEST, Rome — the primary regression chart. */
const ROME_1987 = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
  houseSystem: 'P',
};

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface ChartBody {
  chartRef: string;
  utc: string;
  bodies: { id: string; lon: number; lonSpeed: number; retrograde: boolean; house: number }[];
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function postChart(payload: unknown): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url: '/v1/charts', payload: payload as object });
}

describe('POST /v1/charts', () => {
  it('resolves a local time through its zone', async () => {
    const response = await postChart(ROME_1987);
    expect(response.statusCode).toBe(200);

    const body = response.json<ChartBody>();
    // 11:32 CEST is 09:32 UT. The prototype's own regression test passed 11:32
    // in as though it were UT, making every number it asserted 2 hours wrong.
    expect(body.utc).toBe('1987-08-12T09:32:00Z');

    const sun = body.bodies.find((entry) => entry.id === 'sun');
    expect(sun).toBeDefined();
    // JPL Horizons for this instant: 139.1556495.
    expect(sun?.lon).toBeWithinArcsec(139.1556495, 1.0);
  });

  it('accepts a UTC instant directly and agrees with the local-time route', async () => {
    const viaUtc = await postChart({
      when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
      geo: ROME_1987.geo,
      houseSystem: 'P',
    });
    const viaLocal = await postChart(ROME_1987);

    // Same instant, same place, same system — therefore the same content hash.
    expect(viaUtc.json<ChartBody>().chartRef).toBe(viaLocal.json<ChartBody>().chartRef);
  });

  it('returns a strong ETag equal to the chart reference', async () => {
    const response = await postChart(ROME_1987);
    expect(response.headers.etag).toBe(`"${response.json<ChartBody>().chartRef}"`);
  });

  it('places every body in a house between 1 and 12', async () => {
    const body = (await postChart(ROME_1987)).json<ChartBody>();

    expect(body.bodies.length).toBeGreaterThanOrEqual(12);
    for (const entry of body.bodies) {
      expect(entry.house).toBeGreaterThanOrEqual(1);
      expect(entry.house).toBeLessThanOrEqual(12);
    }
  });

  it('reports retrograde from the sign of the speed', async () => {
    const body = (await postChart(ROME_1987)).json<ChartBody>();

    // The prototype read a field the binding does not emit, so this was false
    // for every body on every date. On 12 Aug 1987 the outer planets were
    // retrograde, so a suite that never sees a `true` here has regressed.
    expect(body.bodies.some((entry) => entry.retrograde)).toBe(true);

    for (const entry of body.bodies) {
      if (entry.retrograde) expect(entry.lonSpeed).toBeLessThan(0);
    }
    expect(body.bodies.find((entry) => entry.id === 'sun')?.retrograde).toBe(false);
  });
});

describe('the response carries numbers, not presentation', () => {
  /**
   * The pure-engine boundary, asserted rather than trusted. The prototype
   * shipped `formatted: "15 deg 23' Sign"` strings, glyphs, prose in
   * `analysis.interpretation` ("Placeholder: ... AI integration"), and a
   * `performance` block carrying process memory statistics.
   */
  const FORBIDDEN_KEYS = [
    'formatted',
    'symbol',
    'sign',
    'signIndex',
    'degrees',
    'minutes',
    'performance',
    'debug',
    'analysis',
    'interpretation',
  ];

  it('contains none of the forbidden keys anywhere in the payload', async () => {
    const payload = (await postChart(ROME_1987)).json<unknown>();
    const found: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          walk(item, `${path}[${String(index)}]`);
        });
        return;
      }
      if (node === null || typeof node !== 'object') return;

      for (const [key, value] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(key)) found.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };

    walk(payload, '$');
    expect(found).toEqual([]);
  });

  it('contains no glyph characters', async () => {
    const response = await postChart(ROME_1987);
    // Astrological and zodiac symbol blocks.
    expect(response.body).not.toMatch(/[☀-⛿←-⇿]/u);
  });
});

describe('error responses', () => {
  it('rejects a wall-clock time the clock skipped', async () => {
    const response = await postChart({
      when: {
        local: { year: 1978, month: 4, day: 30, hour: 2, minute: 30, zone: 'America/New_York' },
      },
      geo: { lat: 40.7128, lon: -74.006 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('NONEXISTENT_LOCAL_TIME');
  });

  it('returns both candidates for a wall-clock time that happened twice', async () => {
    const response = await postChart({
      when: {
        local: { year: 1978, month: 10, day: 29, hour: 1, minute: 30, zone: 'America/New_York' },
      },
      geo: { lat: 40.7128, lon: -74.006 },
    });

    expect(response.statusCode).toBe(409);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('AMBIGUOUS_LOCAL_TIME');
    expect(error.details?.['candidates']).toHaveLength(2);
  });

  it('refuses Placidus above the polar circle and suggests alternatives', async () => {
    const response = await postChart({
      when: { utc: { year: 1975, month: 6, day: 21, hour: 12, minute: 0 } },
      geo: { lat: 69.65, lon: 18.9553 },
      houseSystem: 'P',
    });

    expect(response.statusCode).toBe(422);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE');

    const suggested = error.details?.['suggestedSystems'] as { system: string }[];
    expect(suggested.length).toBeGreaterThan(0);
  });

  it('accepts a suggested system at that same latitude', async () => {
    // The suggestion has to actually work, or it is not a suggestion.
    const response = await postChart({
      when: { utc: { year: 1975, month: 6, day: 21, hour: 12, minute: 0 } },
      geo: { lat: 69.65, lon: 18.9553 },
      houseSystem: 'W',
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await postChart({ ...ROME_1987, hoseSystem: 'P' });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an out-of-range latitude', async () => {
    const response = await postChart({ ...ROME_1987, geo: { lat: 200, lon: 0 } });
    expect(response.statusCode).toBe(400);
  });

  it('never leaks a stack trace', async () => {
    // The prototype returned error.stack whenever NODE_ENV was development
    // (routes/activations.js:438).
    const response = await postChart({ nonsense: true });
    expect(response.body).not.toContain('at ');
    expect(response.body).not.toContain('.ts:');
  });
});

describe('service endpoints', () => {
  it('reports readiness with the ephemeris state', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('ready');
  });

  it('offers the source location, as AGPL section 13 requires', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/license' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ license: string; source: string }>();
    expect(body.license).toBe('AGPL-3.0-or-later');
    expect(body.source).toMatch(/^https?:\/\//);
  });

  it('returns a structured 404 rather than HTML', async () => {
    // The prototype's SPA catch-all returned index.html with status 200 for
    // any unknown path that did not begin with /api.
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
