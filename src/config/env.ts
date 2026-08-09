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

const EPHEMERIS_PROFILES = ['core', 'full'] as const;
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
  apiKeys: list('API_KEYS'),
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60),

  /** Served by GET /v1/meta/license to satisfy AGPL-3.0 section 13. */
  sourceUrl: optional('SOURCE_URL', 'https://github.com/sisco128/astro-engine'),
});

export type Env = typeof env;

/** Re-exported so tests can assert the required-variable behaviour. */
export { required };
