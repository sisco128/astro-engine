/**
 * Contract tests for POST /v1/transits/returns and /v1/meta/life-phases.
 *
 * These cross the real process boundary: the scan runs in a pool worker, so
 * a green suite here also proves the second task kind survives serialization
 * — the first change to the worker protocol since it was written.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** 12 Aug 1987, 09:32 UT — the reference chart, without geo: returns need none. */
const ROME_1987 = {
  when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
};

interface ReturnEvent {
  body: string;
  aspect: string;
  side: 1 | -1;
  occurrence: number;
  ageYears: number;
  exact: string;
  enter: string;
  exit: string;
  durationDays: number;
  passes: string[];
  phase: { id: string; title: string; note: string } | null;
}

interface ReturnsBody {
  engine: { version: string; se: string };
  birth: { utc: string; jdUt: number };
  horizonYears: number;
  events: ReturnEvent[];
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

async function postReturns(payload: unknown): Promise<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: ReturnsBody;
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/transits/returns',
    payload: payload as object,
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.json<ReturnsBody>(),
  };
}

describe('POST /v1/transits/returns', () => {
  it('returns the life cycle of the four vocabulary bodies by default', async () => {
    const { statusCode, body } = await postReturns(ROME_1987);
    expect(statusCode).toBe(200);
    expect(body.horizonYears).toBe(100);

    const bodies = new Set(body.events.map((event) => event.body));
    expect(bodies).toEqual(new Set(['saturn', 'uranus', 'chiron', 'pluto']));
  });

  it('labels the first Saturn Return with its phase, near age 29', async () => {
    const { body } = await postReturns(ROME_1987);
    const saturnReturn = body.events.find(
      (event) =>
        event.body === 'saturn' && event.aspect === 'conjunction' && event.occurrence === 1,
    );

    expect(saturnReturn).toBeDefined();
    expect(saturnReturn?.phase?.id).toBe('saturn.return');
    expect(saturnReturn?.ageYears).toBeGreaterThan(28);
    expect(saturnReturn?.ageYears).toBeLessThan(30);
    // The retrograde passes arrive as instants, folded into one event.
    expect(saturnReturn?.passes.length).toBeGreaterThan(1);
  });

  it('keeps events in chronological order with ages to match', async () => {
    const { body } = await postReturns(ROME_1987);
    expect(body.events.length).toBeGreaterThan(10);

    for (let i = 1; i < body.events.length; i += 1) {
      const current = body.events[i];
      const previous = body.events[i - 1];
      if (current === undefined || previous === undefined) throw new Error('unreachable');
      expect(current.ageYears).toBeGreaterThanOrEqual(previous.ageYears);
    }
  });

  it('serves a repeat request from the cache', async () => {
    const payload = { ...ROME_1987, horizonYears: 60 };
    await postReturns(payload);
    const second = await postReturns(payload);
    expect(second.headers['x-cache']).toBe('hit');
  });

  it('computes an uncovered body and returns phase: null for it', async () => {
    const { body } = await postReturns({ ...ROME_1987, bodies: ['jupiter'], horizonYears: 15 });
    const jupiterReturn = body.events.find((event) => event.aspect === 'conjunction');

    expect(jupiterReturn).toBeDefined();
    expect(jupiterReturn?.phase).toBeNull();
    expect(jupiterReturn?.ageYears).toBeGreaterThan(11);
    expect(jupiterReturn?.ageYears).toBeLessThan(13);
  });

  it('rejects the Moon, excluded from transits for measured reasons', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transits/returns',
      payload: { ...ROME_1987, bodies: ['moon'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a horizon beyond a human lifetime', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transits/returns',
      payload: { ...ROME_1987, horizonYears: 500 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a geo field: returns do not depend on birthplace', async () => {
    // The schema is strict, so the unknown key fails loudly. A client
    // passing coordinates here believes they matter; telling it otherwise is
    // kinder than ignoring them.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transits/returns',
      payload: { ...ROME_1987, geo: { lat: 41.9, lon: 12.5 } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/meta/life-phases', () => {
  it('serves the whole vocabulary, chart-independent', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/life-phases' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      bodies: { body: string; phases: { id: string; aspect: string; side: number }[] }[];
    }>();

    expect(body.bodies.map((entry) => entry.body)).toEqual(['saturn', 'uranus', 'chiron', 'pluto']);
    // Four phases each: return, opposition, waxing and waning squares.
    for (const entry of body.bodies) {
      expect(entry.phases).toHaveLength(4);
    }
  });
});
