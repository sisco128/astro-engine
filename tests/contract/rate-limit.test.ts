/**
 * Whose allowance is it.
 *
 * The question reads like configuration and decides whether two people can use
 * the app in the same minute. The key alone was the finest bucket this service
 * could form, and a frontend has one key for its whole audience — so every
 * reader shared one allowance, a single pass through the app spends a few
 * dozen calls, and the second reader in any minute was turned away. Out there
 * that arrives as a screen saying something broke, because nothing
 * distinguishes "slow down" from "broken" once it reaches a page.
 *
 * Both halves are pinned here, and the second is the one that matters more:
 * the subdivision must not become a way around the limit. A reader id is
 * whatever the caller typed, so it earns a bucket only underneath a key that
 * had to be right.
 *
 * `max` is set low so the assertions are about the boundary rather than about
 * waiting: `src/config/env.ts` reads `process.env` once at load, which is why
 * it is set before the import.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const KEY = 'rate-limit-key-8c2f10';
process.env['API_KEYS'] = KEY;
process.env['RATE_LIMIT_PER_MINUTE'] = '4';
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/**
 * A cheap authenticated request. The body is deliberately invalid: validation
 * fails long before any ephemeris work, and the limiter counts the request
 * either way — which is the whole point of asking it this way.
 */
async function knock(headers: Record<string, string>): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/charts',
    payload: {},
    headers: { 'x-api-key': KEY, ...headers },
  });
  return response.statusCode;
}

async function knockTimes(n: number, headers: Record<string, string>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(await knock(headers));
  return out;
}

describe('the allowance is per reader, inside a key', () => {
  it('turns a reader away after its own allowance, not the whole key’s', async () => {
    const statuses = await knockTimes(6, { 'x-caller-id': 'lettore-a' });

    // Four get through the limiter and fail validation; the rest are refused.
    expect(statuses.filter((status) => status === 400)).toHaveLength(4);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  it('leaves a second reader on the same key untouched', async () => {
    // The first reader has already spent its allowance in the test above. If
    // the bucket were the key — as it was — this would be a 429, and that is
    // exactly what a second person opening the app used to get.
    expect(await knock({ 'x-caller-id': 'lettore-b' })).toBe(400);
  });

  it('gives a reader id no allowance of its own without a valid key', async () => {
    // The guard the subdivision depends on. A caller who could mint buckets by
    // varying a header would have no limit at all, which is worse than sharing
    // one — so an unknown key is refused before the id is ever consulted.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: {},
      headers: { 'x-api-key': 'not-a-real-key', 'x-caller-id': 'chiunque' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('falls back to one bucket for the key when no reader is named', async () => {
    // A caller that names nobody is still counted — as the key, which is the
    // behaviour that existed before readers were separable.
    const statuses = await knockTimes(6, {});
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});
