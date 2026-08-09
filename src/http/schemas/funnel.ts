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
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
    limits: { maxWindowDays: MAX_WINDOW_DAYS },
  };
}
