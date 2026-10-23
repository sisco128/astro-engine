/**
 * Who may reach /mcp, and what never reaches the logs.
 *
 * Two credentials, one per kind of client: an API key in a header for Claude
 * Code and the Messages API, and a token in the path for claude.ai, which can
 * send no header at all. The tests that matter most are the ones about the
 * boundary between them — a token is not a key and a key is not a token —
 * because a leaked connector URL must not open /v1.
 *
 * The logger writes to a stream this file reads, through the `logStream`
 * seam, because "the token never reaches a log" is a claim about the logs and
 * only reading them can check it. `LOG_LEVEL` is `info` here for the same
 * reason; every other contract file keeps it silent.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'info';

const KEY = 'mcp-auth-key-0b7d3e';
const TOKEN = 'UrlToken_4f9a2c7e1b8d6f30a5c9e2b7d4f1a8c3';
const WRONG_TOKEN = 'WrongToken_9e3b6d1f4a7c2e8b5d0f3a6c9e2b';
process.env['API_KEYS'] = KEY;
process.env['MCP_URL_TOKENS'] = TOKEN;
process.env['POOL_SIZE'] = '1';

const { buildApp } = await import('../../src/http/app.js');

const MCP = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'auth-test', version: '0' },
  },
};

/** 12 Aug 1987, 09:32 UT — the reference chart. */
const ROME_1987 = {
  when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

const logLines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logStream: { write: (line) => logLines.push(line) } });
  await app.ready();
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function post(
  url: string,
  headers: Record<string, string>,
  payload: object = INITIALIZE,
): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url, headers: { ...MCP, ...headers }, payload });
}

describe('POST /mcp, by header', () => {
  it('refuses a caller with no key, in the usual envelope', async () => {
    const response = await post('/mcp', {});
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a valid x-api-key', async () => {
    expect((await post('/mcp', { 'x-api-key': KEY })).statusCode).toBe(200);
  });

  it('accepts the same key as a bearer token, which is how the Messages API sends it', async () => {
    expect((await post('/mcp', { authorization: `Bearer ${KEY}` })).statusCode).toBe(200);
  });

  it('refuses a bearer token that is not a key', async () => {
    expect((await post('/mcp', { authorization: 'Bearer nope' })).statusCode).toBe(401);
  });

  it('does not extend bearer tokens to /v1, whose contract names x-api-key alone', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      headers: { authorization: `Bearer ${KEY}` },
      payload: ROME_1987,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /mcp/:token, for claude.ai', () => {
  it('accepts a valid token with no key at all', async () => {
    expect((await post(`/mcp/${TOKEN}`, {})).statusCode).toBe(200);
  });

  it('runs the tools on a token alone, so the in-process calls need no key from the caller', async () => {
    const response = await post(
      `/mcp/${TOKEN}`,
      {},
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'natal_chart', arguments: ROME_1987 },
      },
    );
    expect(response.statusCode).toBe(200);
    const { result } = response.json<{ result: { isError?: boolean } }>();
    expect(result.isError).toBeUndefined();
  });

  it('refuses a wrong token without echoing it', async () => {
    const response = await post(`/mcp/${WRONG_TOKEN}`, {});
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    expect(response.body).not.toContain(WRONG_TOKEN);
  });

  it('refuses a wrong token even alongside a valid key: the path is checked on its own', async () => {
    expect((await post(`/mcp/${WRONG_TOKEN}`, { 'x-api-key': KEY })).statusCode).toBe(401);
  });

  it('does not take an API key in the path', async () => {
    expect((await post(`/mcp/${KEY}`, {})).statusCode).toBe(401);
  });

  it('refuses GET on a wrong token before saying the method is not allowed', async () => {
    const wrong = await app.inject({ method: 'GET', url: `/mcp/${WRONG_TOKEN}` });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({ method: 'GET', url: `/mcp/${TOKEN}` });
    expect(right.statusCode).toBe(405);
  });
});

describe('a token is not a key', () => {
  it('does not open /v1 when presented as x-api-key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      headers: { 'x-api-key': TOKEN },
      payload: ROME_1987,
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not open /mcp when presented as x-api-key', async () => {
    expect((await post('/mcp', { 'x-api-key': TOKEN })).statusCode).toBe(401);
  });
});

describe('the logs', () => {
  it('never contain a token, right or wrong, and show where one was redacted', async () => {
    // Every request above has been logged by now; one more of each, to be
    // independent of test order.
    await post(`/mcp/${TOKEN}`, {});
    await post(`/mcp/${WRONG_TOKEN}`, {});

    const written = logLines.join('');
    expect(written).toContain('/mcp/:token');
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(WRONG_TOKEN);
  });

  it('never contain the key either', () => {
    expect(logLines.join('')).not.toContain(KEY);
  });
});
