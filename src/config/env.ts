/**
 * The only place in this codebase that reads `process.env`.
 *
 * Parsing happens once at module load and throws before the server can bind,
 * so a misconfigured deploy fails loudly at startup instead of at the first
 * request. An ESLint `no-restricted-properties` rule keeps every other file
 * out of `process.env`.
 *
 * The prototype had no config layer at all: `PORT` was read inline at
 * server/index.js:10, `NODE_ENV` in five scattered places, and `SE_EPHE_PATH`
 * was *written* but never read (ephemeris.js:35) — the ephemeris directory was
 * hardcoded three levels up from __dirname and could not be moved.
 */

import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

import { ENGINE_VERSION } from '../version.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  throw new Error(`Environment variable ${name} must be true or false, got: ${value}`);
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function list(name: string): readonly string[] {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

// Kept in sync with ephemeris.manifest.json's `profiles` keys by a test
// (tests/unit/env.test.ts) rather than by reading the manifest here — this
// module's whole point is to be the one place that touches process.env, and
// adding a file read for a value used only in the readiness report was not
// worth blurring that. A profile added to the manifest without a matching
// entry here is exactly the drift that took CI down once already.
const EPHEMERIS_PROFILES = ['core', 'bounds', 'full'] as const;
type EphemerisProfile = (typeof EPHEMERIS_PROFILES)[number];

function profile(): EphemerisProfile {
  const value = optional('EPHEMERIS_PROFILE', 'full');
  if (!(EPHEMERIS_PROFILES as readonly string[]).includes(value)) {
    throw new Error(
      `EPHEMERIS_PROFILE must be one of ${EPHEMERIS_PROFILES.join(', ')}, got: ${value}`,
    );
  }
  return value as EphemerisProfile;
}

const defaultPoolSize = Math.max(1, Math.min(availableParallelism() - 1, 4));

/**
 * Read before the object literal because two settings need it: the AGPL source
 * pointer, and the contact route inside the default geocoding User-Agent.
 */
const sourceUrl = optional('SOURCE_URL', 'https://github.com/sisco128/astro-engine');

export const env = Object.freeze({
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  port: int('PORT', 3000),
  host: optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),

  ephemerisPath: resolve(optional('SE_EPHE_PATH', './ephem')),
  ephemerisProfile: profile(),
  strictEphemeris: bool('SE_STRICT_EPHEMERIS', true),
  forbidFallback: bool('SE_FORBID_FALLBACK', true),

  /**
   * Compute workers. Defaults to one fewer than the machine has, capped at 4:
   * the work is CPU-bound, so more workers than cores only adds contention,
   * and one core is left for the event loop to keep answering health checks.
   */
  poolSize: int('POOL_SIZE', 0) || defaultPoolSize,
  poolTaskTimeoutMs: int('POOL_TASK_TIMEOUT_MS', 60_000),

  /** Result cache. Bounded by both count and bytes: entries are multi-MB. */
  cacheMaxItems: int('CACHE_MAX_ITEMS', 500),
  cacheMaxBytes: int('CACHE_MAX_BYTES', 256 * 1024 * 1024),

  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
  maxBodyBytes: int('MAX_BODY_BYTES', 262_144),

  corsOrigins: list('CORS_ORIGINS'),

  /**
   * Accepted `x-api-key` values. Empty means no authentication at all, which
   * is the right default in development and a refusal to start in production
   * — see `authOptional`.
   */
  apiKeys: list('API_KEYS'),

  /**
   * The one way to run in production without API keys.
   *
   * The trap this exists to prevent is the quiet one: a deploy that forgets a
   * single variable comes up healthy, passes its readiness probe, and serves
   * every endpoint to anyone who finds the host — an open API that looks
   * exactly like a correctly configured one. `API_KEYS` being empty cannot
   * therefore be allowed to mean "no auth" in production by default; an
   * operator who genuinely wants that (a private network, a gateway that
   * authenticates in front) has to say so by name.
   */
  authOptional: bool('AUTH_OPTIONAL', false),

  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),

  /**
   * Geocoding upstream for GET /v1/geo/search.
   *
   * The default is the public OpenStreetMap instance, and its usage policy
   * forbids heavy or bulk production use: an absolute maximum of 1 request per
   * second, no systematic downloading, and a real User-Agent. Those terms are
   * enforced by OSM's operators by blocking the offending IP, not by a quota
   * response, so a deployment that ignores them stops geocoding for everyone
   * behind that address with no warning.
   *
   * The production path is a self-hosted Nominatim (or a commercial provider
   * with the same API) pointed at by this variable. The engine's outbound
   * queue holds to 1 rps regardless of what this points at — see
   * src/geo/nominatim.ts — because a self-hosted instance is a change of
   * capacity, not a change of contract.
   */
  nominatimBaseUrl: optional('NOMINATIM_BASE_URL', 'https://nominatim.openstreetmap.org'),

  /**
   * Sent as `User-Agent` on every geocoding request. Nominatim's policy
   * requires one that identifies the application and offers a way to reach
   * whoever runs it; requests without it are refused outright.
   *
   * The default names this engine and points at its source repository, which
   * is a working contact route. A deployment serving real users should replace
   * it with one carrying its own address.
   */
  geoUserAgent: optional('GEO_USER_AGENT', `astro-engine/${ENGINE_VERSION} (+${sourceUrl})`),

  /** Served by GET /v1/meta/license to satisfy AGPL-3.0 section 13. */
  sourceUrl,
});

export type Env = typeof env;

/** Re-exported so tests can assert the required-variable behaviour. */
export { required, EPHEMERIS_PROFILES };
