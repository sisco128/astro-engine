/**
 * Contract tests for the MCP surface: POST /mcp, the five tools, and what
 * Claude receives from them.
 *
 * The property everything here leans on is parity. Each tool runs its /v1
 * route in process, so for the same input the MCP answer must be the /v1
 * answer plus the sign labels and the licence block, and nothing else — no
 * second calculation, no number that disagrees. `withoutAnnotations` strips
 * exactly those additions and the rest is compared whole.
 *
 * Keys are configured, as they are in every deployment, so every tool call
 * here also proves that the in-process calls get past the key hook. Who may
 * reach /mcp at all is tests/contract/mcp-auth.test.ts.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FetchLike } from '../../src/geo/nominatim.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const KEY = 'mcp-contract-key-5e81a2';
process.env['API_KEYS'] = KEY;
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');
const { ENGINE_VERSION } = await import('../../src/version.js');
const { env } = await import('../../src/config/env.js');

/** 12 Aug 1987, 11:32 CEST, Rome — the primary regression chart. */
const ROME_1987 = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

/** What a real client sends. The transport refuses a POST without both types. */
const HEADERS = {
  'x-api-key': KEY,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

const geoFetch: FetchLike = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve([
        {
          lat: '41.8933203',
          lon: '12.4829321',
          name: 'Roma',
          display_name: 'Roma, Roma Capitale, Lazio, Italia',
          address: { country_code: 'it' },
        },
      ]),
  });

interface ToolOutcome {
  isError: boolean;
  body: Record<string, unknown>;
  text: string;
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let app: FastifyInstance;
let nextId = 1;

beforeAll(async () => {
  app = await buildApp({ geoFetch });
  await app.ready();
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function rpc(method: string, params?: Record<string, unknown>): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: HEADERS,
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined ? { params } : {}) },
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.statusCode).toBe(200);
  const { result } = response.json<{
    result: { content: { type: string; text: string }[]; isError?: boolean };
  }>();
  const text = result.content[0]?.text ?? '';
  return {
    isError: result.isError === true,
    body: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown>,
    text,
  };
}

async function v1(url: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { 'x-api-key': KEY },
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

const ADDITIONS = new Set(['zodiac', 'zodiacAtKey', 'license']);

/** An MCP answer less what the MCP layer adds: what /v1 must have said. */
function withoutAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ADDITIONS.has(key))
        .map(([key, inner]) => [key, withoutAnnotations(inner)]),
    );
  }
  return value;
}

describe('the handshake', () => {
  it('names the engine, its version and where its source is', async () => {
    const response = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '0' },
    });

    expect(response.statusCode).toBe(200);
    const { result } = response.json<{
      result: {
        serverInfo: { name: string; version: string; websiteUrl: string };
        capabilities: { tools?: object };
        instructions: string;
      };
    }>();
    expect(result.serverInfo).toMatchObject({
      name: 'astro-engine',
      version: ENGINE_VERSION,
      websiteUrl: env.sourceUrl,
    });
    expect(result.capabilities.tools).toBeDefined();
  });

  it('carries the AGPL source offer and the unknown-birth-time rule in its instructions', async () => {
    const response = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '0' },
    });
    const { instructions } = response.json<{ result: { instructions: string } }>().result;

    expect(instructions).toContain('AGPL-3.0-or-later');
    expect(instructions).toContain(env.sourceUrl);
    expect(instructions).toContain('localDate');
    expect(instructions).toContain('03:00');
  });

  it('accepts the initialized notification without a body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(response.statusCode).toBe(202);
  });

  it('answers POST only: there is no stream to open and no session to end', async () => {
    // As a client sends them: GET asks for an event stream, DELETE has no body.
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/mcp',
        headers: { 'x-api-key': KEY, accept: 'text/event-stream' },
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('POST');
    }
  });
});

describe('tools/list', () => {
  interface Tool {
    name: string;
    inputSchema: {
      required?: string[];
      properties: Record<string, { enum?: string[]; maximum?: number }>;
    };
    annotations: { readOnlyHint?: boolean; openWorldHint?: boolean };
  }

  async function tools(): Promise<Tool[]> {
    const response = await rpc('tools/list');
    return response.json<{ result: { tools: Tool[] } }>().result.tools;
  }

  function tool(list: Tool[], name: string): Tool {
    const found = list.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no tool named ${name}`);
    return found;
  }

  it('offers exactly the five tools', async () => {
    expect((await tools()).map((entry) => entry.name).sort()).toEqual([
      'key_dates',
      'natal_chart',
      'planetary_returns',
      'search_place',
      'story_windows',
    ]);
  });

  it('marks every tool read-only, and only the geocoder as reaching outside', async () => {
    for (const entry of await tools()) {
      expect(entry.annotations.readOnlyHint, entry.name).toBe(true);
      expect(entry.annotations.openWorldHint, entry.name).toBe(entry.name === 'search_place');
    }
  });

  it('requires what /v1 requires and leaves the defaults optional', async () => {
    const chart = tool(await tools(), 'natal_chart');
    expect(chart.inputSchema.required?.sort()).toEqual(['geo', 'when']);
  });

  it('offers the funnel as presets only, and no scoring switch', async () => {
    const keyDates = tool(await tools(), 'key_dates');
    expect(keyDates.inputSchema.properties['funnel']?.enum?.sort()).toEqual([
      'funnel.default',
      'funnel.prototype',
      'funnel.strict',
    ]);
    expect(keyDates.inputSchema.properties).not.toHaveProperty('scoring');
  });

  it('caps story windows at twenty', async () => {
    const storyWindows = tool(await tools(), 'story_windows');
    expect(storyWindows.inputSchema.properties['limit']?.maximum).toBe(20);
  });
});

describe('natal_chart', () => {
  it('answers what POST /v1/charts answers, plus labels', async () => {
    const outcome = await callTool('natal_chart', ROME_1987);
    expect(outcome.isError).toBe(false);

    const direct = await v1('/v1/charts', ROME_1987);
    expect(withoutAnnotations(outcome.body)).toEqual(direct);
  });

  it('labels every ecliptic longitude', async () => {
    const { body } = await callTool('natal_chart', ROME_1987);
    const chart = body as {
      bodies: { id: string; zodiac: string }[];
      angles: { zodiac: Record<string, string> };
      houses: { zodiac: string[] };
      geo: object;
    };

    expect(chart.bodies.find((entry) => entry.id === 'sun')?.zodiac).toBe('19°09′ Leo');
    for (const entry of chart.bodies) expect(entry.zodiac, entry.id).toMatch(/^\d+°\d\d′ \w+$/);
    expect(Object.keys(chart.angles.zodiac).sort()).toEqual([
      'ascendant',
      'equatorialAscendant',
      'midheaven',
      'vertex',
    ]);
    expect(chart.houses.zodiac).toHaveLength(12);
    // A terrestrial longitude has no sign.
    expect(chart.geo).not.toHaveProperty('zodiac');
  });

  it('carries the source offer on the result itself', async () => {
    const { body } = await callTool('natal_chart', ROME_1987);
    expect(body['license']).toEqual({ id: 'AGPL-3.0-or-later', source: env.sourceUrl });
  });

  it('leaves /v1 exactly as it was: no labels reach the HTTP contract', async () => {
    await callTool('natal_chart', ROME_1987);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      headers: { 'x-api-key': KEY },
      payload: ROME_1987,
    });
    expect(response.body).not.toContain('zodiac');
    expect(response.body).not.toContain('license');
  });

  it('passes an engine refusal through as a tool error with its code', async () => {
    const outcome = await callTool('natal_chart', {
      when: {
        local: { year: 1978, month: 4, day: 30, hour: 2, minute: 30, zone: 'America/New_York' },
      },
      geo: { lat: 40.7128, lon: -74.006 },
    });

    expect(outcome.isError).toBe(true);
    expect((outcome.body as unknown as ErrorEnvelope).error.code).toBe('NONEXISTENT_LOCAL_TIME');
    expect(outcome.body['license']).toBeDefined();
  });

  it('refuses malformed arguments before reaching the engine', async () => {
    const outcome = await callTool('natal_chart', { when: ROME_1987.when });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/geo/);
  });
});

describe('key_dates', () => {
  const ONE_YEAR = { ...ROME_1987, from: '2026-01-01', to: '2027-01-01' };

  it('answers what POST /v1/transits/key-dates answers, plus labels', async () => {
    const outcome = await callTool('key_dates', ONE_YEAR);
    expect(outcome.isError).toBe(false);

    const direct = await v1('/v1/transits/key-dates', {
      ...ONE_YEAR,
      houseSystem: 'P',
      funnel: 'funnel.default',
    });
    expect(withoutAnnotations(outcome.body)).toEqual(direct);
  }, 60_000);

  it('labels both sides of every story and where every transiting body stood', async () => {
    const { body } = await callTool('key_dates', ONE_YEAR);
    const result = body as {
      stories: { a: { zodiac: string }; b: { zodiac: string } }[];
      keyDates: { path: { zodiacAtKey: string }[] }[];
    };

    expect(result.stories.length).toBeGreaterThan(0);
    expect(result.keyDates.length).toBeGreaterThan(0);
    for (const story of result.stories) {
      expect(story.a.zodiac).toMatch(/′/);
      expect(story.b.zodiac).toMatch(/′/);
    }
    for (const keyDate of result.keyDates) {
      for (const step of keyDate.path) expect(step.zodiacAtKey).toMatch(/′/);
    }
  }, 60_000);

  it('refuses more than five years before any work is queued', async () => {
    const before = app.cache.stats;
    const outcome = await callTool('key_dates', {
      ...ROME_1987,
      from: '2026-01-01',
      to: '2031-01-03',
    });

    expect(outcome.isError).toBe(true);
    const { error } = outcome.body as unknown as ErrorEnvelope;
    expect(error.code).toBe('WINDOW_TOO_LARGE');
    expect(error.details).toMatchObject({ maxDays: 365 * 5 });
    // Nothing looked up, nothing stored: the refusal happened in the tool.
    expect(app.cache.stats).toEqual(before);
  });

  it('accepts a preset name and nothing else for the funnel', async () => {
    const outcome = await callTool('key_dates', {
      ...ONE_YEAR,
      funnel: { nesting: 'same-story', clusterDays: 5 },
    });
    expect(outcome.isError).toBe(true);
  });
});

describe('story_windows', () => {
  it('finds the windows of a story named by its key_dates signature', async () => {
    const { body } = await callTool('key_dates', {
      ...ROME_1987,
      from: '2026-01-01',
      to: '2027-01-01',
    });
    const signature = (body as { stories: { signature: string }[] }).stories[0]?.signature;
    expect(signature).toBeDefined();

    const args = { ...ROME_1987, signature, from: '2023-01-01', to: '2026-01-01', limit: 2 };
    const outcome = await callTool('story_windows', args);
    expect(outcome.isError).toBe(false);

    const direct = await v1('/v1/transits/story-windows', {
      ...args,
      houseSystem: 'P',
      funnel: 'funnel.default',
    });
    expect(withoutAnnotations(outcome.body)).toEqual(direct);

    const result = outcome.body as {
      story: { a: { zodiac: string } };
      windows: { path: { zodiacAtKey: string }[] }[];
    };
    expect(result.story.a.zodiac).toMatch(/′/);
    expect(result.windows.length).toBeLessThanOrEqual(2);
  }, 60_000);

  it('caps the limit at twenty', async () => {
    const outcome = await callTool('story_windows', {
      ...ROME_1987,
      signature: 'trine:mars+mercury+sun+venus|saturn+uranus',
      limit: 21,
    });
    expect(outcome.isError).toBe(true);
  });
});

describe('planetary_returns', () => {
  it('answers what POST /v1/transits/returns answers', async () => {
    const args = { when: ROME_1987.when, horizonYears: 40 };
    const outcome = await callTool('planetary_returns', args);
    expect(outcome.isError).toBe(false);

    const direct = await v1('/v1/transits/returns', args);
    expect(withoutAnnotations(outcome.body)).toEqual(direct);
  }, 60_000);
});

describe('search_place', () => {
  it('turns a name into coordinates and a zone', async () => {
    const outcome = await callTool('search_place', { q: 'Roma' });
    expect(outcome.isError).toBe(false);

    const { results } = outcome.body as { results: { name: string; zone: string }[] };
    expect(results[0]).toMatchObject({ zone: 'Europe/Rome' });
  });
});
