/**
 * The OpenAPI 3.1 document served at GET /v1/openapi.json.
 *
 * This is the machine-readable contract the frontends consume. The project
 * decided against a separately-published types package — everything stays in
 * this repository, all of it AGPL — so instead the engine describes itself and
 * clients generate what they need from the running service. It replaces the
 * prototype's `client/src/types/api.ts`: a hand-mirrored, unversioned copy of
 * the server's shapes that every consumer had to maintain and that nothing
 * compared against the server.
 *
 * Request bodies are converted from the live zod schemas with zod 4's native
 * `z.toJSONSchema` — the same objects that validate every request, so the
 * document cannot drift from what the engine accepts. That native conversion
 * is also why `fastify-type-provider-zod` is no longer a dependency: it was
 * installed for exactly this job and never wired up, and zod 4 does the job
 * without it.
 *
 * Response shapes are documented from zod only where a zod schema already
 * exists and the handler is typed by it (ChartResponseSchema,
 * GeoSearchResponseSchema). key-dates and returns assemble their responses
 * inline in their route handlers; writing parallel zod schemas purely for
 * documentation would create a second copy of the truth that nothing keeps
 * honest — the exact bug class this codebase has been bitten by. Those
 * responses are described in prose instead. Honesty over completeness: the
 * schemas become worth writing when a client generator actually needs them, at
 * which point the handlers should be refactored to emit *through* them rather
 * than merely be mirrored by them.
 */

import { z } from 'zod';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../geo/search.js';
import { ENGINE_VERSION } from '../version.js';
import { KeyDatesRequestSchema, StoryWindowsRequestSchema } from './schemas/funnel.js';
import { GeoSearchResponseSchema, MAX_QUERY_LENGTH } from './schemas/geo.js';
import { ReturnsRequestSchema } from './schemas/returns.js';
import { ChartRequestSchema, ChartResponseSchema } from './schemas/v1.js';

/**
 * Convert a zod schema to JSON Schema for embedding in the document.
 *
 * `io: 'input'` for request bodies, so that a field with a default stays
 * optional on the wire; `io: 'output'` for responses, where the same field is
 * always present. Getting this backwards would tell every generated client
 * that `houseSystem` is required.
 *
 * The top-level `$schema` marker is dropped: the OpenAPI document declares its
 * dialect once, and repeating it inside every embedded schema is noise that
 * some generators trip over.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const converted: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io }),
  };
  delete converted['$schema'];
  return converted;
}

/** A required JSON request body wrapping the given schema. */
function jsonBody(schema: Record<string, unknown>): Record<string, unknown> {
  return { required: true, content: { 'application/json': { schema } } };
}

/** A response carrying the given schema. */
function jsonResponse(
  description: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return { description, content: { 'application/json': { schema } } };
}

/**
 * A deliberately coarse response: a JSON object, described in prose. See the
 * module comment for why this is not a full schema.
 */
function coarseResponse(description: string): Record<string, unknown> {
  return jsonResponse(description, { type: 'object', description });
}

/** The error envelope, referenced rather than restated at each status. */
function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  };
}

/**
 * The 401 every authenticated operation shares.
 *
 * Whether it can actually happen is a property of the deployment, not of the
 * contract: a service running with no API_KEYS never returns it. Documented
 * unconditionally because this document is built once from code that cannot
 * see the configuration — and because a generated client that handles 401 on a
 * key-less deployment loses nothing, while one that does not handle it against
 * a keyed deployment breaks.
 */
const UNAUTHORIZED = errorResponse(
  'No `x-api-key` header, or one that matches no configured key (UNAUTHORIZED).',
);

/**
 * Marks an operation as reachable without a key, overriding the document-wide
 * `security` requirement.
 */
const PUBLIC: Record<string, unknown> = { security: [] };

/**
 * Build the document.
 *
 * A pure function of the code: nothing here reads configuration or request
 * state, so app.ts builds it once per instance. `operationId` is set on every
 * operation on purpose — it is what a client generator names the method, and
 * leaving it out would let a generator invent `postV1TransitsKeyDates` today
 * and something else after the next version bump.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'astro-engine',
      version: ENGINE_VERSION,
      description:
        'High-precision astrological calculation engine over Swiss Ephemeris. ' +
        'The engine returns numbers and identifiers only — formatted degrees, glyphs, ' +
        'sign names and interpretive text are presentation, and belong to the clients.',
      license: { name: 'AGPL-3.0-or-later', identifier: 'AGPL-3.0-or-later' },
    },
    // Relative on purpose: the document is served by the engine it describes,
    // so "the server you fetched this from" is always the right answer, and a
    // hardcoded host would be wrong in every deployment but one.
    servers: [{ url: '/', description: 'The server this document was fetched from.' }],
    // Document-wide, with the three endpoints that cannot require a key opting
    // out individually. A deployment with no API_KEYS configured enforces none
    // of this; the requirement is described here because the contract has to
    // be the same document whether or not a given deployment turned auth on.
    security: [{ apiKey: [] }],
    paths: {
      '/v1/health': {
        get: {
          ...PUBLIC,
          operationId: 'getHealth',
          summary: 'Liveness',
          description:
            'Dependency-free. Answers while a heavy calculation is in flight, which is how the ' +
            'engine demonstrates its event loop is not blocked. Not a readiness check: it says ' +
            'nothing about whether a calculation would succeed.',
          responses: { '200': coarseResponse('The process is alive: `{ "status": "ok" }`.') },
        },
      },
      '/v1/ready': {
        get: {
          ...PUBLIC,
          operationId: 'getReady',
          summary: 'Readiness',
          description:
            'Whether calculations can actually succeed: ephemeris state, library version, probe ' +
            'result, measured coverage, and compute-pool state. 503 until all of it is up.',
          responses: {
            '200': coarseResponse('Ephemeris and compute pool are ready.'),
            '503': coarseResponse(
              'Not ready. Same shape as the 200, with the failing state named.',
            ),
          },
        },
      },
      '/v1/meta/license': {
        get: {
          // Public whatever the deployment configures, and the one endpoint
          // where that is a legal property rather than a convenience: §13 owes
          // the offer to every network user, including the ones with no key.
          ...PUBLIC,
          operationId: 'getLicense',
          summary: 'Licence and source location',
          description:
            'AGPL-3.0 §13 obliges anyone running this service over a network to offer its users ' +
            'the Corresponding Source; this endpoint is how they find it. Never requires a key.',
          responses: {
            '200': coarseResponse('Licence identifier, public source URL, and dependency notices.'),
          },
        },
      },
      '/v1/meta/stats': {
        get: {
          operationId: 'getStats',
          summary: 'Operational counters',
          description:
            'Cache hits, misses and entry count; compute-pool readiness and queue depth; process ' +
            'uptime in seconds. Numbers only — no request content, no configuration, and no ' +
            'process memory figures.',
          responses: {
            '200': coarseResponse(
              'Counters: `{ cache: { hits, misses, size }, pool: { ready, queueDepth }, ' +
                'process: { uptimeSeconds } }`.',
            ),
            '401': UNAUTHORIZED,
          },
        },
      },
      '/v1/meta/funnel': {
        get: {
          operationId: 'getFunnelVocabulary',
          summary: 'Funnel vocabulary',
          description:
            'Tiers, presets, aspect identifiers, nesting rules and limits — everything a client ' +
            'needs to build the `funnel` field of POST /v1/transits/key-dates and POST ' +
            '/v1/transits/story-windows without guessing, including the latter default span and ' +
            'window ceiling.',
          responses: {
            '200': coarseResponse('The funnel configuration vocabulary.'),
            '401': UNAUTHORIZED,
          },
        },
      },
      '/v1/meta/life-phases': {
        get: {
          operationId: 'getLifePhases',
          summary: 'Life-phase vocabulary',
          description:
            'The whole chart-independent catalogue, including phases a given chart never reaches ' +
            'inside its horizon. A client drawing a timeline needs the phases that exist, not ' +
            'only the ones a particular request happened to produce.',
          responses: {
            '200': coarseResponse('The life-phase catalogue, keyed by body.'),
            '401': UNAUTHORIZED,
          },
        },
      },
      '/v1/geo/search': {
        get: {
          operationId: 'searchPlaces',
          summary: 'Place name to coordinates and IANA zone',
          description:
            'Resolves a place name against OpenStreetMap Nominatim and attaches the IANA time ' +
            'zone at each result, so a client gets the three things POST /v1/charts needs — ' +
            'latitude, longitude and zone — from one call instead of assembling them itself. ' +
            'The zone lookup is offline and deterministic. Results are cached on the normalised ' +
            'query; `X-Cache` reports hit or miss.',
          // Parameters are written out rather than converted from the zod
          // schema. Query strings arrive as strings, so the schema coerces,
          // and a converted `z.coerce.number()` documents its *input* — which
          // is `unknown`, and would tell a generator that `limit` accepts
          // anything. The bounds are imported constants, so the numbers below
          // cannot drift from the ones that validate.
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              description:
                'The place to look for, e.g. "Roma" or "New York, NY". Trimmed, lower-cased and ' +
                'whitespace-collapsed before it is sent upstream or cached.',
              schema: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description:
                'How many candidates to return. The engine always fetches the maximum from the ' +
                'upstream and slices, so asking for fewer costs the same and asking again for ' +
                'more is free.',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_LIMIT,
                default: DEFAULT_LIMIT,
              },
            },
          ],
          responses: {
            '200': jsonResponse(
              'Candidate places, each with coordinates and an IANA zone.',
              jsonSchema(GeoSearchResponseSchema, 'output'),
            ),
            '400': errorResponse(
              'Missing or empty `q`, a `q` longer than the limit, an unknown query parameter, or ' +
                'a `limit` outside its range (VALIDATION_FAILED).',
            ),
            '401': UNAUTHORIZED,
            '502': errorResponse(
              'The geocoding upstream timed out, refused the request, or answered with something ' +
                'other than the expected shape (GEO_UPSTREAM_FAILED). Nothing else in the engine ' +
                'is affected: no other endpoint calls it.',
            ),
          },
        },
      },
      '/v1/charts': {
        post: {
          operationId: 'createChart',
          summary: 'Natal chart',
          description:
            'Positions, angles and house cusps for a birth moment. The response is a ' +
            'deterministic function of the request and carries a strong ETag equal to its own ' +
            '`chartRef`.',
          requestBody: jsonBody(jsonSchema(ChartRequestSchema, 'input')),
          responses: {
            '200': jsonResponse('The calculated chart.', jsonSchema(ChartResponseSchema, 'output')),
            '400': errorResponse('Malformed request (VALIDATION_FAILED, INVALID_TIME_ZONE, …).'),
            '401': UNAUTHORIZED,
            '409': errorResponse(
              'The wall-clock time does not resolve: it fell in a DST gap ' +
                '(NONEXISTENT_LOCAL_TIME) or happened twice (AMBIGUOUS_LOCAL_TIME, with both ' +
                'candidate instants in `details`).',
            ),
            '422': errorResponse(
              'The house system is undefined at that latitude ' +
                '(HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE, with systems that do work in `details`).',
            ),
          },
        },
      },
      '/v1/transits/key-dates': {
        post: {
          operationId: 'createKeyDates',
          summary: 'Key dates, via the transit funnel',
          description:
            'Scans a date window for nested slow/social/fast activations of the natal stories and ' +
            'returns clustered windows with their full activation paths. The resolved funnel and ' +
            'the observed density are echoed back, so a client can retune its filters against a ' +
            'measurement instead of a guess.',
          requestBody: jsonBody(jsonSchema(KeyDatesRequestSchema, 'input')),
          responses: {
            // No zod response schema exists for this shape; see the module
            // comment for why it is described rather than duplicated.
            '200': coarseResponse(
              'Chart reference, engine versions, the requested and resolved funnel, the span, the ' +
                'observed density, the natal stories, and the key-date windows with their paths. ' +
                'src/http/routes/v1/key-dates.ts is the source of truth for the exact shape.',
            ),
            '400': errorResponse(
              'Malformed request, an unknown funnel preset, `to` not after `from`, or a span ' +
                'beyond the limit (WINDOW_TOO_LARGE, with the limit in `details`).',
            ),
            '401': UNAUTHORIZED,
            '409': errorResponse('The wall-clock birth time does not resolve (DST gap or fold).'),
          },
        },
      },
      '/v1/transits/story-windows': {
        post: {
          operationId: 'createStoryWindows',
          summary: 'The past windows of one story, strongest first',
          description:
            'The same funnel as POST /v1/transits/key-dates, scoped to the single natal story ' +
            'named by `signature` and ordered by descending intensity rather than by date. Built ' +
            'for the end of onboarding: a client that stored a story in an earlier session holds ' +
            'its signature — which is stable across sessions and across people, unlike the ' +
            'per-chart `id` — and asks when that story was last active. `from` and `to` are both ' +
            'optional and default to the ten years ending today, the shortest span over which ' +
            'the quietest story on the reference chart still yields three windows. `limit` ' +
            'defaults to 3. The windows are identical to the ones key-dates returns for the same ' +
            'story over the same span; scoping the funnel changes the cost, never the answer.',
          requestBody: jsonBody(jsonSchema(StoryWindowsRequestSchema, 'input')),
          responses: {
            // Same reasoning as key-dates: no zod response schema exists, and
            // writing one purely for documentation would be a second copy of
            // the truth that nothing keeps honest.
            '200': coarseResponse(
              'Chart reference, engine versions, the requested and resolved funnel, the resolved ' +
                'span, the density of this one story over it, the limit, the story itself with ' +
                'its signature, and the top windows with their full slow/social/fast paths. ' +
                'src/http/routes/v1/story-windows.ts is the source of truth for the exact shape.',
            ),
            '400': errorResponse(
              'Malformed request, an unknown funnel preset, `to` not after `from`, or a span ' +
                'beyond the limit (WINDOW_TOO_LARGE, with the limit in `details`).',
            ),
            '401': UNAUTHORIZED,
            '404': errorResponse(
              'No story in this chart carries that signature (STORY_NOT_IN_CHART). Not an empty ' +
                '200: a story that was merely quiet returns 200 with an empty `windows`, and a ' +
                'client must be able to tell the two apart. `details.signatures` lists every ' +
                'signature the chart does carry, so a stale one can be recovered from.',
            ),
            '409': errorResponse('The wall-clock birth time does not resolve (DST gap or fold).'),
          },
        },
      },
      '/v1/transits/returns': {
        post: {
          operationId: 'createReturns',
          summary: 'Planetary returns, with life phases',
          description:
            'Birth-anchored scan for return and half-return contacts of each requested body with ' +
            'its own natal position, labelled with the life-phase vocabulary where one exists. ' +
            'No `from` and no `geo`, by design: which occurrence a return is can only be counted ' +
            'from birth, and a return does not depend on where on Earth the birth happened.',
          requestBody: jsonBody(jsonSchema(ReturnsRequestSchema, 'input')),
          responses: {
            // Same reasoning as key-dates.
            '200': coarseResponse(
              'Engine versions, the birth instant, the horizon, and the return events with ages, ' +
                'contact windows, retrograde passes and phase labels. ' +
                'src/http/routes/v1/returns.ts is the source of truth for the exact shape.',
            ),
            '400': errorResponse(
              'Malformed request (VALIDATION_FAILED) — including a body excluded from transits ' +
                'for measured reasons, or a horizon beyond a human lifetime.',
            ),
            '401': UNAUTHORIZED,
            '409': errorResponse('The wall-clock birth time does not resolve (DST gap or fold).'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description:
            'One of the keys the deployment was configured with. A deployment with none ' +
            'configured accepts every request; /v1/health, /v1/ready and /v1/meta/license are ' +
            'reachable without a key in every deployment.',
        },
      },
      schemas: {
        // Documented once and referenced everywhere. The envelope is frozen at
        // /v1: every non-2xx response from every endpoint has this shape, and
        // a client can write one error path rather than nine.
        ErrorEnvelope: {
          type: 'object',
          description: 'The shape of every non-2xx response.',
          required: ['error'],
          additionalProperties: false,
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: {
                  type: 'string',
                  description:
                    'Stable machine-readable identifier — UNAUTHORIZED, VALIDATION_FAILED, ' +
                    'WINDOW_TOO_LARGE, NONEXISTENT_LOCAL_TIME, AMBIGUOUS_LOCAL_TIME, ' +
                    'HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE, EPHEMERIS_UNAVAILABLE, ' +
                    'SERVICE_OVERLOADED, NOT_FOUND, INTERNAL, and the rest of STATUS_BY_CODE in ' +
                    'src/http/app.ts. Branch on this, not on the message. SERVICE_OVERLOADED ' +
                    'carries a Retry-After header and can arrive from any endpoint: it is the ' +
                    'process shedding load before the request reaches a route.',
                },
                message: {
                  type: 'string',
                  description: 'Human-readable. Never a stack trace, in any environment.',
                },
                requestId: {
                  type: 'string',
                  description:
                    'Echoes the x-request-id header when one was sent. Quote it when reporting.',
                },
                details: {
                  type: 'object',
                  description:
                    'Code-specific and optional: validation issues, both candidate instants for ' +
                    'an ambiguous local time, working house systems for a latitude, the window ' +
                    'limit that was exceeded.',
                },
              },
            },
          },
        },
      },
    },
  };
}
