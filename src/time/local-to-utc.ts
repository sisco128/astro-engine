/**
 * Local wall-clock time to UTC, with the two daylight-saving edge cases
 * reported rather than guessed.
 *
 * What this replaces: the prototype's `convertLocalToUTC`
 * (server/geocoding.js:90-154) brute-forced 29 candidate *integer* hour
 * offsets through Intl.DateTimeFormat and broke on the first match. Two
 * consequences, both silent:
 *
 *   - On a spring-forward gap it fell through to `bestMatch = testUTC`
 *     (line 144) — treating the local wall time as UTC. For a 02:30 birth on
 *     a transition night that is a two-hour error, roughly 30 degrees of
 *     Ascendant.
 *   - Integer offsets cannot represent India (+05:30), Nepal (+05:45) or the
 *     Chatham Islands (+12:45). Those births were simply wrong.
 *
 * Astro Gold resolves an ambiguous time by silently picking one. Returning
 * the ambiguity as structured data costs nothing and is strictly more useful:
 * only the person who was there knows which 01:30 they were born in.
 */

import { Temporal } from 'temporal-polyfill';

export type LocalTimeErrorCode =
  'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME' | 'INVALID_TIME_ZONE';

export class LocalTimeError extends Error {
  readonly code: LocalTimeErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LocalTimeErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'LocalTimeError';
    this.code = code;
    this.details = details;
  }
}

export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second?: number | undefined;
  /** IANA zone identifier, e.g. "Europe/Rome". */
  readonly zone: string;
}

export interface ResolvedInstant {
  /** ISO-8601 UTC instant, e.g. "1987-08-12T09:32:00Z". */
  readonly utc: string;
  /** Offset actually applied, e.g. "+02:00". */
  readonly offset: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function toUtcParts(instant: Temporal.Instant): ResolvedInstant {
  const utc = instant.toZonedDateTimeISO('UTC');
  return {
    utc: instant.toString(),
    offset: '+00:00',
    year: utc.year,
    month: utc.month,
    day: utc.day,
    hour: utc.hour,
    minute: utc.minute,
    second: utc.second,
  };
}

/**
 * Resolve a local wall-clock time to a UTC instant.
 *
 * Throws `NONEXISTENT_LOCAL_TIME` when the clock skipped over that time, and
 * `AMBIGUOUS_LOCAL_TIME` when it occurred twice. Both carry enough detail for
 * a client to ask the user which they meant — the gap's bounds in one case,
 * both candidate instants in the other.
 *
 * Temporal reports both situations with the same "Ambiguous offset" message
 * under `disambiguation: 'reject'`, so the two are told apart by counting the
 * possible instants: zero means a gap, two means a fold.
 */
export function resolveLocalTime(local: LocalDateTime): ResolvedInstant {
  const { year, month, day, hour, minute, second = 0, zone } = local;

  const plain = Temporal.PlainDateTime.from({ year, month, day, hour, minute, second });

  let possible: Temporal.Instant[];
  try {
    possible = plain.toZonedDateTime(zone, { disambiguation: 'compatible' }).timeZoneId
      ? getPossibleInstants(plain, zone)
      : [];
  } catch (error) {
    throw new LocalTimeError('INVALID_TIME_ZONE', `Unknown IANA time zone: ${zone}`, {
      zone,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (possible.length === 0) {
    // Spring forward: this wall-clock time never happened.
    const before = plain
      .subtract({ hours: 2 })
      .toZonedDateTime(zone, { disambiguation: 'compatible' });
    const after = plain.add({ hours: 2 }).toZonedDateTime(zone, { disambiguation: 'compatible' });
    throw new LocalTimeError(
      'NONEXISTENT_LOCAL_TIME',
      `${plain.toString()} does not exist in ${zone}; the clock moved forward over it.`,
      {
        zone,
        local: plain.toString(),
        gap: { offsetBefore: before.offset, offsetAfter: after.offset },
      },
    );
  }

  if (possible.length > 1) {
    // Fall back: this wall-clock time happened twice.
    throw new LocalTimeError(
      'AMBIGUOUS_LOCAL_TIME',
      `${plain.toString()} occurs twice in ${zone}; specify which by supplying a UTC instant instead.`,
      {
        zone,
        local: plain.toString(),
        candidates: possible.map((instant) => ({
          utc: instant.toString(),
          offset: instant.toZonedDateTimeISO(zone).offset,
        })),
      },
    );
  }

  const zoned = plain.toZonedDateTime(zone, { disambiguation: 'reject' });

  return {
    ...toUtcParts(zoned.toInstant()),
    offset: zoned.offset,
  };
}

/**
 * Every instant a given wall-clock time could correspond to in a zone:
 * zero across a spring-forward gap, two across a fall-back fold, one
 * otherwise.
 *
 * Counting the 'earlier' and 'later' resolutions is not enough on its own —
 * they differ in *both* cases. Across a fold they are the two real
 * occurrences; across a gap Temporal shifts them in opposite directions to
 * produce something valid. The discriminator is the round trip: a genuine
 * occurrence converts back to the wall-clock time that was asked for, and a
 * gap's substitutes do not.
 */
function getPossibleInstants(plain: Temporal.PlainDateTime, zone: string): Temporal.Instant[] {
  const candidates = [
    plain.toZonedDateTime(zone, { disambiguation: 'earlier' }).toInstant(),
    plain.toZonedDateTime(zone, { disambiguation: 'later' }).toInstant(),
  ];

  const real = candidates.filter((instant) =>
    instant.toZonedDateTimeISO(zone).toPlainDateTime().equals(plain),
  );

  // Outside a transition both resolutions land on the same instant.
  const [first, second] = real;
  if (first !== undefined && second !== undefined && first.equals(second)) {
    return [first];
  }

  return real;
}
