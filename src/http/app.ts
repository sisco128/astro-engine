/**
 * Builds the Fastify instance. Pure — no listen(), no side effects.
 *
 * The prototype called app.listen() at module load AND exported the app
 * (server/index.js:81-86), so importing it for a test started a real server on
 * a real port. Splitting buildApp() from main.ts is what makes contract tests
 * possible at all.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance } from 'fastify';

import { env } from '../config/env.js';
import { EphemerisError } from '../ephemeris/errors.js';
import { initEphemeris, report } from '../ephemeris/init.js';
import { ResultCache } from '../cache/result-cache.js';
import { ComputePool } from '../pool/pool.js';
import { LocalTimeError } from '../time/local-to-utc.js';
import { ENGINE_VERSION } from '../version.js';
import { buildOpenApiDocument } from './openapi.js';
import { registerChartRoutes } from './routes/v1/charts.js';
import { registerKeyDateRoutes } from './routes/v1/key-dates.js';
import { registerReturnRoutes } from './routes/v1/returns.js';

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
};

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
 * A key as it is compared: a SHA-256 digest of it.
 *
 * Hashing both sides is what makes `timingSafeEqual` usable at all. It throws
 * on buffers of unequal length, so comparing raw keys would turn a
 * wrong-length guess into an exception rather than a rejection, and the shape
 * of that failure would leak the length of the real key. Digests are always 32
 * bytes, so every comparison is the same comparison.
 */
function digestOf(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** Whether a presented key matches any configured one. */
function matches(presented: string, digests: readonly Buffer[]): boolean {
  const candidate = digestOf(presented);
  // Every configured key is compared even after one matches: returning early
  // would let response time carry the position of the matching key in the list.
  let found = false;
  for (const digest of digests) {
    if (timingSafeEqual(candidate, digest)) found = true;
  }
  return found;
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

export async function buildApp(): Promise<FastifyInstance> {
  // Before anything binds, allocates or forks.
  assertAuthPosture({
    isProduction: env.isProduction,
    keyCount: env.apiKeys.length,
    authOptional: env.authOptional,
  });

  const apiKeyDigests = env.apiKeys.map(digestOf);
  const authRequired = apiKeyDigests.length > 0;

  const app = Fastify({
    logger: {
      level: env.logLevel,
      // The prototype monkey-patched res.send to log (middleware/logging.js:25),
      // which missed every path that did not route through send and discarded
      // the return value. Fastify's own hooks do this correctly.
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
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
      const presented = request.headers['x-api-key'];
      // Per caller where there is a caller to identify, per address otherwise.
      // Only a *valid* key earns its own bucket: keying on whatever arrived
      // would let one client mint a fresh allowance per random string and
      // escape the limit entirely, which is worse than no per-caller limit.
      if (typeof presented === 'string' && matches(presented, apiKeyDigests)) {
        // The digest, never the key itself. This value lives in an in-memory
        // store and appears in the log line written when a caller is limited.
        return `key:${digestOf(presented).toString('base64url').slice(0, 16)}`;
      }
      return `ip:${request.ip}`;
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
      if (routeUrl !== undefined && PUBLIC_ROUTES.has(routeUrl)) {
        done();
        return;
      }

      const presented = request.headers['x-api-key'];
      if (typeof presented === 'string' && matches(presented, apiKeyDigests)) {
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
    if (error instanceof EphemerisError || error instanceof LocalTimeError) {
      const status = STATUS_BY_CODE[error.code] ?? 500;
      request.log.warn({ code: error.code, details: error.details }, error.message);
      return reply.status(status).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          details: error.details,
        },
      });
    }

    // Load shedding. @fastify/under-pressure has already put 503 and
    // Retry-After on the reply; this gives the caller the same envelope every
    // other failure has, instead of the plugin's own error shape.
    if (error instanceof OverloadedError) {
      request.log.warn({ code: error.code }, error.message);
      return reply.status(STATUS_BY_CODE[error.code] ?? 503).send({
        error: { code: error.code, message: error.message, requestId: request.id },
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

  registerChartRoutes(app);
  registerKeyDateRoutes(app, pool, cache);
  registerReturnRoutes(app, pool, cache);

  initEphemeris();

  return app;
}
