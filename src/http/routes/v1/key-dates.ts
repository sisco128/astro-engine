import type { FastifyInstance } from 'fastify';

import { calculateChart } from '../../../domain/chart.js';
import { identifyStories } from '../../../domain/themes.js';
import type { FunnelConfig } from '../../../domain/timescales.js';
import { DEFAULT_BODIES } from '../../../ephemeris/bodies.js';
import { EphemerisError } from '../../../ephemeris/errors.js';
import { assertReady } from '../../../ephemeris/init.js';
import {
  jdFromUtc,
  seVersion,
  type HouseSystem,
  type JulianDayUT,
} from '../../../ephemeris/swe.js';
import { resolveLocalTime } from '../../../time/local-to-utc.js';
import type { ComputePool } from '../../../pool/pool.js';
import type { FunnelResult } from '../../../transits/funnel.js';
import {
  funnelMetadata,
  KeyDatesRequestSchema,
  MAX_WINDOW_DAYS,
  resolveFunnel,
} from '../../schemas/funnel.js';

const ENGINE_VERSION = '0.1.0';

/** ISO date to Julian Day, midnight UT. */
function isoToJd(iso: string): JulianDayUT {
  const [year, month, day] = iso.split('-').map(Number);
  return jdFromUtc({ year: year ?? 0, month: month ?? 1, day: day ?? 1, hour: 0, minute: 0 });
}

/** Julian Day back to an ISO instant, for the response. */
function jdToIso(jd: number): string {
  return new Date((jd - 2440587.5) * 86_400_000).toISOString();
}

export function registerKeyDateRoutes(app: FastifyInstance, pool: ComputePool): void {
  app.get('/v1/meta/funnel', () => funnelMetadata());

  app.post('/v1/transits/key-dates', async (request, reply) => {
    assertReady();

    const parsed = KeyDatesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body did not match the schema for POST /v1/transits/key-dates',
          requestId: request.id,
          details: { issues: parsed.error.issues },
        },
      });
    }

    const input = parsed.data;

    const utc =
      'utc' in input.when
        ? input.when.utc
        : (() => {
            const r = resolveLocalTime(input.when.local);
            return {
              year: r.year,
              month: r.month,
              day: r.day,
              hour: r.hour,
              minute: r.minute,
              second: r.second,
            };
          })();

    const fromJd = isoToJd(input.from);
    const toJd = isoToJd(input.to);

    if (toJd <= fromJd) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: '`to` must be later than `from`',
          requestId: request.id,
        },
      });
    }

    // A hard bound, not a cost estimate. Every calculation runs on the event
    // loop until the compute pool exists, so a request that would block the
    // process for a minute is refused rather than served slowly. The
    // prototype accepted futureYears: 500 — about 180,000 days of synchronous
    // scanning.
    const windowDays = toJd - fromJd;
    if (windowDays > MAX_WINDOW_DAYS) {
      return reply.status(400).send({
        error: {
          code: 'WINDOW_TOO_LARGE',
          message: `The requested span is ${Math.round(windowDays).toString()} days; the maximum is ${String(MAX_WINDOW_DAYS)}.`,
          requestId: request.id,
          details: { requestedDays: Math.round(windowDays), maxDays: MAX_WINDOW_DAYS },
        },
      });
    }

    const requestedFunnel = input.funnel as string | FunnelConfig;
    let config: FunnelConfig;
    try {
      config = resolveFunnel(requestedFunnel);
    } catch {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message:
            typeof requestedFunnel === 'string'
              ? `Unknown funnel preset: ${requestedFunnel}`
              : 'The funnel configuration was not valid',
          requestId: request.id,
        },
      });
    }

    const chart = calculateChart({
      utc,
      geo: input.geo,
      houseSystem: input.houseSystem as HouseSystem,
      bodies: DEFAULT_BODIES,
    });

    const natalPoints = [
      ...chart.bodies.map((body) => ({ id: body.id, lon: body.lon })),
      { id: 'ascendant', lon: chart.angles.ascendant },
      { id: 'midheaven', lon: chart.angles.midheaven },
    ];

    const { stories } = identifyStories(natalPoints, { scoring: input.scoring });

    // Off the event loop and into a worker process. The whole point is that
    // /v1/health keeps answering while this runs.
    const funnel = await pool.run<FunnelResult>({
      kind: 'funnel',
      stories,
      natalPoints,
      fromJd,
      toJd,
      config,
    });

    return reply.send({
      chartRef: chart.chartRef,
      engine: { version: ENGINE_VERSION, se: seVersion() },
      // Echoed so a client never has to guess what a preset resolved to.
      funnel: { requested: input.funnel, resolved: config },
      span: { from: input.from, to: input.to, days: Math.round(windowDays) },
      /**
       * The observed density of THIS request. Returned so a client can retune
       * its own filters against a target instead of guessing — bodies and the
       * nesting rule trade off against each other, and only measurement says
       * where a given combination lands.
       */
      density: { windowsPerQuarter: funnel.windowsPerQuarter, windows: funnel.windows.length },
      stories: stories.map((story) => ({
        id: story.id,
        aspect: story.aspect,
        orb: story.orb,
        members: story.members,
        score: story.score,
        strength: story.strength,
        scoringVersion: story.scoringVersion,
      })),
      keyDates: funnel.windows.map((window) => ({
        storyId: window.storyId,
        from: jdToIso(window.fromJd),
        to: jdToIso(window.toJd),
        intensity: window.peak.intensity,
        pathCount: window.paths.length,
        // The whole chain, root to leaf. A Jupiter resonance means one thing
        // inside a Neptune window and another inside a Pluto window; a client
        // given only the date could not tell them apart.
        path: (['slow', 'social', 'fast'] as const).map((tier) => {
          const resonance = window.peak[tier];
          return {
            tier,
            body: resonance.body,
            aspect: resonance.aspect,
            member: resonance.member,
            exact: jdToIso(resonance.exactJd),
            enter: jdToIso(resonance.enterJd),
            exit: jdToIso(resonance.exitJd),
            durationDays: resonance.durationDays,
            precisionDays: resonance.precisionDays,
          };
        }),
      })),
    });
  });
}

export { EphemerisError };
