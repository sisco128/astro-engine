/**
 * The pool must fit the box it is in.
 *
 * A live outage: sixteen `POST /v1/transits/key-dates` arrived, two were
 * answered, and the rest died with `PoolError: Worker exited with code null`.
 * `code null` is a signal — the kernel killing a process, not a crash. Four
 * forked workers, each holding its own ephemeris, on a 512 MB instance that
 * was also asked to hold a 256 MB result cache.
 *
 * The cause was a plausible line: `availableParallelism() - 1`. Inside a
 * container that counts the HOST's cores, so a service with half a CPU sized
 * its pool for a machine it could not use.
 */

import { describe, expect, it } from 'vitest';

const { cacheBytesFor, poolSizeFor } = await import('../../src/config/env.js');

const MB = 1024 * 1024;
const WORKER = 220 * MB;

/** The instance the outage happened on, and two it might move to. */
const BOXES = [
  { name: 'render starter, 512 MB, host reports 8 cores', bytes: 512 * MB, cores: 8 },
  { name: 'standard, 2 GB', bytes: 2048 * MB, cores: 8 },
  { name: 'pro, 4 GB', bytes: 4096 * MB, cores: 16 },
];

describe('the pool is sized by what the box has', () => {
  for (const box of BOXES) {
    it(`fits on ${box.name}`, () => {
      const size = poolSizeFor(box.bytes, box.cores);
      const cache = cacheBytesFor(box.bytes);

      expect(size).toBeGreaterThanOrEqual(1);
      // Workers plus cache, with the parent process and the OS still to pay
      // for. Running out here is not a slowdown: it is the kernel choosing
      // which process dies, which is what `exited with code null` was.
      expect(size * WORKER + cache).toBeLessThan(box.bytes);
    });
  }

  it('gives the 512 MB instance one worker, not four', () => {
    // The number that was deployed. `availableParallelism()` counts the HOST's
    // cores inside a container, so half a CPU asked for four workers.
    expect(poolSizeFor(512 * MB, 8)).toBe(1);
  });

  it('still lets a real machine have more than one', () => {
    // The cap must come from memory, not be a blanket "always one".
    expect(poolSizeFor(4096 * MB, 16)).toBe(4);
  });

  it('never lets the cache take a quarter of the box', () => {
    for (const box of BOXES) {
      expect(cacheBytesFor(box.bytes)).toBeLessThan(box.bytes / 4);
    }
  });
});
