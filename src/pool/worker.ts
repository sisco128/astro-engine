/**
 * A compute worker: its own process, its own Swiss Ephemeris state.
 *
 * "Its own" is the whole point. Swiss Ephemeris keeps everything in a
 * process-global struct — open .se1 handles, the file cache, the ephemeris
 * path, the sidereal mode. Threads would share one copy of it.
 *
 * That is not a theoretical hazard. This project has watched that global state
 * produce a confidently wrong answer three separate times:
 *
 *   1. An invariant test passed because set_ephe_path did not invalidate an
 *      already-open file.
 *   2. The same test passed again because a child inherited SE_EPHE_PATH,
 *      which the C library reads on its own.
 *   3. A bisection search for the ephemeris coverage bound read its own
 *      cache side effects and published a ceiling of JD 7857128 — a date that
 *      fails from a clean start. The true bound is 7857125.
 *
 * Every one of those looked plausible and was wrong. A data race on that cache
 * would fail the same way: not a crash, just numbers. Separate processes give
 * each worker its own struct by construction, and no amount of concurrency can
 * make them interfere.
 */

import { initEphemeris } from '../ephemeris/init.js';
import { seVersion } from '../ephemeris/swe.js';
import { buildFunnel } from '../transits/funnel.js';
import { planetaryReturns } from '../transits/returns.js';
import type { JulianDayUT } from '../ephemeris/swe.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

function send(message: WorkerResponse): void {
  process.send?.(message);
}

const readiness = initEphemeris();

if (readiness.state !== 'ready') {
  // Exit rather than serve. A worker that cannot compute must not sit in the
  // pool answering with fallback numbers — see invariant I2.
  process.stderr.write(`worker: ephemeris unavailable: ${readiness.reason ?? 'unknown'}\n`);
  process.exit(1);
}

send({ kind: 'ready', seVersion: seVersion() });

function compute(message: WorkerRequest): unknown {
  switch (message.kind) {
    case 'funnel':
      return buildFunnel({
        stories: message.stories,
        natalPoints: message.natalPoints,
        fromJd: message.fromJd as JulianDayUT,
        toJd: message.toJd as JulianDayUT,
        config: message.config,
      });
    case 'returns':
      return planetaryReturns({
        bodies: message.bodies,
        natalLon: new Map(message.natalLon),
        birthJd: message.birthJd as JulianDayUT,
        toJd: message.toJd as JulianDayUT,
      });
  }
}

process.on('message', (message: WorkerRequest) => {
  const startedAt = Date.now();

  try {
    send({
      kind: 'result',
      id: message.id,
      payload: compute(message),
      computeMs: Date.now() - startedAt,
    });
  } catch (error) {
    send({
      kind: 'error',
      id: message.id,
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'COMPUTE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
