/**
 * POST /v1/transits/returns — the cyclic, as a request.
 *
 * Deliberately narrower than key-dates. There is no `from`: the scan always
 * starts at birth, because which occurrence a return is (first Saturn Return
 * versus second) can only be counted from the actual beginning, and the
 * engine refuses to let a caller accidentally renumber a life by querying a
 * slice of it. There is no `geo` either: returns are contacts between a
 * body's geocentric longitude and its own natal value, and neither number
 * depends on where on Earth the birth happened. Requiring coordinates would
 * imply they matter.
 */

import { z } from 'zod';

import { LIFE_PHASE_BODIES } from '../../domain/life-phases.js';
import { BODY_IDS } from '../../ephemeris/bodies.js';
import { EXCLUDED_BODIES } from '../../domain/timescales.js';
import { WhenSchema } from './v1.js';

/**
 * The horizon is bounded in years-of-life, not window days: the scan is
 * birth-anchored, so the cost driver is how much of a life is computed, and
 * 120 years covers any living subject with margin.
 */
export const MAX_RETURN_YEARS = 120;
export const DEFAULT_RETURN_YEARS = 100;

const returnableBodies = BODY_IDS.filter(
  (id) => !(EXCLUDED_BODIES as readonly string[]).includes(id),
);

export const ReturnsRequestSchema = z
  .object({
    when: WhenSchema,
    /**
     * Which bodies to cycle. Defaults to the four with a named vocabulary;
     * any transiting body is computable, it just carries no phase label.
     * The bodies excluded from transits for measured reasons (Moon, nodes,
     * Lilith — timescales.ts) are excluded here for the same ones.
     */
    bodies: z
      .array(z.enum(returnableBodies as [string, ...string[]]))
      .min(1)
      .default([...LIFE_PHASE_BODIES]),
    /** Years of life to scan from birth. */
    horizonYears: z.number().int().min(1).max(MAX_RETURN_YEARS).default(DEFAULT_RETURN_YEARS),
  })
  .strict();

export type ReturnsRequest = z.infer<typeof ReturnsRequestSchema>;
