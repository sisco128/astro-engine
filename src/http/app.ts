/**
 * Builds the Fastify instance. Pure — no listen(), no side effects.
 *
 * The prototype called app.listen() at module load AND exported the app
 * (server/index.js:81-86), so importing it for a test started a real server on
 * a real port. Splitting buildApp() from main.ts is what makes contract tests
 * possible at all.
 */

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { env } from '../config/env.js';
import { EphemerisError } from '../ephemeris/errors.js';
import { initEphemeris, report } from '../ephemeris/init.js';
import { ResultCache } from '../cache/result-cache.js';
import { ComputePool } from '../pool/pool.js';
import { LocalTimeError } from '../time/local-to-utc.js';
import { registerChartRoutes } from './routes/v1/charts.js';
import { registerKeyDateRoutes } from './routes/v1/key-dates.js';
import { registerReturnRoutes } from './routes/v1/returns.js';

/** HTTP status for each error code. Frozen at /v1. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  UNSUPPORTED_DATE_RANGE: 400,
  BODY_NOT_SUPPORTED: 400,
  EPHEMERIS_UNAVAILABLE: 503,
  EPHEMERIS_FALLBACK: 500,
  EPHEMERIS_CALC_FAILED: 500,
  COMPUTE_OVERLOADED: 503,
  COMPUTE_UNAVAILABLE: 503,
  COMPUTE_WORKER_LOST: 504,
  HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE: 422,
  // 409, not 400: the request is well-formed, but that wall-clock time is
  // genuinely unresolvable without a decision only the caller can make.
  NONEXISTENT_LOCAL_TIME: 409,
  AMBIGUOUS_LOCAL_TIME: 409,
  INVALID_TIME_ZONE: 400,
  WINDOW_TOO_LARGE: 400,
};

/** Kept in one place: the version stamped on responses and on cache keys. */
const ENGINE_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    pool: ComputePool;
    cache: ResultCache;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
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
  });

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
