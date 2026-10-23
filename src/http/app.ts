/**
 * Builds the Fastify instance. Pure — no listen(), no side effects.
 *
 * The prototype called app.listen() at module load AND exported the app
 * (server/index.js:81-86), so importing it for a test started a real server on
 * a real port. Splitting buildApp() from main.ts is what makes contract tests
 * possible at all.
 */

import { randomBytes } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { env } from '../config/env.js';
import { EphemerisError } from '../ephemeris/errors.js';
import { initEphemeris, report } from '../ephemeris/init.js';
import { ResultCache } from '../cache/result-cache.js';
import { GeoError } from '../geo/errors.js';
import { createNominatimClient, type FetchLike } from '../geo/nominatim.js';
import { createGeoSearch } from '../geo/search.js';
import type { EngineCall } from '../mcp/tools.js';
import { ComputePool, PoolError } from '../pool/pool.js';
import { LocalTimeError } from '../time/local-to-utc.js';
import { ENGINE_VERSION } from '../version.js';
import { bearerOf, bucketOf, digestOf, matches } from './credentials.js';
import { buildOpenApiDocument } from './openapi.js';
import { MCP_ROUTE, MCP_TOKEN_ROUTE, redactMcpToken, registerMcpRoutes } from './routes/mcp.js';
import { registerChartRoutes } from './routes/v1/charts.js';
import { registerGeoRoutes } from './routes/v1/geo.js';
import { registerKeyDateRoutes } from './routes/v1/key-dates.js';
import { registerReturnRoutes } from './routes/v1/returns.js';
import { registerStoryWindowRoutes } from './routes/v1/story-windows.js';

/** HTTP status for each error code. Frozen at /v1. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  UNAUTHORIZED: 401,
  VALIDATION_FAILED: 400,
  UNSUPPORTED_DATE_RANGE: 400,
  BODY_NOT_SUPPORTED: 400,
  EPHEMERIS_UNAVAILABLE: 503,
  EPHEMERIS_FALLBACK: 500,
  EPHEMERIS_CALC_FAILED: 500,
  COMPUTE_OVERLOADED: 503,
  COMPUTE_UNAVAILABLE: 503,
  COMPUTE_WORKER_LOST: 504,
  // Distinct from COMPUTE_OVERLOADED, which means the compute queue is full.
  // This one is the process itself under strain — event loop or heap — and is
  // raised before a request reaches a route at all.
  SERVICE_OVERLOADED: 503,
  HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE: 422,
  // 409, not 400: the request is well-formed, but that wall-clock time is
  // genuinely unresolvable without a decision only the caller can make.
  NONEXISTENT_LOCAL_TIME: 409,
  AMBIGUOUS_LOCAL_TIME: 409,
  INVALID_TIME_ZONE: 400,
  WINDOW_TOO_LARGE: 400,
  // 404, and deliberately not an empty 200. A story signature names a
  // configuration a client stored in an earlier session; a chart that does not
  // carry it means the wrong chart or a stale signature, and both are different
  // from the story simply having been quiet — which is an answer
  // /v1/transits/story-windows gives legitimately and often.
  STORY_NOT_IN_CHART: 404,
  // 502, not 503: the engine is fine, a service it depends on is not, and the
  // distinction tells a caller whether retrying here is worth anything.
  GEO_UPSTREAM_FAILED: 502,
};

/**
 * The failures this engine raises on purpose, and what each one is worth to a
 * caller. Anything not named here is a bug in this service and leaves as 500.
 *
 * Kept apart from the error handler because the list is the interesting part
 * and it grows: PoolError was missing from it for the whole of this project's
 * history — nothing imported the class, so every compute failure fell through
 * to the generic branch and left as `500 INTERNAL`, logged as "unhandled
 * error", while the three COMPUTE_* entries in STATUS_BY_CODE sat unreachable.
 * Production on 13 August 2026 showed the cost: eleven key-dates requests died
 * with COMPUTE_WORKER_LOST and told their caller only that something
 * unspecified had gone wrong here. The distinction the table already drew is
 * the one the caller needs — 504, the worker was lost and a retry may work;
 * 503, the pool is full or gone and the retry should wait.
 */
function nameOf(error: unknown):
  | {
      status: number;
      code: string;
      message: string;
      details?: Readonly<Record<string, unknown>>;
    }
  | undefined {
  if (
    error instanceof EphemerisError ||
    error instanceof LocalTimeError ||
    error instanceof GeoError
  ) {
    return {
      status: STATUS_BY_CODE[error.code] ?? 500,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  // A compute failure is an answer, not an internal error.
  if (error instanceof PoolError) {
    return { status: STATUS_BY_CODE[error.code] ?? 503, code: error.code, message: error.message };
  }

  // Load shedding. @fastify/under-pressure has already put 503 and Retry-After
  // on the reply; this gives the caller the same envelope every other failure
  // has, instead of the plugin's own error shape.
  if (error instanceof OverloadedError) {
    return { status: STATUS_BY_CODE[error.code] ?? 503, code: error.code, message: error.message };
  }

  return undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: ComputePool;
    cache: ResultCache;
  }
}

/**
 * The routes that answer without an API key, and why each one has to.
 *
 * Matched against `request.routeOptions.url` — the route pattern, not the
 * request line — so a query string or an unmatched path cannot smuggle its way
 * into this set.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // Liveness. Load balancers and uptime probes carry no credentials, and a
  // liveness check that can fail on configuration is not a liveness check.
  '/v1/health',
  // Readiness. An orchestrator decides whether to route traffic here before
  // any client, or any client's key, is involved.
  '/v1/ready',
  // Not a preference. AGPL-3.0 section 13 obliges anyone running this service
  // over a network to offer the Corresponding Source to *the users who
  // interact with it* — all of them, including the ones without a key. An
  // offer that requires credentials to read is not an offer, so this endpoint
  // cannot sit behind the key however the deployment is configured.
  '/v1/meta/license',
]);

/**
 * Routes that check a credential of their own instead of an API key.
 *
 * Not public: /mcp/:token refuses anyone without a valid token in its path,
 * in a hook registered with the route itself (src/http/routes/mcp.ts). It is
 * skipped here because that token is deliberately not an API key — a leaked
 * connector URL must not open /v1 — and the key hook would refuse every
 * request the route exists to serve.
 */
const SELF_AUTHENTICATING_ROUTES: ReadonlySet<string> = new Set([MCP_TOKEN_ROUTE]);

/**
 * The API key a request presents, if any.
 *
 * `x-api-key` everywhere. `Authorization: Bearer` on /mcp as well, and only
 * there: the Messages API's MCP connector sends its credential no other way,
 * while /v1's contract — and every client generated from it — names the
 * header and nothing else.
 */
function presentedKey(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string') return header;
  if (request.routeOptions.url === MCP_ROUTE) return bearerOf(request.headers.authorization);
  return undefined;
}

/**
 * The startup refusal, as a function of the three inputs that decide it.
 *
 * Exported so all four combinations can be asserted as a table. Through
 * `buildApp` a test process can only ever observe one of them: `env.ts` parses
 * `process.env` once at module load, by design, so NODE_ENV is fixed for the
 * life of the process that imported it.
 */
export function assertAuthPosture(posture: {
  isProduction: boolean;
  keyCount: number;
  authOptional: boolean;
}): void {
  if (!posture.isProduction || posture.keyCount > 0 || posture.authOptional) return;

  throw new Error(
    'Refusing to start: NODE_ENV=production with an empty API_KEYS would serve every ' +
      'endpoint to anyone who can reach this host. Set API_KEYS, or set AUTH_OPTIONAL=true ' +
      'if something in front of this service authenticates for it.',
  );
}

/**
 * What @fastify/under-pressure throws when it sheds a request.
 *
 * Supplied as `customError` rather than matching on the plugin's own
 * FST_UNDER_PRESSURE: the codes in the envelope are this codebase's
 * vocabulary, and a plugin's internal string is not part of it. It also has to
 * be a type the error handler recognises — the plugin's error carries status
 * 503, which the handler's `< 500` branch does not catch, so left alone it
 * would have been reported to the caller as a generic 500.
 */
class OverloadedError extends Error {
  readonly code = 'SERVICE_OVERLOADED';

  constructor() {
    super('The service is shedding load. Retry after the interval in Retry-After.');
    this.name = 'OverloadedError';
  }
}

/**
 * Heap ceiling for the pressure check — derived from the cache bound rather
 * than picked out of the air.
 *
 * The result cache is the one component deliberately allowed to grow to a
 * configured size (CACHE_MAX_BYTES, 256 MB by default), and it holds
 * serialised responses as strings on the heap. A fixed ceiling below that
 * would make a merely-full cache look like an emergency for the rest of the
 * process's life. Four times the cache bound leaves room for the working set
 * on top of it — a key-dates result is assembled, held and serialised — while
 * still tripping far below Node's default old-space limit, so overload
 * surfaces as 503s a client can retry rather than as an OOM kill mid-request.
 * The floor covers a deployment that has turned the cache down to nothing.
 */
const HEAP_CEILING_BYTES = Math.max(env.cacheMaxBytes * 4, 512 * 1024 * 1024);

export interface BuildAppOptions {
  /**
   * The `fetch` the geocoding client uses. The single seam in this function,
   * and it earns its place: the alternative is a contract suite that makes
   * real requests to a public service whose usage policy allows one per
   * second, which would be both flaky and a violation of the terms the client
   * exists to honour. Production passes nothing and gets the global.
   */
  geoFetch?: FetchLike | undefined;

  /**
   * Where the logger writes. The second seam, and it earns its place the same
   * way: the only proof that an MCP URL token never reaches the logs is to
   * read the logs. Production passes nothing and gets stdout.
   */
  logStream?: { write(line: string): void } | undefined;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Before anything binds, allocates or forks.
  assertAuthPosture({
    isProduction: env.isProduction,
    keyCount: env.apiKeys.length,
    authOptional: env.authOptional,
  });

  const apiKeyDigests = env.apiKeys.map(digestOf);
  // From the configured keys alone, before the internal one joins them below:
  // an engine with no API_KEYS stays open in development, as it always was.
  const authRequired = apiKeyDigests.length > 0;

  /**
   * The key the MCP tools call /v1 with, in process.
   *
   * Each tool runs its route through `app.inject()`, and injected requests
   * pass through the key hook like any other. This key is how they get past
   * it: 32 random bytes per process, accepted like any configured key and able
   * to do exactly what one can. It is never logged (the header is redacted),
   * never sent over a network (inject has no socket) and never stored outside
   * this closure — a restart replaces it.
   */
  const internalKey = randomBytes(32).toString('base64url');
  const acceptedKeyDigests = [...apiKeyDigests, digestOf(internalKey)];
  const urlTokenDigests = env.mcpUrlTokens.map(digestOf);

  /**
   * Whose allowance a request spends: a valid key's, a valid URL token's, or
   * its address's.
   *
   * Only a *valid* credential earns its own bucket: keying on whatever arrived
   * would let one client mint a fresh allowance per random string and escape
   * the limit entirely, which is worse than no per-caller limit. A token gets
   * one for the reason a key does — every claude.ai connector arrives from
   * Anthropic's shared addresses, and bucketing it by address would let any
   * other traffic from there spend its allowance.
   */
  function callerBucket(request: FastifyRequest): string {
    const presented = presentedKey(request);
    if (presented !== undefined && matches(presented, acceptedKeyDigests)) {
      return `key:${bucketOf(presented)}`;
    }
    if (request.routeOptions.url === MCP_TOKEN_ROUTE) {
      const { token } = request.params as { token: string };
      if (matches(token, urlTokenDigests)) return `token:${bucketOf(token)}`;
    }
    return `ip:${request.ip}`;
  }

  const app = Fastify({
    logger: {
      level: env.logLevel,
      // The prototype monkey-patched res.send to log (middleware/logging.js:25),
      // which missed every path that did not route through send and discarded
      // the return value. Fastify's own hooks do this correctly.
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      serializers: {
        // Fastify's own request serializer, less the route-versioning header
        // this app never uses, and with one change: the URL goes through
        // redactMcpToken first. An MCP URL token travels in the path, and the
        // stock serializer would write it into the log on every call.
        req: (request) => ({
          method: request.method,
          url: redactMcpToken(request.url),
          host: request.host,
          remoteAddress: request.ip,
          ...(request.socket.remotePort !== undefined
            ? { remotePort: request.socket.remotePort }
            : {}),
        }),
      },
      ...(options.logStream !== undefined ? { stream: options.logStream } : {}),
    },
    bodyLimit: env.maxBodyBytes,
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  // Not optional: this engine exists to be called by frontends on other
  // origins. The prototype had no CORS at all and worked only because Vite
  // proxied /api in dev and the SPA was same-origin in production.
  await app.register(cors, {
    origin: env.corsOrigins.length > 0 ? [...env.corsOrigins] : false,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: env.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Per caller where there is a caller to identify, per address otherwise.
      // See callerBucket above for which callers count.
      const bucket = callerBucket(request);
      if (bucket.startsWith('key:')) {
        /**
         * One bucket per reader, inside the key.
         *
         * The key alone was the finest bucket available, and for a frontend
         * that is one bucket for its whole audience: every person using
         * Navigate arrives with the same key, so the allowance was shared by
         * all of them at once. A single pass through the app spends a few
         * dozen calls, which made the second reader in any given minute the
         * one who got turned away — with a screen that says something broke,
         * because nothing distinguishes "slow down" from "broken" out there.
         *
         * The subdivision is safe only because it hangs off a validated key:
         * the reader id is attacker-controlled, so on its own it would be the
         * same escape hatch the check above exists to prevent. Nested under a
         * key that had to be right, the worst a forged id can do is split an
         * allowance its owner already had.
         *
         * Opaque on purpose — a guest session id does the job, and nothing
         * here wants to know more about who is reading.
         */
        const reader = request.headers['x-caller-id'];
        if (typeof reader === 'string' && reader.trim() !== '') {
          return `${bucket}/reader:${reader.trim().slice(0, 64)}`;
        }
      }
      return bucket;
    },
  });

  /**
   * The second line of defence against this service stopping answering.
   *
   * The first is the compute pool: every Swiss Ephemeris call is synchronous
   * C, and keeping it in a forked worker is what stops one key-dates request
   * blocking the event loop for its whole duration. This catches what slips
   * past that — serialising a multi-megabyte response, GC pressure from a full
   * cache, a burst of small requests arriving faster than they are answered —
   * by refusing new work early instead of letting every request in flight time
   * out together.
   *
   * `exposeStatusRoute` is off because /v1/ready already exists and answers
   * the same question with more of the truth in it; a second status route with
   * a different shape would be a second answer to maintain.
   */
  await app.register(underPressure, {
    // One second. Deliberately far above normal: /v1/health answers in 1-2 ms
    // while a 15-second calculation runs in a worker, so at this threshold the
    // plugin fires only when something the pool does not cover is blocking the
    // loop — not when the service is merely busy.
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: HEAP_CEILING_BYTES,
    exposeStatusRoute: false,
    customError: OverloadedError,
  });

  /**
   * API-key authentication.
   *
   * Registered only when keys are configured: an empty list means no auth,
   * which keeps local development exactly as it was. Production cannot reach
   * this line with an empty list — assertAuthPosture above refuses to start.
   */
  if (authRequired) {
    app.addHook('onRequest', (request, reply, done) => {
      const routeUrl = request.routeOptions.url;
      if (
        routeUrl !== undefined &&
        (PUBLIC_ROUTES.has(routeUrl) || SELF_AUTHENTICATING_ROUTES.has(routeUrl))
      ) {
        done();
        return;
      }

      const presented = presentedKey(request);
      if (presented !== undefined && matches(presented, acceptedKeyDigests)) {
        done();
        return;
      }

      // An unmatched path lands here too, with no route to name. That is
      // deliberate: an anonymous caller learns nothing about which routes
      // exist, because every one of them answers 401 the same way.
      request.log.warn({ route: routeUrl ?? null }, 'rejected: no valid x-api-key');
      reply.status(STATUS_BY_CODE['UNAUTHORIZED'] ?? 401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'This endpoint requires a valid x-api-key header.',
          requestId: request.id,
        },
      });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const named = nameOf(error);
    if (named !== undefined) {
      request.log.warn({ code: named.code, details: named.details }, named.message);
      return reply.status(named.status).send({
        error: {
          code: named.code,
          message: named.message,
          requestId: request.id,
          details: named.details,
        },
      });
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode !== undefined && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? 'BAD_REQUEST',
          message: fastifyError.message ?? 'Bad request',
          requestId: request.id,
        },
      });
    }

    // Never leak a stack. The prototype returned error.stack whenever
    // NODE_ENV was development (routes/activations.js:438).
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal server error', requestId: request.id },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url}`,
        requestId: request.id,
      },
    }),
  );

  // --- /v1 --------------------------------------------------------------

  // Liveness only. Deliberately dependency-free: it answers while a heavy
  // calculation is in flight, which is how we demonstrate the event loop is
  // not blocked.
  app.get('/v1/health', () => ({ status: 'ok' }));

  // Readiness. This is the endpoint the prototype's /api/health pretended to
  // be: it reports whether calculations can actually succeed.
  app.get('/v1/ready', (_request, reply) => {
    const state = report();
    // The pool is part of readiness: an ephemeris that loads but no worker to
    // compute in means calculation requests will fail.
    const ok = state.state === 'ready' && pool.ready;
    return reply.status(ok ? 200 : 503).send({
      ...state,
      pool: { ready: pool.ready, queueDepth: pool.depth },
    });
  });

  /**
   * The machine-readable contract, generated from the same zod schemas that
   * validate requests. Frontends generate typed clients from this instead of
   * hand-mirroring types, which is what the prototype's client/src/types/api.ts
   * was and how it went stale. Built once per app instance: the document is a
   * pure function of code that cannot change while the process runs.
   */
  const openApiDocument = buildOpenApiDocument();
  app.get('/v1/openapi.json', () => openApiDocument);

  /**
   * AGPL-3.0 section 13 requires offering the Corresponding Source to users
   * who interact with the program over a network. astro-engine is a public
   * repository; this endpoint is how a network user finds it.
   */
  app.get('/v1/meta/license', () => ({
    license: 'AGPL-3.0-or-later',
    source: env.sourceUrl,
    notice:
      'This service is licensed under the GNU Affero General Public License v3.0 or later. ' +
      'The complete corresponding source is available at the URL above.',
    dependencies: [
      {
        name: 'Swiss Ephemeris',
        vendor: 'Astrodienst AG',
        license: 'AGPL-3.0-or-later',
        note: 'A professional licence from Astrodienst is the alternative to AGPL; this deployment uses the AGPL option.',
      },
    ],
  }));

  /**
   * Operational counters, and nothing else.
   *
   * Behind the API key when auth is on — these numbers are not sensitive, but
   * they are not for anonymous callers either, and the licence endpoint is the
   * only one this service owes to strangers.
   *
   * What is deliberately absent is process memory. The prototype attached a
   * `performance` block carrying heap and RSS figures to every chart response
   * it returned, to every caller; a stats endpoint is exactly where that
   * temptation comes back, so the line is drawn here in writing. Cache hit
   * rate, queue depth and uptime are things a client can act on. Heap size is
   * something an operator reads from the process, through its logs.
   */
  app.get('/v1/meta/stats', () => ({
    cache: cache.stats,
    pool: { ready: pool.ready, queueDepth: pool.depth },
    process: { uptimeSeconds: Math.round(process.uptime()) },
  }));

  // One pool per app instance, closed with it. Every Swiss Ephemeris call is
  // synchronous C, so without this a single key-dates request would block the
  // event loop for its whole duration and /v1/health would queue behind it.
  const pool = new ComputePool();
  app.decorate('pool', pool);

  const cache = new ResultCache(ENGINE_VERSION);
  app.decorate('cache', cache);
  app.addHook('onClose', async () => {
    await pool.close();
  });

  // One geocoding client per app instance, and therefore one outbound queue:
  // Nominatim's one-request-per-second budget belongs to the source address,
  // so a client built per request would enforce nothing.
  const geoSearch = createGeoSearch(createNominatimClient({ fetch: options.geoFetch }));

  registerChartRoutes(app);
  registerGeoRoutes(app, geoSearch);
  registerKeyDateRoutes(app, pool, cache);
  registerReturnRoutes(app, pool, cache);
  registerStoryWindowRoutes(app, pool, cache);

  /**
   * /v1, run in process on behalf of whoever called /mcp.
   *
   * The internal key gets each call past the key hook, and the caller id gives
   * every MCP caller an allowance of its own under that key — the same
   * subdivision a frontend's readers get, keyed here on the bucket the outer
   * request was already counted in.
   */
  function engineFor(request: FastifyRequest): EngineCall {
    const headers = { 'x-api-key': internalKey, 'x-caller-id': `mcp:${callerBucket(request)}` };
    return async ({ method, url, payload, query }) => {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload !== undefined ? { payload: payload as object } : {}),
        ...(query !== undefined ? { query: { ...query } } : {}),
      });
      return { status: response.statusCode, body: response.json() };
    };
  }

  registerMcpRoutes(app, { urlTokenDigests, engineFor });

  initEphemeris();

  return app;
}
