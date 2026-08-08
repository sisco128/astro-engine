/**
 * Error taxonomy for the ephemeris layer.
 *
 * Codes are part of the public API contract and are frozen at /v1. A contract
 * test enumerates them and fails if one is renamed or removed.
 */

export type EphemerisErrorCode =
  /** swe_calc_ut / swe_houses returned a negative flag. `serr` carries the reason. */
  | 'EPHEMERIS_CALC_FAILED'
  /** Swiss Ephemeris silently degraded to the built-in Moshier model. See I2 below. */
  | 'EPHEMERIS_FALLBACK'
  /** Requested instant lies outside the installed ephemeris files' coverage. */
  | 'UNSUPPORTED_DATE_RANGE'
  /** Body id is not in the supported catalogue, or invalid for this epoch. */
  | 'BODY_NOT_SUPPORTED'
  /**
   * The requested quadrant house system is undefined at this latitude. Swiss
   * Ephemeris silently substitutes Porphyry; we refuse to pass those cusps off
   * under the requested system's name. `details.suggestedSystems` lists the
   * systems that stay defined everywhere.
   */
  | 'HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE'
  /** initEphemeris() has not run, or ran and failed. */
  | 'EPHEMERIS_UNAVAILABLE';

export class EphemerisError extends Error {
  readonly code: EphemerisErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: EphemerisErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'EphemerisError';
    this.code = code;
    this.details = details;
  }
}
