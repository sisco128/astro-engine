/**
 * Request and response schemas for /v1.
 *
 * One zod definition per shape, used for runtime validation and as the source
 * of the TypeScript types. These move to `packages/contract` in phase 6, where
 * they also generate the OpenAPI document and are published for the frontend
 * repositories to depend on — replacing the hand-mirrored, unversioned
 * `client/src/types/api.ts` the prototype required every consumer to maintain.
 */

import { z } from 'zod';

import { BODY_IDS, DEFAULT_BODIES } from '../../ephemeris/bodies.js';
import { HOUSE_SYSTEMS } from '../../ephemeris/swe.js';

const houseSystemLetters = Object.keys(HOUSE_SYSTEMS) as [string, ...string[]];

export const BodyIdSchema = z.enum(BODY_IDS);
export const HouseSystemSchema = z.enum(houseSystemLetters);

/**
 * Birth moment, given either as a UTC instant or as a local wall-clock time
 * with its IANA zone.
 *
 * Offering both matters: a client that already knows the UTC instant should
 * not be forced through a zone lookup, and a client that only has "11:32 in
 * Rome" must not be left to do the conversion itself — that is precisely the
 * conversion the prototype got wrong.
 */
export const WhenSchema = z.union([
  z.object({
    utc: z.object({
      year: z.number().int().min(-12000).max(16000),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      second: z.number().int().min(0).max(60).optional(),
    }),
  }),
  z.object({
    local: z.object({
      year: z.number().int().min(-12000).max(16000),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      second: z.number().int().min(0).max(60).optional(),
      /** IANA identifier, e.g. "Europe/Rome". */
      zone: z.string().min(1),
    }),
  }),
]);

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
});

export type ChartResponse = z.infer<typeof ChartResponseSchema>;
