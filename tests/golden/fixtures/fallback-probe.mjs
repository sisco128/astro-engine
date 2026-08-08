/**
 * Computes the Sun at J2000 with a deliberately unreachable ephemeris path and
 * prints the returned flag as JSON. Spawned as a fresh process by
 * adapter-invariants.test.ts.
 *
 * Why a separate process rather than flipping the path in-test: Swiss
 * Ephemeris keeps its state in a process-global struct, and calling
 * set_ephe_path after a .se1 file is already open does NOT reliably invalidate
 * it. Measured: under plain node the switch takes effect and the library falls
 * back to Moshier; under vitest the already-loaded file keeps being used and
 * the same code returns the correct longitude. Same library, same cwd, same
 * calls — different outcome.
 *
 * A test that depends on that behaviour tests the runtime, not the adapter.
 * A fresh process has no loaded file, so the fallback is deterministic.
 *
 * This is also the sharpest evidence for the compute pool using processes
 * rather than worker_threads: threads share one copy of this global state.
 */

import sweph from 'sweph';

const C = sweph.constants;
const flags = C.SEFLG_SWIEPH | C.SEFLG_SPEED;

sweph.set_ephe_path(process.argv[2]);
const result = sweph.calc_ut(2451545.0, C.SE_SUN, flags);

process.stdout.write(
  JSON.stringify({
    flag: result.flag,
    usedSwieph: (result.flag & C.SEFLG_SWIEPH) !== 0,
    lon: result.data[0],
    error: result.error.trim(),
  }),
);
