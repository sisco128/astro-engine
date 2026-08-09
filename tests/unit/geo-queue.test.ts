/**
 * The outbound rate limit.
 *
 * Nominatim's policy is one request per second, absolute, enforced by OSM
 * blocking the source address rather than by a response a client could back
 * off from. These tests are what keeps that limit real: they run on an
 * injected clock, so the interval is asserted exactly and no test waits a
 * second to find out.
 */

import { describe, expect, it } from 'vitest';

import { createSerialQueue, type Clock } from '../../src/geo/queue.js';

/**
 * A clock that never actually waits. `sleep` advances the virtual now, which
 * is precisely what the queue is measuring against.
 */
function fakeClock(): Clock & { now(): number } {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

describe('the serial queue', () => {
  it('does not delay the first task', async () => {
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const started = clock.now();
    await run(() => Promise.resolve('ok'));

    expect(clock.now()).toBe(started);
  });

  it('spaces starts by at least the minimum interval', async () => {
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const starts: number[] = [];
    const task = (): Promise<void> => {
      starts.push(clock.now());
      return Promise.resolve();
    };

    await Promise.all([run(task), run(task), run(task)]);

    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i += 1) {
      const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('runs one task at a time, in the order they were queued', async () => {
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const events: string[] = [];
    const task = (name: string) => async (): Promise<void> => {
      events.push(`start ${name}`);
      await Promise.resolve();
      events.push(`end ${name}`);
    };

    await Promise.all([run(task('a')), run(task('b')), run(task('c'))]);

    // Serial, not merely spaced: no task starts before its predecessor ends.
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('charges a slow task against the interval rather than adding to it', async () => {
    // The budget is a rate against the upstream's wall clock. A request that
    // itself took two seconds has already paid the gap; making the next one
    // wait another full second on top would halve the throughput the policy
    // actually allows.
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const starts: number[] = [];
    await run(async () => {
      starts.push(clock.now());
      await clock.sleep(2_000);
    });
    await run(() => {
      starts.push(clock.now());
      return Promise.resolve();
    });

    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBe(2_000);
  });

  it('keeps running after a task rejects', async () => {
    // Chaining the queue directly onto the previous result would make one
    // upstream 500 reject everything queued behind it — and, since the chain
    // is permanent, everything queued after that for the life of the process.
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const failed = run(() => Promise.reject(new Error('upstream is down')));
    const after = run(() => Promise.resolve('still working'));

    await expect(failed).rejects.toThrow('upstream is down');
    await expect(after).resolves.toBe('still working');
  });

  it('gives each task its own result', async () => {
    const clock = fakeClock();
    const run = createSerialQueue({ minIntervalMs: 1_000, clock });

    const results = await Promise.all([1, 2, 3].map((n) => run(() => Promise.resolve(n * 10))));

    expect(results).toEqual([10, 20, 30]);
  });
});
