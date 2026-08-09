/**
 * Contract tests for GET /v1/openapi.json.
 *
 * This document is the only thing standing between the engine and the
 * hand-mirrored `client/src/types/api.ts` the prototype made every consumer
 * maintain. A document that is merely well-formed is worthless; what these
 * tests assert is that it still describes *this* engine — that it covers every
 * route the app actually registers, that its request bodies are real JSON
 * Schema derived from the validating zod schemas rather than empty objects,
 * and that the version it advertises is the version a live call returns.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** Every route a client can call, and therefore every route to document. */
const DOCUMENTED_PATHS = [
  '/v1/health',
  '/v1/ready',
  '/v1/meta/license',
  '/v1/meta/funnel',
  '/v1/meta/life-phases',
  '/v1/geo/search',
  '/v1/charts',
  '/v1/transits/key-dates',
  '/v1/transits/returns',
];

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; license: { identifier: string } };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, JsonSchema> };
}

interface Operation {
  operationId: string;
  summary: string;
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  parameters?: { name: string; in: string; required?: boolean; schema: JsonSchema }[];
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  $ref?: string;
  $schema?: string;
}

let app: FastifyInstance;
let raw: string;
let doc: OpenApiDocument;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await app.pool.whenReady();

  const response = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
  expect(response.statusCode).toBe(200);
  raw = response.body;
  // Parsed from the serialized body on purpose: a generator fetches bytes and
  // parses them, so that is what the test exercises.
  doc = JSON.parse(raw) as OpenApiDocument;
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('GET /v1/openapi.json', () => {
  it('serves a document that round-trips through JSON', () => {
    expect(JSON.stringify(JSON.parse(raw))).toBe(JSON.stringify(doc));
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('astro-engine');
    expect(doc.info.license.identifier).toBe('AGPL-3.0-or-later');
  });

  it('documents every path', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([...DOCUMENTED_PATHS].sort());
  });

  it('documents every route the app registers', () => {
    // The assertion that survives the next endpoint. Comparing against the
    // router rather than against a list in this file is what catches a route
    // added without a line in the document; the list above only catches one
    // being dropped.
    const registered = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((line) => /(\/v1\/\S*) \((.+)\)/.exec(line))
      .filter((match) => match !== null)
      .map((match) => ({ path: match[1] ?? '', methods: (match[2] ?? '').split(', ') }))
      // The document does not describe itself: a client generating a client
      // has it in hand already.
      .filter((route) => route.path !== '/v1/openapi.json');

    expect(registered.map((route) => route.path).sort()).toEqual([...DOCUMENTED_PATHS].sort());

    for (const route of registered) {
      const documented = doc.paths[route.path];
      expect(documented, `${route.path} is registered but not documented`).toBeDefined();
      // HEAD is Fastify's automatic companion to GET, not a distinct
      // operation, so it is not expected in the document.
      for (const method of route.methods) {
        if (method === 'HEAD') continue;
        expect(documented?.[method.toLowerCase()], `${method} ${route.path}`).toBeDefined();
      }
    }
  });

  it('names every operation, so generated clients get stable method names', () => {
    const ids = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    expect(ids).toHaveLength(DOCUMENTED_PATHS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('request bodies are real JSON Schema, converted from the zod schemas', () => {
  function requestSchema(path: string): JsonSchema {
    const schema = doc.paths[path]?.['post']?.requestBody?.content['application/json']?.schema;
    if (schema === undefined) throw new Error(`no request schema documented for POST ${path}`);
    return schema;
  }

  it('describes the charts body down to the `when` union', () => {
    const schema = requestSchema('/v1/charts');

    expect(schema.type).toBe('object');
    // .strict() on the zod side; a client that misspells a field should learn
    // about it from the contract, not from a 400.
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'bodies',
      'geo',
      'houseSystem',
      'when',
    ]);

    // The union is the part a generator most needs and the part a
    // hand-written type most often gets wrong: a birth moment is either a UTC
    // instant or a local wall-clock time with its zone, never a merge of both.
    const when = schema.properties?.['when'];
    expect(when?.anyOf).toHaveLength(2);

    const branches = (when?.anyOf ?? []).map((branch) => Object.keys(branch.properties ?? {}));
    expect(branches.sort()).toEqual([['local'], ['utc']]);

    const local = when?.anyOf?.find((branch) => branch.properties?.['local'] !== undefined);
    expect(Object.keys(local?.properties?.['local']?.properties ?? {})).toContain('zone');
  });

  it('leaves fields with a zod default optional on the wire', () => {
    // io: 'input'. Getting this backwards would tell every generated client
    // that houseSystem and bodies are required, when the engine supplies both.
    const required = requestSchema('/v1/charts').required ?? [];
    expect(required.sort()).toEqual(['geo', 'when']);
  });

  it('describes the key-dates body, funnel union included', () => {
    const schema = requestSchema('/v1/transits/key-dates');

    expect((schema.required ?? []).sort()).toEqual(['from', 'geo', 'to', 'when']);
    // Either a preset name or a full configuration — the client needs to see
    // both arms to offer either.
    expect(schema.properties?.['funnel']?.anyOf).toHaveLength(2);
  });

  it('describes the returns body, and offers neither `from` nor `geo`', () => {
    const schema = requestSchema('/v1/transits/returns');

    expect(schema.required ?? []).toEqual(['when']);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['bodies', 'horizonYears', 'when']);
  });

  it('embeds no $schema marker inside the request bodies', () => {
    // The document declares its dialect once; a repeated marker inside every
    // embedded schema is noise some generators trip over.
    for (const path of ['/v1/charts', '/v1/transits/key-dates', '/v1/transits/returns']) {
      expect(requestSchema(path).$schema).toBeUndefined();
    }
  });
});

describe('query parameters', () => {
  it('describes q and limit with the bounds that actually validate them', () => {
    // The one endpoint whose input is a query string rather than a body, so
    // the one whose input a generator reads from `parameters`. The numbers are
    // imported constants on the document's side; this is what checks they are
    // the same numbers a request is judged against.
    const parameters = doc.paths['/v1/geo/search']?.['get']?.parameters ?? [];
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));

    expect([...byName.keys()].sort()).toEqual(['limit', 'q']);
    for (const parameter of parameters) expect(parameter.in).toBe('query');

    expect(byName.get('q')?.required).toBe(true);
    expect(byName.get('q')?.schema.maxLength).toBe(200);

    const limit = byName.get('limit');
    expect(limit?.required).toBe(false);
    expect(limit?.schema.type).toBe('integer');
    expect(limit?.schema.minimum).toBe(1);
    expect(limit?.schema.default).toBe(5);
  });
});

describe('responses', () => {
  /** The 200 schema an operation documents, if it documents one. */
  function successSchema(path: string, method: string): JsonSchema | undefined {
    return doc.paths[path]?.[method]?.responses['200']?.content?.['application/json']?.schema;
  }

  it('describes the chart response from its zod schema', () => {
    const schema =
      doc.paths['/v1/charts']?.['post']?.responses['200']?.content?.['application/json']?.schema;

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'angles',
      'bodies',
      'chartRef',
      'engine',
      'geo',
      'houses',
      'jdUt',
      'utc',
    ]);
  });

  it('describes the geo search response from its zod schema', () => {
    // Also from zod, because the handler's return value is typed by that same
    // schema — the compiler is what keeps this description true, which is the
    // condition key-dates and returns do not yet meet.
    const result = successSchema('/v1/geo/search', 'get')?.properties?.['results']?.items;

    expect(Object.keys(result?.properties ?? {}).sort()).toEqual([
      'countryCode',
      'lat',
      'lon',
      'name',
      'zone',
    ]);
    // The three fields POST /v1/charts needs are the three a client must be
    // able to count on; the country code is a label and may be missing.
    expect((result?.required ?? []).sort()).toEqual(['lat', 'lon', 'name', 'zone']);
  });

  it('describes the responses with no zod schema coarsely rather than inventing one', () => {
    // Deliberate. A parallel zod schema written only for documentation would
    // be a second copy of the truth that nothing keeps equal to the handler.
    for (const path of ['/v1/transits/key-dates', '/v1/transits/returns']) {
      const response = doc.paths[path]?.['post']?.responses['200'];
      const schema = response?.content?.['application/json']?.schema;

      expect(schema?.type).toBe('object');
      expect(schema?.properties).toBeUndefined();
      expect(response?.description.length).toBeGreaterThan(40);
    }
  });

  it('documents the error envelope once and references it', () => {
    const envelope = doc.components.schemas['ErrorEnvelope'];
    expect(envelope?.required).toEqual(['error']);
    expect(Object.keys(envelope?.properties?.['error']?.properties ?? {}).sort()).toEqual([
      'code',
      'details',
      'message',
      'requestId',
    ]);

    // Every documented failure points at the one definition instead of
    // restating it. /v1/ready is excluded: its 503 is a readiness report, not
    // an error — the only endpoint where a non-2xx is not an envelope.
    const errorSchemas = Object.entries(doc.paths)
      .filter(([path]) => path !== '/v1/ready')
      .flatMap(([, methods]) =>
        Object.values(methods).flatMap((operation) =>
          Object.entries(operation.responses)
            .filter(([status]) => status.startsWith('4') || status.startsWith('5'))
            .map(([, response]) => response.content?.['application/json']?.schema),
        ),
      );

    expect(errorSchemas.length).toBeGreaterThan(0);
    for (const schema of errorSchemas) {
      expect(schema?.$ref).toBe('#/components/schemas/ErrorEnvelope');
    }
  });

  it('matches the error envelope a real failure produces', async () => {
    // The envelope is hand-written prose rather than a converted zod schema,
    // so this is the check that the prose is true.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(400);

    const error = doc.components.schemas['ErrorEnvelope']?.properties?.['error'];
    const documented = Object.keys(error?.properties ?? {});
    const body = response.json<{ error: Record<string, unknown> }>();

    for (const key of Object.keys(body.error)) {
      expect(documented, `error.${key} is returned but not documented`).toContain(key);
    }
    for (const key of error?.required ?? []) {
      expect(body.error).toHaveProperty(key);
    }
  });
});

describe('the document does not drift from the engine', () => {
  it('advertises the version a live /v1/charts response reports', async () => {
    // The anti-drift assertion this whole file exists for. ENGINE_VERSION used
    // to be a separate const in four files; it is now one module, and this is
    // what proves the document and the routes are still reading it.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/charts',
      payload: {
        when: {
          local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' },
        },
        geo: { lat: 41.9028, lon: 12.4964 },
      },
    });

    expect(response.statusCode).toBe(200);
    const live = response.json<{ engine: { version: string } }>();
    expect(doc.info.version).toBe(live.engine.version);
  });
});
