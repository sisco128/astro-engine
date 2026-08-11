/**
 * Request and response schemas for /v1.
 *
 * One zod definition per shape, doing three jobs at once: runtime validation,
 * the source of the TypeScript types, and — via `z.toJSONSchema` in
 * src/http/openapi.ts — the source of the published contract. That third job
 * is the point. A frontend generates its client from GET /v1/openapi.json, so
 * the thing it types itself against is the same object that rejects its
 * malformed requests, and the hand-mirrored `client/src/types/api.ts` the
 * prototype made every consumer maintain has nothing left to be wrong about.
 */

import { z } from 'zod';

import { ASPECT_IDS } from '../../domain/orb-policy.js';
import { BODY_IDS, DEFAULT_BODIES } from '../../ephemeris/bodies.js';
import { HOUSE_SYSTEMS } from '../../ephemeris/swe.js';
import { BirthTimeAssumptionSchema, WhenSchema } from './when.js';

const houseSystemLetters = Object.keys(HOUSE_SYSTEMS) as [string, ...string[]];

export const BodyIdSchema = z.enum(BODY_IDS);
export const HouseSystemSchema = z.enum(houseSystemLetters);

export const ChartRequestSchema = z
  .object({
    when: WhenSchema,
    geo: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    }),
    houseSystem: HouseSystemSchema.default('P'),
    bodies: z
      .array(BodyIdSchema)
      .min(1)
      .max(40)
      .default([...DEFAULT_BODIES]),
  })
  // Unknown keys are rejected rather than ignored: a client that misspells a
  // field should learn about it, not silently get defaults.
  .strict();

export type ChartRequestInput = z.input<typeof ChartRequestSchema>;
export type ChartRequestParsed = z.output<typeof ChartRequestSchema>;

/**
 * The response carries numbers and identifiers only.
 *
 * Deliberately absent, all of which the prototype shipped: `formatted`
 * degree strings, glyphs, sign names and indices, `analysis.interpretation`
 * prose, and the `performance` block that leaked process memory statistics to
 * every caller.
 */
export const ChartResponseSchema = z.object({
  chartRef: z.string(),
  engine: z.object({
    version: z.string(),
    se: z.string(),
  }),
  jdUt: z.number(),
  utc: z.string(),
  geo: z.object({ lat: z.number(), lon: z.number() }),
  bodies: z.array(
    z.object({
      id: BodyIdSchema,
      lon: z.number(),
      lat: z.number(),
      distAu: z.number(),
      lonSpeed: z.number(),
      retrograde: z.boolean(),
      house: z.number().int().min(1).max(12),
    }),
  ),
  angles: z.object({
    ascendant: z.number(),
    midheaven: z.number(),
    armc: z.number(),
    vertex: z.number(),
    equatorialAscendant: z.number(),
  }),
  houses: z.object({
    system: HouseSystemSchema,
    cusps: z.array(z.number()).length(12),
  }),
  /**
   * The natal aspects, with their orbs.
   *
   * An aspect exists only relative to an orb policy, so the engine publishes
   * them rather than leaving each client to reimplement the tables — which is
   * exactly the duplication this project spent a phase removing, seven copies
   * down to one. A second copy in a frontend would be the eighth.
   *
   * `aspects.length` is the count; `orb` is the number a reader checks against
   * the longitudes in the same response.
   */
  aspects: z.array(
    z.object({
      a: BodyIdSchema,
      b: BodyIdSchema,
      aspect: z.enum(ASPECT_IDS as [string, ...string[]]),
      exactAngle: z.number(),
      separation: z.number(),
      orb: z.number(),
      applying: z.boolean().optional(),
    }),
  ),
  /**
   * Present only for the `localDate` variant of `when`. The houses and angles
   * above are computed at the assumed hour and returned rather than
   * suppressed — an Ascendant nobody can check is still the best available
   * estimate — and this block is what stops them being read as measured.
   */
  birthTime: BirthTimeAssumptionSchema.optional(),
});

export type ChartResponse = z.infer<typeof ChartResponseSchema>;
