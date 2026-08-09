import type { FastifyInstance } from 'fastify';

import type { GeoSearch } from '../../../geo/search.js';
import { GeoSearchQuerySchema, type GeoSearchResponse } from '../../schemas/geo.js';

export function registerGeoRoutes(app: FastifyInstance, search: GeoSearch): void {
  /**
   * A place name to coordinates and a zone, in one call.
   *
   * No `assertReady()`: this endpoint touches neither the ephemeris nor the
   * compute pool, and a client cannot assemble a chart request without it. An
   * engine that cannot calculate can still tell you where Rome is, and
   * refusing to would only stop the form being filled in before the ephemeris
   * finishes loading.
   *
   * An upstream failure raises a GeoError, which the app's error handler turns
   * into a 502 GEO_UPSTREAM_FAILED. It is contained here by construction —
   * there is no shared state between this route and the calculating ones, so
   * Nominatim being down costs exactly this endpoint and nothing else.
   */
  app.get('/v1/geo/search', async (request, reply) => {
    const parsed = GeoSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The query string did not match the schema for GET /v1/geo/search',
          requestId: request.id,
          details: { issues: parsed.error.issues },
        },
      });
    }

    const outcome = await search(parsed.data.q, parsed.data.limit);

    // Typed by the schema the OpenAPI document is generated from, so the two
    // cannot drift without the compiler saying so.
    const body: GeoSearchResponse = { results: [...outcome.results] };

    return (
      reply
        .header('X-Cache', outcome.cacheHit ? 'hit' : 'miss')
        // A day, and only in shared caches: a place name resolves to the same
        // coordinates tomorrow, and the point of caching here is to protect
        // one request per second of shared upstream budget.
        .header('Cache-Control', 'public, max-age=86400')
        .send(body)
    );
  });
}
