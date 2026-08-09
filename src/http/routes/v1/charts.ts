import type { FastifyInstance } from 'fastify';

import { calculateChart } from '../../../domain/chart.js';
import { assertReady } from '../../../ephemeris/init.js';
import { seVersion, type HouseSystem } from '../../../ephemeris/swe.js';
import { resolveLocalTime } from '../../../time/local-to-utc.js';
import { ENGINE_VERSION } from '../../../version.js';
import { ChartRequestSchema } from '../../schemas/v1.js';

export function registerChartRoutes(app: FastifyInstance): void {
  app.post('/v1/charts', (request, reply) => {
    assertReady();

    const parsed = ChartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body did not match the schema for POST /v1/charts',
          requestId: request.id,
          details: { issues: parsed.error.issues },
        },
      });
    }

    const input = parsed.data;

    // Local wall-clock time is resolved here, not inside the calculation
    // layer, so a DST gap or fold surfaces as a 409 the client can act on
    // rather than as a silently shifted chart.
    const utc =
      'utc' in input.when
        ? input.when.utc
        : (() => {
            const resolved = resolveLocalTime(input.when.local);
            return {
              year: resolved.year,
              month: resolved.month,
              day: resolved.day,
              hour: resolved.hour,
              minute: resolved.minute,
              second: resolved.second,
            };
          })();

    const chart = calculateChart({
      utc,
      geo: input.geo,
      houseSystem: input.houseSystem as HouseSystem,
      bodies: input.bodies,
    });

    // Every response is a deterministic function of its input, so the content
    // hash is a valid strong ETag. A frontend re-render costs a 304.
    return reply
      .header('ETag', `"${chart.chartRef}"`)
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .send({
        ...chart,
        engine: { version: ENGINE_VERSION, se: seVersion() },
      });
  });
}
