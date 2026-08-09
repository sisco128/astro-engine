import type { FastifyInstance } from 'fastify';

import { lifePhaseCatalogue } from '../../../domain/life-phases.js';
import { assertReady } from '../../../ephemeris/init.js';
import { bodyState, jdFromUtc, seVersion, type JulianDayUT } from '../../../ephemeris/swe.js';
import type { BodyId } from '../../../ephemeris/bodies.js';
import type { ResultCache } from '../../../cache/result-cache.js';
import type { ComputePool } from '../../../pool/pool.js';
import type { PlanetaryReturn } from '../../../transits/returns.js';
import { ReturnsRequestSchema } from '../../schemas/returns.js';
import { resolveWhen } from '../../schemas/when.js';

const ENGINE_VERSION = '0.1.0';

/** Julian Day back to an ISO instant, for the response. */
function jdToIso(jd: number): string {
  return new Date((jd - 2440587.5) * 86_400_000).toISOString();
}

export function registerReturnRoutes(
  app: FastifyInstance,
  pool: ComputePool,
  cache: ResultCache,
): void {
  /**
   * The full vocabulary, chart-independent. A client drawing a life timeline
   * needs the phases that exist — including ones a given chart never reaches
   * inside its horizon — not only the labels on computed events.
   */
  app.get('/v1/meta/life-phases', () => ({ bodies: lifePhaseCatalogue() }));

  app.post('/v1/transits/returns', async (request, reply) => {
    assertReady();

    const parsed = ReturnsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body did not match the schema for POST /v1/transits/returns',
          requestId: request.id,
          details: { issues: parsed.error.issues },
        },
      });
    }

    const input = parsed.data;

    // Returns share the `when` union with the other two endpoints, so they
    // accept an unknown birth time too. The events barely move — a return is a
    // slow body meeting its own natal longitude, and the fastest of them,
    // Jupiter, drifts 0.08 degrees across the 24-hour uncertainty — but the
    // assumption is declared here as well rather than applied quietly. An
    // endpoint that accepts the variant and says nothing about it is the
    // silent noon in a different costume.
    const { utc, birthTime } = resolveWhen(input.when);

    const birthJd = jdFromUtc(utc);
    const toJd = (birthJd + input.horizonYears * 365.25) as JulianDayUT;
    const bodies = input.bodies as BodyId[];

    // Natal longitudes: a handful of ephemeris calls, cheap enough for the
    // event loop. The lifetime scan is not, and goes to the pool.
    const natalLon: (readonly [BodyId, number])[] = bodies.map((body) => [
      body,
      bodyState(birthJd, body).lon,
    ]);

    const cacheKey = cache.key({
      returns: true,
      birthJd,
      toJd,
      bodies: [...bodies].sort(),
    });

    let events = cache.get<PlanetaryReturn[]>(cacheKey);
    const cacheHit = events !== undefined;

    if (events === undefined) {
      events = await pool.run<PlanetaryReturn[]>({
        kind: 'returns',
        bodies,
        natalLon,
        birthJd,
        toJd,
      });
      cache.set(cacheKey, events);
    }

    return reply.header('X-Cache', cacheHit ? 'hit' : 'miss').send({
      engine: { version: ENGINE_VERSION, se: seVersion() },
      birth: { utc: jdToIso(birthJd), jdUt: birthJd },
      ...(birthTime !== undefined ? { birthTime } : {}),
      horizonYears: input.horizonYears,
      events: events.map((event) => ({
        body: event.body,
        aspect: event.aspect,
        side: event.side,
        occurrence: event.occurrence,
        // Age at the representative exact instant — the number a life
        // timeline actually plots.
        ageYears: (event.exactJd - birthJd) / 365.25,
        exact: jdToIso(event.exactJd),
        enter: jdToIso(event.enterJd),
        exit: jdToIso(event.exitJd),
        durationDays: event.durationDays,
        passes: event.passes.map((pass) => jdToIso(pass.exactJd)),
        phase: event.phase ?? null,
      })),
    });
  });
}
