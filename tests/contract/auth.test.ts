/**
 * Contract tests for API-key authentication, with keys configured.
 *
 * `API_KEYS` is set before the dynamic `import()` below because
 * `src/config/env.ts` parses `process.env` once at module load — the same
 * reason every other contract file sets `LOG_LEVEL` up here. It is also why
 * the key-less case lives in its own file rather than in another describe
 * block: one process observes exactly one configuration.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const PRIMARY = 'primary-key-3f9c1d';
const SECONDARY = 'secondary-key-7a20b4';
// The space after the comma is deliberate: `list()` in env.ts trims entries,
// and a key that only works when the variable has no whitespace in it is the
// kind of thing that is discovered in production.
process.env['API_KEYS'] = `${PRIMARY}, ${SECONDARY}`;
// One worker: nothing here computes anything heavy, and the pool still has to
// start and stop for every route to be reachable.
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');

/** 12 Aug 1987, 09:32 UT — the reference chart. */
const ROME_1987 = {
  when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
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

describe('a request without a key', () => {
  it('is refused with the standard envelope, not a bare 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(401);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.requestId).toBeTruthy();
  });

  it('is refused on the compute routes too', async () => {
    const chart = await app.inject({ method: 'POST', url: '/v1/charts', payload: ROME_1987 });
    expect(chart.statusCode).toBe(401);

    // Refused before the body is even looked at: a malformed payload from an
    // anonymous caller is still a 401, never a 400 that reveals the schema.
    const nonsense = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: { nonsense: true },
    });
    expect(nonsense.statusCode).toBe(401);
    expect(nonsense.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('does not tell an anonymous caller which routes exist', async () => {
    // An unmatched path answers 401 rather than 404, so the response cannot be
    // used to enumerate the surface.
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(401);
  });
});

describe('a request with the wrong key', () => {
  it('is refused', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
      headers: { 'x-api-key': 'not-a-configured-key' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('is refused when the key is a prefix of a real one', async () => {
    // The comparison hashes both sides, so length tells an attacker nothing
    // and a prefix is simply a different key.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
      headers: { 'x-api-key': PRIMARY.slice(0, -1) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('never echoes what was presented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
      headers: { 'x-api-key': 'guessed-secret-value' },
    });

    expect(response.body).not.toContain('guessed-secret-value');
    expect(response.body).not.toContain(PRIMARY);
  });
});

describe('a request with a configured key', () => {
  it('is served', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/openapi.json',
      headers: { 'x-api-key': PRIMARY },
    });

    expect(response.statusCode).toBe(200);
  });

  it('is served for every key in the list, not only the first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/meta/funnel',
      headers: { 'x-api-key': SECONDARY },
    });

    expect(response.statusCode).toBe(200);
  });

  it('reaches the calculation it was asking for', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: ROME_1987,
      headers: { 'x-api-key': PRIMARY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ utc: string }>().utc).toBe('1987-08-12T09:32:00Z');
  });

  it('reaches the stats endpoint, which is not public', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/meta/stats' });
    expect(anonymous.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: 'GET',
      url: '/v1/meta/stats',
      headers: { 'x-api-key': PRIMARY },
    });
    expect(authenticated.statusCode).toBe(200);
  });
});

describe('the endpoints that stay public', () => {
  it('answers liveness without a key, for load balancers', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ok');
  });

  it('answers readiness without a key, for orchestrators', async () => {
    // A readiness probe that can fail on missing credentials is not a
    // readiness probe: the orchestrator would never route traffic here.
    const response = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('ready');
  });

  it('offers the source location without a key, as AGPL §13 requires', async () => {
    // Section 13 owes the offer to every user who interacts with the program
    // over a network — not only the ones holding a key. This one is a licence
    // obligation, not a convenience, and cannot be configured away.
    const response = await app.inject({ method: 'GET', url: '/v1/meta/license' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ license: string; source: string }>();
    expect(body.license).toBe('AGPL-3.0-or-later');
    expect(body.source).toMatch(/^https?:\/\//);
  });

  it('lets a nonsense key through on those three, rather than checking it', async () => {
    // The hook exempts the route before it looks at the header at all: a probe
    // that sends a stale key must not start failing.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-api-key': 'stale' },
    });

    expect(response.statusCode).toBe(200);
  });
});
