/**
 * Where the tests look for ephemeris data when nothing says otherwise.
 *
 * Resolved from this file's own location, so it is the repository's `ephem/`
 * directory on any machine. Each test file used to carry its own default of
 * `~/Desktop/astro-engine/ephem` — one developer's directory layout, hardcoded
 * six times, and already stale in one copy that still pointed at the
 * prototype. On CI, where no such path exists, Swiss Ephemeris does not fail:
 * it falls back to the Moshier model and returns plausible numbers that are
 * wrong by arcseconds. Invariant I2 is what turns that into a loud failure,
 * and this is what stops it happening in the first place.
 */

import { fileURLToPath } from 'node:url';

/** The repository's ephemeris directory, as an absolute path. */
export const REPO_EPHE_PATH = fileURLToPath(new URL('../../ephem', import.meta.url));

/**
 * Point Swiss Ephemeris at the repository's data unless the environment
 * already says where to look.
 *
 * Assigns to `process.env` because the C library reads `SE_EPHE_PATH` itself,
 * independently of `set_ephe_path` — a fact this project learned when an
 * inherited value silently rescued a deliberately broken path in a test.
 */
export function useRepoEphemeris(): string {
  process.env['SE_EPHE_PATH'] ??= REPO_EPHE_PATH;
  return process.env['SE_EPHE_PATH'];
}
