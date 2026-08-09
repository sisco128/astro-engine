/**
 * The birth moment, in the three forms a caller can actually supply it — and
 * what the engine does when nobody knows the hour.
 *
 * The union lived in two places before this file: `WhenSchema` in v1.ts and a
 * character-for-character copy inlined in funnel.ts. Adding a third variant to
 * one copy and not the other is exactly the drift the orb tables suffered in
 * the prototype (seven copies of the same numbers, nothing keeping them in
 * step), so the union is defined once here and imported by all three request
 * schemas.
 *
 * Offering `utc` and `local` both matters: a client that already knows the UTC
 * instant should not be forced through a zone lookup, and a client that only
 * has "11:32 in Rome" must not be left to do the conversion itself — that is
 * precisely the conversion the prototype got wrong. `localDate` is the third
 * case, and the common one in practice: the date is on the birth certificate,
 * the hour is not.
 */

import { z } from 'zod';

import { resolveLocalTime } from '../../time/local-to-utc.js';

const calendarDate = {
  year: z.number().int().min(-12000).max(16000),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
};

const wallClock = {
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  second: z.number().int().min(0).max(60).optional(),
};

/** IANA identifier, e.g. "Europe/Rome". */
const zone = z.string().min(1);

export const WhenSchema = z.union([
  z.object({ utc: z.object({ ...calendarDate, ...wallClock }) }),
  z.object({ local: z.object({ ...calendarDate, ...wallClock, zone }) }),
  z.object({
    /**
     * Date without an hour: the birth time is unknown. Strict, unlike the two
     * variants above, because the failure it prevents is specific — a caller
     * that did supply `hour` here would otherwise have it silently dropped and
     * receive a chart built on the assumed 03:00, complete with a response
     * block declaring the hour unknown. Better a 400 pointing at the key.
     */
    localDate: z.object({ ...calendarDate, zone }).strict(),
  }),
]);

export type When = z.infer<typeof WhenSchema>;

/**
 * The hour assumed when the birth time is unknown: 03:00 local.
 *
 * Not noon. A UCL study of roughly 5 million births found over half of
 * spontaneous births fall between 01:00 and 07:00, peaking near 04:00; a US
 * study of about 43,000 deliveries put the peak at 02:00-04:00. Noon is where
 * the day is halved, not where births happen — and it is chosen silently,
 * which is the part that matters. This assumption is declared in the response
 * instead, so a client can repeat it to the person it concerns.
 *
 * 03:00 rather than 04:00: it sits inside both studies' peaks, and it is the
 * first hour above the 02:00-02:59 band that most spring-forward transitions
 * delete — so the assumed hour is a wall-clock time that genuinely existed in
 * nearly every zone, and the lenient resolution below stays the exception.
 */
export const ASSUMED_BIRTH_LOCAL = { hour: 3, minute: 0 } as const;

/** Local hours the assumption is drawn from — the measured peak, not a guess. */
const BASIS_PEAK_LOCAL_HOURS = { from: 2, to: 4 } as const;

/**
 * What the response says when the hour was assumed. Numbers and identifiers
 * only, like everything else on the wire: `basis` is a key a client can look
 * up or translate, not a sentence, and the clock is `{ hour, minute }` rather
 * than the string "03:00".
 *
 * `uncertaintyHours` is 24 and not 6. The assumption picks the likeliest hour;
 * it does not narrow the range. Anything that depends on the hour is uncertain
 * across the whole day, which is the number behind each story's
 * `timeSensitive` flag.
 */
export const BirthTimeAssumptionSchema = z.object({
  assumed: z.literal(true),
  /** The wall clock the chart was actually built on, and the zone it is in. */
  assumedLocal: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    zone: z.string().min(1),
  }),
  basis: z.literal('spontaneous-birth-peak'),
  basisPeakLocalHours: z.object({ from: z.number(), to: z.number() }),
  uncertaintyHours: z.number(),
});

export type BirthTimeAssumption = z.infer<typeof BirthTimeAssumptionSchema>;

export interface ResolvedWhen {
  /** UTC instant, ready for the calculation layer. */
  readonly utc: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second?: number | undefined;
  };
  /**
   * Present only when the hour was assumed. Absent — not `assumed: false` —
   * for a known birth time, so a response built from a real hour carries
   * nothing it did not carry before this feature existed.
   */
  readonly birthTime?: BirthTimeAssumption;
}

/**
 * Birth moment to UTC parts, plus the assumption if one was made.
 *
 * Local wall-clock time is resolved here rather than inside the calculation
 * layer, so a DST gap or fold surfaces as a 409 the client can act on rather
 * than as a silently shifted chart.
 */
export function resolveWhen(when: When): ResolvedWhen {
  if ('utc' in when) return { utc: when.utc };

  if ('local' in when) {
    const resolved = resolveLocalTime(when.local);
    return {
      utc: {
        year: resolved.year,
        month: resolved.month,
        day: resolved.day,
        hour: resolved.hour,
        minute: resolved.minute,
        second: resolved.second,
      },
    };
  }

  const { year, month, day, zone: ianaZone } = when.localDate;

  // 'compatible' here, 'reject' everywhere else. Refusing an assumed 03:00
  // because that wall-clock hour was ambiguous or skipped in that zone would
  // ask the caller to resolve a 60-minute uncertainty inside a 24-hour one we
  // have already declared — and they have nothing to answer with, since the
  // hour is ours and not theirs.
  const resolved = resolveLocalTime(
    { year, month, day, ...ASSUMED_BIRTH_LOCAL, zone: ianaZone },
    { disambiguation: 'compatible' },
  );

  return {
    utc: {
      year: resolved.year,
      month: resolved.month,
      day: resolved.day,
      hour: resolved.hour,
      minute: resolved.minute,
      second: resolved.second,
    },
    birthTime: {
      assumed: true,
      assumedLocal: { ...ASSUMED_BIRTH_LOCAL, zone: ianaZone },
      basis: 'spontaneous-birth-peak',
      basisPeakLocalHours: BASIS_PEAK_LOCAL_HOURS,
      uncertaintyHours: 24,
    },
  };
}
