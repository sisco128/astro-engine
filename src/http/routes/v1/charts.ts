import type { FastifyInstance } from 'fastify';

import { calculateChart } from '../../../domain/chart.js';
import { assertReady } from '../../../ephemeris/init.js';
import { seVersion, type HouseSystem } from '../../../ephemeris/swe.js';
import { ENGINE_VERSION } from '../../../version.js';
import { ChartRequestSchema } from '../../schemas/v1.js';
import { resolveWhen } from '../../schemas/when.js';

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
    // rather than as a silently shifted chart. `birthTime` is present only
    // when the hour was unknown and the engine supplied one.
    const { utc, birthTime } = resolveWhen(input.when);

    const chart = calculateChart({
      utc,
      geo: input.geo,
      houseSystem: input.houseSystem as HouseSystem,
      bodies: input.bodies,
      ...(birthTime !== undefined ? { birthTimeAssumed: true } : {}),
    });

    // Every response is a deterministic function of its input, so the content
    // hash is a valid strong ETag. A frontend re-render costs a 304.
    return reply
      .header('ETag', `"${chart.chartRef}"`)
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .send({
        ...chart,
        engine: { version: ENGINE_VERSION, se: seVersion() },
        // Spread conditionally rather than sent as `assumed: false`: a chart
        // built on a real birth time is byte-identical to what it was before
        // unknown times existed, and a client can treat the key's presence as
        // the whole question.
        ...(birthTime !== undefined ? { birthTime } : {}),
      });
  });
}
