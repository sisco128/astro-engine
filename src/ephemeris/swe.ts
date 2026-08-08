/**
 * The one door to Swiss Ephemeris. No other file may import `sweph`.
 *
 * The prototype lost three separate bugs to the fact that every caller talked
 * to the binding directly and each one guessed at its contract:
 *
 *   calculations.js:70        read `result.speedLongitude`
 *   transit-calculator.js:72  read `result.speed`
 *   full-transit.js:69        read `result.longitudeSpeed || result.speedLongitude || 0`
 *
 * The binding emits `longitudeSpeed`. Two of the three were therefore always
 * `undefined`, which is why `applying` was `null` on every natal aspect and
 * `retrograde` was `false` on every transit. Here, speed is `data[3]` and it
 * is called `lonSpeed` — one name, in one place, forever.
 *
 * Every call enforces four invariants. Each exists because measurement showed
 * the failure it prevents is silent.
 */

import sweph from 'sweph';

import { wrap360, type Longitude } from '../math/angle.js';
import { BODIES, isBodyId, type BodyId, type BodyMeta } from './bodies.js';
import { EphemerisError } from './errors.js';

const C = sweph.constants;

/** SWIEPH (use the .se1 files) + SPEED (also return derivatives). Never implied — invariant I4. */
const CALC_FLAGS = C.SEFLG_SWIEPH | C.SEFLG_SPEED;

/** Julian Day in Universal Time. Branded so it cannot be confused with JD in TT. */
export type JulianDayUT = number & { readonly __brand: 'JulianDayUT' };

export interface BodyState {
  readonly lon: Longitude;
  readonly lat: number;
  readonly distAu: number;
  /** Apparent geocentric longitude speed, deg/day, signed. Negative means retrograde. */
  readonly lonSpeed: number;
  readonly latSpeed: number;
  readonly distSpeed: number;
}

/**
 * When true, a silent degradation to the Moshier model is an error rather than
 * a warning. Set from config at startup; defaults to strict.
 *
 * Why this matters, measured against the real files (arcseconds of difference
 * between Moshier and Swiss Ephemeris):
 *
 *              Sun     Moon    Mars    Pluto
 *   J2000      0.00    0.09    0.04     0.25
 *   1987       0.02    1.21    0.03     0.08
 *   1200 CE    3.43    6.62    1.64    62.50
 *   3000 BCE  14.51  114.23  355.41    24.68
 *
 * Near the present the fallback is within the golden suite's own tolerances,
 * so no assertion would ever catch it. At historical dates — precisely the
 * range the `full` ephemeris profile exists to serve — it is catastrophic:
 * Mars off by six arcminutes. The returned flag is the only reliable signal.
 */
let forbidFallback = true;

export function setForbidFallback(value: boolean): void {
  forbidFallback = value;
}

/**
 * Invariant I1 — failure is `flag < 0`, NOT a non-empty error string.
 *
 * This corrects an assumption worth stating plainly: `result.error` is
 * populated on *success* too. A Moshier fallback returns flag 260 (a valid
 * result) alongside "using Moshier eph.". Treating any non-empty error as a
 * throw would reject good results; treating a negative flag as fine would
 * accept `data` full of zeroes. Swiss Ephemeris signals real failure by
 * returning -1, and only then is `serr` an error rather than a remark.
 */
function assertCalcOk(
  flag: number,
  serr: string,
  context: Readonly<Record<string, unknown>>,
): void {
  if (flag < 0) {
    throw new EphemerisError(
      'EPHEMERIS_CALC_FAILED',
      serr.trim() === '' ? 'Swiss Ephemeris returned a failure flag' : serr.trim(),
      context,
    );
  }

  // Invariant I2 — reject the silent Moshier fallback.
  if (forbidFallback && (flag & C.SEFLG_SWIEPH) === 0) {
    throw new EphemerisError(
      'EPHEMERIS_FALLBACK',
      'Swiss Ephemeris silently fell back to the Moshier model; the .se1 file for this date is missing or out of range',
      { ...context, requestedFlag: CALC_FLAGS, returnedFlag: flag, serr: serr.trim() },
    );
  }
}

/**
 * Invariant I3 — an unrecognised body id is refused before it reaches the
 * binding, because the binding will not refuse it.
 */
function bodyMetaOrThrow(body: BodyId, jd: JulianDayUT): BodyMeta {
  // isBodyId, not `BODIES[body] === undefined`: the type says the lookup always
  // succeeds, so TypeScript (correctly) flags that check as unreachable. The
  // real risk is an unvalidated string arriving from the wire, and only a
  // runtime membership test catches that.
  if (!isBodyId(body)) {
    throw new EphemerisError('BODY_NOT_SUPPORTED', `Unknown body: ${String(body)}`, { body });
  }
  const meta = BODIES[body];
  if (meta.minJdUt !== undefined && jd < meta.minJdUt) {
    throw new EphemerisError(
      'BODY_NOT_SUPPORTED',
      `${meta.name} is not defined before JD ${String(meta.minJdUt)}`,
      { body, jdUt: jd, minJdUt: meta.minJdUt },
    );
  }
  if (meta.maxJdUt !== undefined && jd > meta.maxJdUt) {
    throw new EphemerisError(
      'BODY_NOT_SUPPORTED',
      `${meta.name} is not defined after JD ${String(meta.maxJdUt)}`,
      { body, jdUt: jd, maxJdUt: meta.maxJdUt },
    );
  }
  return meta;
}

/** Position and derivatives of one body at one instant. */
export function bodyState(jd: JulianDayUT, body: BodyId): BodyState {
  const meta = bodyMetaOrThrow(body, jd);
  const result = sweph.calc_ut(jd, meta.se, CALC_FLAGS);
  assertCalcOk(result.flag, result.error, { body, jdUt: jd });

  const [lon, lat, distAu, lonSpeed, latSpeed, distSpeed] = result.data;

  return {
    // Invariant I3 — every longitude is normalised and branded on the way out,
    // so `SIGNS[12]` (positions.js:9 in the prototype) is unreachable.
    lon: wrap360(lon),
    lat,
    distAu,
    lonSpeed,
    latSpeed,
    distSpeed,
  };
}

/** Several bodies at one instant. */
export function bodyStates(
  jd: JulianDayUT,
  bodies: readonly BodyId[],
): ReadonlyMap<BodyId, BodyState> {
  const out = new Map<BodyId, BodyState>();
  for (const body of bodies) {
    out.set(body, bodyState(jd, body));
  }
  return out;
}

/** Longitude speed only — the hot path for station-finding. Avoids building a BodyState. */
export function lonSpeedAt(jd: JulianDayUT, body: BodyId): number {
  const meta = bodyMetaOrThrow(body, jd);
  const result = sweph.calc_ut(jd, meta.se, CALC_FLAGS);
  assertCalcOk(result.flag, result.error, { body, jdUt: jd });
  return result.data[3];
}

export interface UtcInstant {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
}

/** Julian Day (UT) from a UTC calendar instant. Leap-second aware via swe_utc_to_jd. */
export function jdFromUtc(utc: UtcInstant): JulianDayUT {
  const { year, month, day, hour, minute, second = 0 } = utc;
  const result = sweph.utc_to_jd(year, month, day, hour, minute, second, C.SE_GREG_CAL);
  if (result.flag < 0) {
    throw new EphemerisError('EPHEMERIS_CALC_FAILED', result.error.trim(), { ...utc });
  }
  // data[0] is JD in ET/TT, data[1] is JD in UT. We want UT.
  return result.data[1] as JulianDayUT;
}

/** The Swiss Ephemeris C library version actually loaded. Asserted in CI. */
export function seVersion(): string {
  return sweph.version();
}

/** Point the library at the .se1 directory. Idempotent at the C level. */
export function setEphemerisPath(absolutePath: string): void {
  sweph.set_ephe_path(absolutePath);
}

/** Release file handles. Called on SIGTERM. */
export function closeEphemeris(): void {
  sweph.close();
}
