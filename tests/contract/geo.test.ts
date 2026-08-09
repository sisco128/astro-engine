/**
 * Contract tests for GET /v1/geo/search.
 *
 * The upstream is a stub injected through `buildApp({ geoFetch })`. Nothing
 * here reaches the network — which for a service that allows one request per
 * second and blocks addresses that exceed it is not a preference: a suite that
 * called Nominatim for real would be flaky *and* a breach of the policy this
 * endpoint was built to respect.
 *
 * geo-tz is not stubbed. The zone is the reason the endpoint exists, so the
 * assertion that Rome comes back as Europe/Rome is worth nothing if it is an
 * assertion about a mock.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FetchLike } from '../../src/geo/nominatim.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** Two rows as Nominatim's `format=jsonv2` returns them. */
const ROMA_ROWS = [
  {
    lat: '41.8933203',
    lon: '12.4829321',
    name: 'Roma',
    display_name: 'Roma, Roma Capitale, Lazio, Italia',
    address: { country_code: 'it' },
  },
  {
    lat: '30.9915',
    lon: '-97.4808',
    name: 'Roma',
    display_name: 'Roma, Bell County, Texas, United States',
    address: { country_code: 'us' },
  },
];

interface GeoBody {
  results: { name: string; lat: number; lon: number; zone: string; countryCode?: string }[];
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

/** Query strings the stub answers with something other than the Rome rows. */
const FAILING_QUERY = 'failville';

let app: FastifyInstance;
let upstreamCalls: string[] = [];

const geoFetch: FetchLike = (url) => {
  upstreamCalls.push(url);
  if (url.includes(FAILING_QUERY)) {
    return Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve(undefined),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(ROMA_ROWS),
  });
};

beforeAll(async () => {
  app = await buildApp({ geoFetch });
  await app.ready();
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  upstreamCalls = [];
});

describe('GET /v1/geo/search', () => {
  it('answers with coordinates and an IANA zone', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/geo/search?q=Roma&limit=2' });
    expect(response.statusCode).toBe(200);

    const body = response.json<GeoBody>();
    expect(body.results).toHaveLength(2);

    const [rome] = body.results;
    expect(rome?.name).toBe('Roma, Roma Capitale, Lazio, Italia');
    expect(rome?.lat).toBeCloseTo(41.8933203, 6);
    expect(rome?.lon).toBeCloseTo(12.4829321, 6);
    // The point of the endpoint: lat, lon and zone together, which is exactly
    // what POST /v1/charts needs and what no client should be assembling from
    // three sources of its own.
    expect(rome?.zone).toBe('Europe/Rome');
    expect(rome?.countryCode).toBe('IT');

    // Same name, different continent, different zone — which is why the
    // endpoint returns candidates rather than the prototype's limit=1 guess.
    expect(body.results[1]?.zone).toBe('America/Chicago');
  });

  it('defaults the limit rather than returning everything', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/geo/search?q=Roma' });
    expect(response.statusCode).toBe(200);
    expect(response.json<GeoBody>().results).toHaveLength(2);
  });

  it('serves a repeated query from the cache', async () => {
    // 'roma' is already cached by the tests above, so a fresh query is needed
    // to observe the miss.
    const url = '/v1/geo/search?q=Firenze';

    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });
    // Different spelling, same normalised query: still no second request.
    const third = await app.inject({ method: 'GET', url: '/v1/geo/search?q=%20%20FIRENZE%20' });

    expect(upstreamCalls).toHaveLength(1);
    expect(first.headers['x-cache']).toBe('miss');
    expect(second.headers['x-cache']).toBe('hit');
    expect(third.headers['x-cache']).toBe('hit');
    expect(third.json<GeoBody>()).toEqual(first.json<GeoBody>());
  });

  it('turns an upstream 500 into a 502 in the standard envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/geo/search?q=${FAILING_QUERY}`,
    });

    expect(response.statusCode).toBe(502);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('GEO_UPSTREAM_FAILED');
    expect(body.error.requestId).toBeTruthy();
    expect(body.error.details?.['status']).toBe(500);
    // Never a stack, in any environment.
    expect(body.error.message).not.toContain('at ');
  });

  it('does not take the rest of the engine down with it', async () => {
    // The failure is contained by construction — no other route calls the
    // geocoder — and this is the assertion that keeps it that way.
    await app.inject({ method: 'GET', url: `/v1/geo/search?q=${FAILING_QUERY}` });

    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);

    const chart = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: {
        when: {
          local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' },
        },
        geo: { lat: 41.9028, lon: 12.4964 },
      },
    });
    expect(chart.statusCode).toBe(200);
  });
});

describe('validation', () => {
  async function expectRejected(url: string): Promise<ErrorBody> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);

    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // A rejected query must never have cost a rate-limited upstream request.
    expect(upstreamCalls).toHaveLength(0);
    return body;
  }

  it('rejects a missing q', async () => {
    await expectRejected('/v1/geo/search');
  });

  it('rejects an empty q', async () => {
    await expectRejected('/v1/geo/search?q=');
  });

  it('rejects a q that is only whitespace', async () => {
    // Empty wearing a disguise. Forwarding it would spend one of the
    // upstream's requests per second to be told nothing.
    await expectRejected('/v1/geo/search?q=%20%20%20');
  });

  it('rejects a q longer than 200 characters, and accepts one of exactly 200', async () => {
    await expectRejected(`/v1/geo/search?q=${'a'.repeat(201)}`);

    const accepted = await app.inject({
      method: 'GET',
      url: `/v1/geo/search?q=${'b'.repeat(200)}`,
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('rejects a limit that is not a number, or is out of range', async () => {
    await expectRejected('/v1/geo/search?q=roma&limit=abc');
    await expectRejected('/v1/geo/search?q=roma&limit=0');
    await expectRejected('/v1/geo/search?q=roma&limit=99');
  });

  it('rejects an unknown query parameter instead of ignoring it', async () => {
    // `?limt=10` silently returning the default five is the failure mode this
    // costs nothing to rule out.
    const body = await expectRejected('/v1/geo/search?q=roma&limt=10');
    expect(JSON.stringify(body.error.details)).toContain('limt');
  });
});
