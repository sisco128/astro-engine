/**
 * Error taxonomy for the geocoding layer.
 *
 * One code, deliberately. Every way the upstream can let us down — a timeout,
 * a 5xx, a 403 because the deployment got itself blocked, a body that is not
 * the JSON it promised — is the same fact from the caller's side: the engine
 * could not reach a geocoder, and nothing about the request would change that.
 * Splitting it into four codes would invite clients to branch on distinctions
 * they cannot act on. The specifics go in `details`, which is where a client
 * looks to report a problem rather than to make a decision.
 *
 * Like the ephemeris codes, this one is part of the /v1 contract and is
 * registered in STATUS_BY_CODE (502).
 */

export type GeoErrorCode = 'GEO_UPSTREAM_FAILED';

export class GeoError extends Error {
  readonly code: GeoErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GeoErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GeoError';
    this.code = code;
    this.details = details;
  }
}
