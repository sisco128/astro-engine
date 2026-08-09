/**
 * The past windows of ONE story, strongest first.
 *
 * The astronomy is already in /v1/transits/key-dates, which accepts any span
 * including one entirely in the past. What was missing is the question a client
 * actually asks at the end of onboarding: for THIS story, when was it active?
 * key-dates answers "everything that happened", which for a single story means
 * computing six other stories and throwing them away.
 *
 * So this endpoint is not a second funnel. It resolves the same chart, picks
 * the one story the caller named, and runs the same buildFunnel with that story
 * as its entire scope — see the note on `stories` in src/transits/funnel.ts for
 * what that saves and why the numbers cannot disagree with key-dates. The
 * golden suite asserts the agreement rather than trusting it.
 */

import type { FastifyInstance } from 'fastify';

import { calculateChart } from '../../../domain/chart.js';
import { identifyStories, isTimeSensitive } from '../../../domain/themes.js';
import type { FunnelConfig } from '../../../domain/timescales.js';
import { DEFAULT_BODIES } from '../../../ephemeris/bodies.js';
import { assertReady } from '../../../ephemeris/init.js';
import { seVersion, type HouseSystem } from '../../../ephemeris/swe.js';
import { ENGINE_VERSION } from '../../../version.js';
import type { ResultCache } from '../../../cache/result-cache.js';
import type { ComputePool } from '../../../pool/pool.js';
import type { FunnelResult, KeyWindow } from '../../../transits/funnel.js';
import {
  MAX_WINDOW_DAYS,
  resolveFunnel,
  resolveStorySpan,
  StoryWindowsRequestSchema,
} from '../../schemas/funnel.js';
import { resolveWhen } from '../../schemas/when.js';
import { isoToJd, jdToIso } from './key-dates.js';

/**
 * Strongest first, which is the ordering the whole endpoint exists to provide.
 *
 * `intensity` is the primary key because it is what the model says a window is
 * worth. Inside one story it is currently CONSTANT: a FunnelPath's intensity is
 * the story's own strength, every resonance peaking at 1 at its own exact
 * contact, so all seven stories on the reference chart tie on it across all of
 * their windows. It is still sorted on first, so that the day a path earns an
 * intensity of its own this ordering follows it without an edit here, and two
 * measurable quantities decide the ties it cannot.
 *
 * `paths.length` next. A window holding four nested slow/social/fast routes was
 * reached four ways inside its five days; one holding a single route was not.
 * It is the only other number in a KeyWindow that varies with how hard the
 * story was hit — measured 1 to 9 paths per window on the reference chart.
 *
 * Recency last, and not arbitrarily. These dates are put to someone as a
 * question about their own past, and an answer to "did anything happen here" is
 * likelier to exist for last year than for nine years ago.
 */
function strongestFirst(a: KeyWindow, b: KeyWindow): number {
  if (b.peak.intensity !== a.peak.intensity) return b.peak.intensity - a.peak.intensity;
  if (b.paths.length !== a.paths.length) return b.paths.length - a.paths.length;
  return b.fromJd - a.fromJd;
}

export function registerStoryWindowRoutes(
  app: FastifyInstance,
  pool: ComputePool,
  cache: ResultCache,
): void {
  app.post('/v1/transits/story-windows', async (request, reply) => {
    assertReady();

    const parsed = StoryWindowsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body did not match the schema for POST /v1/transits/story-windows',
          requestId: request.id,
          details: { issues: parsed.error.issues },
        },
      });
    }

    const input = parsed.data;

    const { utc, birthTime } = resolveWhen(input.when);

    // Resolved before anything is computed, and echoed in the response: a
    // caller who sent neither end of the span has to be told which one it got.
    const span = resolveStorySpan(input);
    const fromJd = isoToJd(span.from);
    const toJd = isoToJd(span.to);

    if (toJd <= fromJd) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: '`to` must be later than `from`',
          requestId: request.id,
          details: { from: span.from, to: span.to },
        },
      });
    }

    // The same bound key-dates enforces, for the same reason. Scoping to one
    // story makes a span cheaper, not unbounded: it is still a scan.
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
      ...(birthTime !== undefined ? { birthTimeAssumed: true } : {}),
    });

    const natalPoints = [
      ...chart.bodies.map((body) => ({ id: body.id, lon: body.lon })),
      { id: 'ascendant', lon: chart.angles.ascendant },
      { id: 'midheaven', lon: chart.angles.midheaven },
    ];

    const { stories } = identifyStories(natalPoints, { scoring: input.scoring });
    const story = stories.find((candidate) => candidate.signature === input.signature);

    if (story === undefined) {
      /**
       * 404, not an empty 200.
       *
       * The signature was stored by a client in an earlier session, so a miss
       * means one of two things a caller must be able to tell apart: the chart
       * in this request is not the chart that produced the signature, or the
       * story configuration is genuinely absent from it. An empty window list
       * would read as "this story was quiet", which is a real and different
       * answer this endpoint gives all the time.
       *
       * Every signature the chart does carry goes in `details`, because the
       * client holding a stale signature has no other way to recover and they
       * are identifiers rather than content.
       */
      return reply.status(404).send({
        error: {
          code: 'STORY_NOT_IN_CHART',
          message: `No story with signature ${input.signature} in this chart.`,
          requestId: request.id,
          details: {
            signature: input.signature,
            chartRef: chart.chartRef,
            signatures: stories.map((candidate) => candidate.signature),
          },
        },
      });
    }

    // Keyed on the story rather than the chart's whole story set, so this never
    // collides with a key-dates entry over the same chart and span — the two
    // compute different amounts of work and cache different results. `limit` is
    // deliberately absent: the full window list for the story is what is
    // stored, so raising or lowering the limit is served from the same entry.
    const cacheKey = cache.key({
      storyWindows: true,
      chartRef: chart.chartRef,
      signature: story.signature,
      fromJd,
      toJd,
      config,
      scoring: input.scoring,
    });

    let funnel = cache.get<FunnelResult>(cacheKey);
    const cacheHit = funnel !== undefined;

    if (funnel === undefined) {
      // The existing funnel task, with one story in it. A third task kind would
      // be a second route into the same buildFunnel call and a second thing to
      // keep equal to the first; the scope belongs in the payload, which is
      // where buildFunnel already reads it from.
      funnel = await pool.run<FunnelResult>({
        kind: 'funnel',
        stories: [story],
        natalPoints,
        fromJd,
        toJd,
        config,
      });
      cache.set(cacheKey, funnel);
    }

    // Sorted whole, then sliced. Slicing first would take the three earliest of
    // whatever order the funnel emitted and call them the strongest.
    const ranked = [...funnel.windows].sort(strongestFirst);

    return reply.header('X-Cache', cacheHit ? 'hit' : 'miss').send({
      chartRef: chart.chartRef,
      engine: { version: ENGINE_VERSION, se: seVersion() },
      ...(birthTime !== undefined ? { birthTime } : {}),
      funnel: { requested: input.funnel, resolved: config },
      span: { from: span.from, to: span.to, days: Math.round(windowDays) },
      /**
       * This story's density over the span, on the same terms key-dates
       * reports for the whole chart. `windows` counts everything found, so a
       * client can see that three of eleven came back rather than inferring
       * from the array length that eleven was all there was.
       */
      density: { windowsPerQuarter: funnel.windowsPerQuarter, windows: funnel.windows.length },
      limit: input.limit,
      story: {
        id: story.id,
        // Echoed rather than repeated back from the request: the caller must be
        // able to see that the signature it sent is the story it got.
        signature: story.signature,
        aspect: story.aspect,
        orb: story.orb,
        members: story.members,
        score: story.score,
        strength: story.strength,
        scoringVersion: story.scoringVersion,
        // Only when the hour was assumed — the same rule key-dates follows, and
        // the same reason: with a real birth time nothing is uncertain, and a
        // `false` here would read as a property of the story.
        ...(birthTime !== undefined ? { timeSensitive: isTimeSensitive(story.members) } : {}),
      },
      windows: ranked.slice(0, input.limit).map((window) => ({
        from: jdToIso(window.fromJd),
        to: jdToIso(window.toJd),
        intensity: window.peak.intensity,
        pathCount: window.paths.length,
        // The whole chain, exactly as key-dates returns it. A client that
        // arrived here from a key-dates response must not have to parse two
        // shapes for the same thing. `storyId` is the one field dropped: the
        // story is named once, above, rather than on every window.
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
