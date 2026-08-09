/**
 * GET /v1/geo/search — query and response shapes.
 *
 * The only /v1 endpoint whose input arrives as a query string rather than a
 * JSON body, which is why `limit` is coerced: everything in a query string is
 * a string, and `?limit=5` must mean the number 5 and `?limit=abc` must be a
 * 400 rather than a silent NaN.
 */

import { z } from 'zod';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../../geo/search.js';

/**
 * Long enough for "Piazza della Repubblica, Firenze, Italia" with room to
 * spare, short enough that nobody uses the geocoder as a tunnel. A query this
 * long is a bug in the caller, not a place.
 */
export const MAX_QUERY_LENGTH = 200;

export const GeoSearchQuerySchema = z
  .object({
    q: z
      .string()
      .max(MAX_QUERY_LENGTH)
      // Checked after trimming: "   " is an empty query wearing a disguise,
      // and forwarding it upstream would spend a rate-limited request to be
      // told nothing.
      .refine((value) => value.trim() !== '', { message: 'q must not be empty' }),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  // Unknown parameters are rejected, as everywhere else in /v1: `?limt=10`
  // silently returning five results is the failure mode this costs nothing to
  // rule out.
  .strict();

export type GeoSearchQuery = z.infer<typeof GeoSearchQuerySchema>;

/**
 * The response.
 *
 * A real schema, unlike key-dates and returns, because the handler's return
 * value is typed by it — `z.infer` of this is what the route function must
 * satisfy, so TypeScript keeps the document and the handler equal rather than
 * this being a hopeful parallel copy.
 */
export const GeoSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      /** Full administrative path, e.g. "Roma, Roma Capitale, Lazio, Italia". */
      name: z.string(),
      lat: z.number(),
      lon: z.number(),
      /** IANA identifier. Goes straight into `when.local.zone` of POST /v1/charts. */
      zone: z.string(),
      /** ISO 3166-1 alpha-2, when the upstream knows it. */
      countryCode: z.string().optional(),
    }),
  ),
});

export type GeoSearchResponse = z.infer<typeof GeoSearchResponseSchema>;
