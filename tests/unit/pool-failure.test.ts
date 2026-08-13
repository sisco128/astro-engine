/**
 * What the pool does when a worker dies, and what the caller is told.
 *
 * Driven by a stand-in worker rather than the real one: every case here is a
 * worker that hangs or is killed, and the real worker's answer would be the
 * one thing none of them get to give. It also means these run in milliseconds
 * and need no ephemeris.
 *
 * The behaviour under test is not hypothetical. On 13 August 2026 the deployed
 * engine answered two of sixteen key-dates requests; the rest reached the
 * caller as `500 INTERNAL`, or as nothing at all. See tests/contract/pool.test.ts
 * for the property the pool exists for, and docs/adr for why it is processes.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ComputePool, PoolError, type PoolOptions } from '../../src/pool/pool.js';

/**
 * A worker that reports ready and then does exactly what the task's `stories`
 * field names — the field is a convenient carrier here, not a funnel.
 */
const STAND_IN = `
process.send({ kind: 'ready', seVersion: 'stand-in' });

process.on('message', (task) => {
  const behaviour = task.stories[0];

  if (behaviour === 'answer') {
    process.send({ kind: 'result', id: task.id, payload: { ok: true }, computeMs: 0 });
    return;
  }
  if (behaviour === 'die') {
    // Killed by a signal, which is what the OOM killer looks like from here:
    // an exit code of null, mid-task.
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  // 'hang': never answers, and cannot be interrupted — the real worker is
  // inside synchronous C for the whole of a long span.
});
`;

const directory = mkdtempSync(join(tmpdir(), 'pool-failure-'));
const workerPath = join(directory, 'stand-in-worker.js');
writeFileSync(workerPath, STAND_IN);

let pool: ComputePool | undefined;

function makePool(options: Omit<PoolOptions, 'workerPath'>): ComputePool {
  pool = new ComputePool({ ...options, workerPath });
  return pool;
}

/** `stories` carries the instruction; the rest is the shape of a funnel task. */
function task(behaviour: 'answer' | 'die' | 'hang'): Parameters<ComputePool['run']>[0] {
  return {
    kind: 'funnel',
    stories: [behaviour],
    natalPoints: [],
    fromJd: 0,
    toJd: 0,
    config: {},
  } as unknown as Parameters<ComputePool['run']>[0];
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'RESOLVED';
  } catch (error) {
    return error instanceof PoolError ? error.code : `NOT A PoolError: ${String(error)}`;
  }
}

afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe('a worker dying mid-task', () => {
  it('rejects that task, and only that task', async () => {
    const running = makePool({ size: 2, taskTimeoutMs: 5000 });
    await running.whenReady();

    const [dead, alive] = await Promise.all([
      codeOf(running.run(task('die'))),
      codeOf(running.run(task('answer'))),
    ]);

    expect(dead).toBe('COMPUTE_WORKER_LOST');
    expect(alive).toBe('RESOLVED');
  });

  it('leaves a pool that still works', async () => {
    const running = makePool({ size: 1, taskTimeoutMs: 5000 });
    await running.whenReady();

    expect(await codeOf(running.run(task('die')))).toBe('COMPUTE_WORKER_LOST');

    // The replacement has to finish starting before it can be asked.
    await running.whenReady();
    expect(await codeOf(running.run(task('answer')))).toBe('RESOLVED');
  });
});

describe('the deadline covers the wait, not just the compute', () => {
  /**
   * The defect this pins. A task used to get its clock only once a worker
   * picked it up, so with every worker busy a caller could wait any amount of
   * time at all before its own 60 seconds even began. In production that
   * produced key-dates requests of 101, 119 and 162 seconds against a caller
   * that had stopped listening at 60.
   */
  it('answers a queued task within the timeout, worker or no worker', async () => {
    const running = makePool({ size: 1, taskTimeoutMs: 300 });
    await running.whenReady();

    // The only worker is occupied forever; this one never reaches it.
    void running.run(task('hang')).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const code = await codeOf(running.run(task('answer')));
    const waited = Date.now() - startedAt;

    expect(code).toBe('COMPUTE_OVERLOADED');
    // Bounded by the timeout it was given, not by the task ahead of it.
    expect(waited).toBeLessThan(1500);
  });

  it('kills a worker that overruns, and says that is what happened', async () => {
    const running = makePool({ size: 1, taskTimeoutMs: 300 });
    await running.whenReady();

    try {
      await running.run(task('hang'));
      expect.unreachable('a hanging task must not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(PoolError);
      expect((error as PoolError).code).toBe('COMPUTE_WORKER_LOST');
      // Not "exited with code null", which is the same sentence the kernel
      // killing a worker produces. Reading those two apart in a log at 09:43
      // is the whole difference between a memory fault and a slow span.
      expect((error as PoolError).message).toContain('did not finish in time');
    }
  });

  it('answers a task exactly once when its own timer killed its worker', async () => {
    const running = makePool({ size: 1, taskTimeoutMs: 200 });
    await running.whenReady();

    // The kill provokes an exit, which is a second chance to answer the same
    // task. Settling twice would resolve a promise already rejected — silent,
    // and impossible to see from a log.
    let settlements = 0;
    const counted = running.run(task('hang')).then(
      () => (settlements += 1),
      () => (settlements += 1),
    );

    await counted;
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(settlements).toBe(1);
  });
});

/** 'RESOLVED' / a PoolError code / 'NEVER SETTLED' — the third is the bug. */
async function outcomeOf(promise: Promise<unknown>, withinMs = 4000): Promise<string> {
  return Promise.race([
    codeOf(promise),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('NEVER SETTLED');
      }, withinMs).unref(),
    ),
  ]);
}

describe('a pool that has given up', () => {
  /**
   * Six deaths in a minute is one more than the breaker allows, and the two
   * tasks behind them are the ones that matter: they are still in the queue at
   * the moment the pool stops respawning.
   *
   * The breaker used to `return` and nothing more. Whatever was queued behind
   * the crashes was left holding promises nothing would ever settle — and
   * since respawning only ever happened on a worker's exit, a pool with no
   * workers had no event left that could bring one back. Both halves are
   * needed for the queue to drain: something must answer it, or something
   * must come back to serve it.
   *
   * The timeout here is deliberately far longer than the test. A deadline
   * expiring would answer these tasks by a different route and hide whether
   * the breaker answers them at all.
   */
  function crashPastTheBreaker(running: ComputePool): {
    crashed: Promise<string>[];
    queuedBehind: Promise<string>[];
  } {
    // Submitted together, so all eight are in the queue before the first one
    // is dispatched. FIFO: the deaths go first.
    const crashed = Array.from({ length: 6 }, () => outcomeOf(running.run(task('die'))));
    const queuedBehind = Array.from({ length: 2 }, () => outcomeOf(running.run(task('answer'))));
    return { crashed, queuedBehind };
  }

  it('answers what was queued behind the crashes', async () => {
    // Room for all eight: the default depth is size * 4, which would refuse
    // half of them before the breaker had anything to trip on.
    const running = makePool({
      size: 1,
      taskTimeoutMs: 120_000,
      recoveryMs: 60_000,
      maxQueueDepth: 20,
    });
    await running.whenReady();

    const { crashed, queuedBehind } = crashPastTheBreaker(running);

    expect(await Promise.all(crashed)).toEqual(
      Array.from({ length: 6 }, () => 'COMPUTE_WORKER_LOST'),
    );

    // The assertion the incident is about: told, rather than left waiting.
    const behind = await Promise.all(queuedBehind);
    expect(behind).not.toContain('NEVER SETTLED');
    expect(behind).toEqual(['COMPUTE_UNAVAILABLE', 'COMPUTE_UNAVAILABLE']);
    expect(running.depth).toBe(0);
  }, 30_000);

  it('starts again after its recovery window', async () => {
    const running = makePool({
      size: 1,
      taskTimeoutMs: 120_000,
      recoveryMs: 250,
      maxQueueDepth: 20,
    });
    await running.whenReady();

    const { crashed, queuedBehind } = crashPastTheBreaker(running);
    await Promise.all([...crashed, ...queuedBehind]);

    // A pool that stays dead until someone redeploys turns a bad minute into
    // an outage. Nothing else in the process can bring a worker back.
    await running.whenReady(5000);
    expect(await outcomeOf(running.run(task('answer')))).toBe('RESOLVED');
  }, 30_000);
});
