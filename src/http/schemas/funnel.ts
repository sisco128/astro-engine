/**
 * The funnel's filters, as request parameters.
 *
 * The engine supports every combination; deciding what to show is the
 * interface's job. So bodies, aspects and orbs per tier, the nesting rule and
 * the clustering width are all client-settable, with named presets for the
 * common cases.
 *
 * Bodies and the nesting rule are the same knob and are exposed together
 * deliberately. Measured: the prototype's body set under the loose rule gives
 * 1.61 windows per quarter; the full body set under the strict rule gives
 * 1.58. Same density, opposite routes. A client tightening one must be able to
 * loosen the other.
 */

import { z } from 'zod';

import { ASPECT_IDS } from '../../domain/orb-policy.js';
import { FUNNEL_PRESETS, TIERS, type FunnelConfig } from '../../domain/timescales.js';
import { BODY_IDS } from '../../ephemeris/bodies.js';
import { WhenSchema } from './when.js';

const AspectIdSchema = z.enum(ASPECT_IDS as [string, ...string[]]);
const BodyIdSchema = z.enum(BODY_IDS as unknown as [string, ...string[]]);

const TierConfigSchema = z
  .object({
    bodies: z.array(BodyIdSchema).min(1).max(12),
    aspects: z.array(AspectIdSchema).min(1),
    /**
     * Orb in degrees. Capped at 10: beyond that a slow body is inside orb
     * almost permanently and the funnel stops discriminating.
     */
    orbDeg: z.number().gt(0).max(10),
  })
  .strict();

export const FunnelConfigSchema = z
  .object({
    slow: TierConfigSchema,
    social: TierConfigSchema,
    fast: TierConfigSchema,
    nesting: z.enum(['same-story', 'same-point']),
    clusterDays: z.number().min(0).max(90),
  })
  .strict();

export const FunnelPresetSchema = z.enum(Object.keys(FUNNEL_PRESETS) as [string, ...string[]]);

/**
 * Longest span the funnel will compute in one request.
 *
 * Ten years costs roughly twelve seconds today, on the event loop. Until the
 * compute pool exists this is a hard bound rather than a cost estimate — a
 * request that would block the process for a minute is refused rather than
 * served slowly. The prototype accepted `futureYears: 500`.
 */
export const MAX_WINDOW_DAYS = 365 * 15;

/** ISO calendar date, the form both span parameters take. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const KeyDatesRequestSchema = z
  .object({
    // Shared with /v1/charts and /v1/transits/returns rather than copied. This
    // schema carried its own character-for-character duplicate of the union
    // until the unknown-birth-time variant had to be added to both.
    when: WhenSchema,
    geo: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    }),
    houseSystem: z.string().length(1).default('P'),
    /** The span to search, as ISO dates. */
    from: IsoDateSchema,
    to: IsoDateSchema,
    /**
     * Either a preset name or a full configuration. A preset is resolved
     * server-side and echoed back in the response, so a client never has to
     * guess what it got.
     */
    funnel: z.union([FunnelPresetSchema, FunnelConfigSchema]).default('funnel.default'),
    /** v2 by default. v1 reproduces results seen before the rewrite. */
    scoring: z.enum(['v1', 'v2']).default('v2'),
  })
  .strict();

export type KeyDatesRequest = z.infer<typeof KeyDatesRequestSchema>;

/**
 * How far back the story-window search reaches when the caller names no span.
 *
 * Ten years, and the number is measured rather than round. The endpoint exists
 * to hand someone three past dates of ONE story, so the default span has to be
 * long enough that one story usually HAS three. Counted on the reference chart
 * (12 Aug 1987, Rome), windows per story under funnel.default, by how far back
 * the span reaches:
 *
 *   3 years    2 of 7 stories reach three windows
 *   5 years    4 of 7
 *   8 years    5 of 7
 *   10 years   7 of 7   (per-story counts 3, 4, 6, 6, 7, 8, 32)
 *
 * Ten is the shortest span at which the quietest story on that chart still
 * answers. Shorter defaults look cheaper and fail silently — as an empty list
 * for exactly the users whose story has been quiet, who are the ones the
 * feature was built for.
 *
 * Two thirds of MAX_WINDOW_DAYS, so a caller who wants more can still ask.
 */
export const DEFAULT_PAST_DAYS = 365 * 10;

/**
 * Top windows a single request will return.
 *
 * Fifty was chosen when the slow tier took hard aspects only, and it was
 * comfortably above anything a story produced. Admitting the soft aspects
 * there roughly doubled the density, and the reference chart's largest story
 * now yields 53 over a ten-year span — so the cap started silently truncating
 * a real answer, which tests/golden/story-windows.golden.test.ts caught by
 * disagreeing with /v1/transits/key-dates about the same story.
 *
 * Raised with the density rather than to fit that one number: a ceiling that
 * sits one window above the largest known case is a ceiling that will bite
 * again on the next chart.
 */
export const MAX_STORY_WINDOWS = 120;

export const StoryWindowsRequestSchema = z
  .object({
    when: WhenSchema,
    geo: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    }),
    houseSystem: z.string().length(1).default('P'),
    /**
     * Which story, by signature rather than by the `id` key-dates responses
     * use for the same story.
     *
     * `id` names a story inside one response and is only meaningful next to the
     * chart that produced it. A client that stored a story in an earlier
     * session — which is the whole onboarding flow this endpoint serves — has
     * the signature, and the signature is stable across sessions and across
     * people. Accepting the per-chart id here would make the endpoint
     * unusable by the caller it exists for.
     */
    signature: z.string().min(1).max(200),
    /**
     * The span, as ISO dates. Both optional: absent, they resolve to the ten
     * years ending today. See DEFAULT_PAST_DAYS and `resolveStorySpan`.
     */
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    /**
     * The top N, strongest first. Three by default because three is what the
     * onboarding asks a new user about; returning everything is what
     * /v1/transits/key-dates already does.
     */
    limit: z.number().int().min(1).max(MAX_STORY_WINDOWS).default(3),
    funnel: z.union([FunnelPresetSchema, FunnelConfigSchema]).default('funnel.default'),
    /** v2 by default. v1 reproduces results seen before the rewrite. */
    scoring: z.enum(['v1', 'v2']).default('v2'),
  })
  .strict();

export type StoryWindowsRequest = z.infer<typeof StoryWindowsRequestSchema>;

/** An epoch instant as an ISO calendar date. */
function isoDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fill in whichever end of the span the caller left out.
 *
 * `to` defaults to today and `from` to DEFAULT_PAST_DAYS before whichever `to`
 * ended up in force — so naming only `to` walks the whole span backwards rather
 * than producing a span that runs the wrong way, which is what anchoring the
 * default `from` on today would do for any `to` in the past.
 *
 * `now` is a parameter so the resolution can be asserted against a fixed
 * instant. Production passes nothing.
 */
export function resolveStorySpan(
  span: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: number = Date.now(),
): { readonly from: string; readonly to: string } {
  const to = span.to ?? isoDateOf(now);

  // The regex above admits 2024-13-45, which Date.parse rejects outright. An
  // anchor of NaN would make the subtraction below throw on .toISOString() and
  // surface as a 500; falling back to today keeps a malformed `to` what it
  // should be — a 400 from the span checks the route runs next.
  const anchor = Date.parse(`${to}T00:00:00Z`);
  const from =
    span.from ?? isoDateOf((Number.isNaN(anchor) ? now : anchor) - DEFAULT_PAST_DAYS * 86_400_000);

  return { from, to };
}

/** Resolve a preset name, or pass a full configuration through. */
export function resolveFunnel(value: string | FunnelConfig): FunnelConfig {
  if (typeof value !== 'string') return value;
  // Object.hasOwn, not an undefined check: the indexed type claims the lookup
  // always succeeds, so TypeScript treats the guard as dead code. The string
  // arrives from the wire, where it can be anything.
  if (!Object.hasOwn(FUNNEL_PRESETS, value)) {
    throw new Error(`Unknown funnel preset: ${value}`);
  }
  return FUNNEL_PRESETS[value as keyof typeof FUNNEL_PRESETS];
}

/** What /v1/meta/funnel serves, so a client can build a configuration. */
export function funnelMetadata(): unknown {
  return {
    tiers: Object.entries(TIERS).map(([id, meta]) => ({
      id,
      role: meta.role,
      typicalContactDays: meta.contactDays,
      availableBodies: meta.available,
    })),
    presets: Object.entries(FUNNEL_PRESETS).map(([id, config]) => ({ id, config })),
    aspects: ASPECT_IDS,
    nestingRules: [
      {
        id: 'same-story',
        note: 'All three levels touch the same natal story. The story is what keeps a chart from being noise.',
      },
      {
        id: 'same-point',
        note: 'All three touch the same natal point. Far stricter; pair it with a wider body set.',
      },
    ],
    limits: {
      maxWindowDays: MAX_WINDOW_DAYS,
      // The two POST /v1/transits/story-windows defaults a client would
      // otherwise have to read from this repository's source.
      defaultPastDays: DEFAULT_PAST_DAYS,
      maxStoryWindows: MAX_STORY_WINDOWS,
    },
  };
}
