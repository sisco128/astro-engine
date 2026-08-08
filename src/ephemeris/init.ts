/**
 * Ephemeris readiness, as a state machine rather than a hope.
 *
 * The prototype's equivalent (server/astrology/core/ephemeris.js) swallowed a
 * failed `require('swisseph')` in a try/catch and then ran
 * `initializeEphemeris()` — an fs.existsSync on a hardcoded relative path — on
 * *every single call*, with no idempotency guard and no verification that the
 * files were usable. Meanwhile /api/health reported `status: 'healthy'`
 * without ever touching the ephemeris. The service could boot green and 500
 * on every calculation. That is the single most misleading behaviour in that
 * codebase, and this module exists to invert it.
 */

import { env } from '../config/env.js';
import { EphemerisError } from './errors.js';
import {
  bodyState,
  setEphemerisPath,
  setForbidFallback,
  seVersion,
  type JulianDayUT,
} from './swe.js';

export type EphemerisState = 'cold' | 'ready' | 'failed';

/** J2000.0 — the probe epoch. */
const JD_J2000 = 2451545.0 as JulianDayUT;

/**
 * Reference longitudes at J2000.0 from Swiss Ephemeris 2.10.03 with the
 * manifest's files. Not ground truth — the golden suite does that against JPL
 * Horizons. These exist to notice that the data on disk is not the data that
 * produced them.
 */
const PROBE = [
  { body: 'sun', lon: 280.36891867 },
  { body: 'moon', lon: 223.323751446 },
] as const;

const PROBE_TOLERANCE_ARCSEC = 0.001;

let state: EphemerisState = 'cold';
let failureReason: string | undefined;
let version: string | undefined;

export interface ReadinessReport {
  readonly state: EphemerisState;
  readonly seVersion?: string;
  readonly ephemerisPath: string;
  readonly profile: string;
  readonly forbidFallback: boolean;
  readonly reason?: string;
}

/**
 * Idempotent. Safe to call from every worker at startup; the second call is a
 * no-op once ready.
 */
export function initEphemeris(): ReadinessReport {
  if (state === 'ready') return report();

  try {
    setForbidFallback(env.forbidFallback);
    setEphemerisPath(env.ephemerisPath);
    version = seVersion();

    for (const expected of PROBE) {
      // Any fallback or failure throws out of here — invariants I1 and I2.
      const actual = bodyState(JD_J2000, expected.body);
      const deltaArcsec = Math.abs(actual.lon - expected.lon) * 3600;

      if (deltaArcsec > PROBE_TOLERANCE_ARCSEC) {
        throw new EphemerisError(
          'EPHEMERIS_UNAVAILABLE',
          `Probe mismatch for ${expected.body}: longitude differs by ${deltaArcsec.toFixed(4)} arcsec. ` +
            `The ephemeris files on disk are not the ones this build expects.`,
          { body: expected.body, expected: expected.lon, actual: actual.lon },
        );
      }
    }

    state = 'ready';
    failureReason = undefined;
  } catch (error) {
    state = 'failed';
    failureReason = error instanceof Error ? error.message : String(error);
  }

  return report();
}

export function report(): ReadinessReport {
  return {
    state,
    ...(version !== undefined ? { seVersion: version } : {}),
    ephemerisPath: env.ephemerisPath,
    profile: env.ephemerisProfile,
    forbidFallback: env.forbidFallback,
    ...(failureReason !== undefined ? { reason: failureReason } : {}),
  };
}

/** Throws unless the ephemeris is ready. Called by every calculation route. */
export function assertReady(): void {
  if (state !== 'ready') {
    throw new EphemerisError(
      'EPHEMERIS_UNAVAILABLE',
      failureReason ?? 'Ephemeris has not been initialised',
      { state },
    );
  }
}

/** Test seam. Not exported through the barrel. */
export function resetForTests(): void {
  state = 'cold';
  failureReason = undefined;
  version = undefined;
}
