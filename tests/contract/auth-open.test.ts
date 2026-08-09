/**
 * The other half of the authentication contract: a development service with
 * no keys configured is open, exactly as it was before auth existed.
 *
 * A separate file rather than a describe block, because `src/config/env.ts`
 * parses `process.env` once at module load and this process has to observe a
 * different configuration from the one in auth.test.ts. Both variables are set
 * explicitly rather than left absent: a developer with API_KEYS exported in
 * their shell should not be able to turn this suite green or red by accident.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';
process.env['NODE_ENV'] = 'development';
process.env['API_KEYS'] = '';
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');

const ROME_1987 = {
  when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('no keys configured, in development', () => {
  it('starts at all', () => {
    // The production posture refuses this combination; development must not,
    // or every `pnpm dev` would need a key invented for it.
    expect(app.pool.ready).toBe(true);
  });

  it.each([
    ['/v1/health'],
    ['/v1/ready'],
    ['/v1/meta/license'],
    ['/v1/meta/stats'],
    ['/v1/meta/funnel'],
    ['/v1/meta/life-phases'],
    ['/v1/openapi.json'],
  ])('serves GET %s with no header at all', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
  });

  it('serves the compute routes with no header', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/charts', payload: ROME_1987 });
    expect(response.statusCode).toBe(200);
  });

  it('ignores a presented key rather than rejecting it', async () => {
    // No hook is registered when the list is empty, so there is nothing to
    // compare against and nothing to fail. A client configured for a keyed
    // deployment keeps working against a local one.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: ROME_1987,
      headers: { 'x-api-key': 'anything-at-all' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('still returns a structured 404 for an unknown path', async () => {
    // With keys configured this is a 401, because an anonymous caller learns
    // nothing about the surface. Without them, the 404 is the honest answer.
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});
