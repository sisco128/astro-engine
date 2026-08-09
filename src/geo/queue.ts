/**
 * A serial queue with a minimum interval between task starts.
 *
 * This exists for policy compliance, not politeness. Nominatim's usage policy
 * caps clients at an absolute maximum of one request per second, and OSM
 * enforces it by blocking the source address rather than by returning a 429 a
 * client could back off from. Two concurrent requests from this process are
 * therefore not "a bit fast", they are the thing that gets the deployment cut
 * off — so the limit is enforced outbound, here, where every geocoding call
 * has to pass through it, instead of being left to whatever the callers happen
 * to do.
 *
 * Serial *and* spaced, because either alone is insufficient: serialising says
 * nothing about how fast two quick requests follow one another, and spacing
 * alone would let a slow request overlap the next one.
 *
 * The clock is injectable so the interval can be tested without waiting real
 * seconds for it. `Date.now()` is the right source in production despite being
 * wall-clock — the budget being enforced is a rate against the upstream's
 * wall-clock second.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      // unref'd: a pending inter-request gap is not a reason to keep the
      // process alive during shutdown.
      setTimeout(resolve, ms).unref();
    }),
};

/** Runs one task at a time, no two starting closer than `minIntervalMs`. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(options: {
  minIntervalMs: number;
  clock?: Clock | undefined;
}): SerialQueue {
  const clock = options.clock ?? systemClock;
  let tail: Promise<void> = Promise.resolve();
  // -Infinity rather than 0: the first task must not wait, whatever the epoch
  // happens to be when the process starts.
  let lastStart = Number.NEGATIVE_INFINITY;

  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      const wait = lastStart + options.minIntervalMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastStart = clock.now();
      return task();
    });

    // The chain continues through failures. Chaining `tail = result` directly
    // would make one rejected task reject every task queued behind it, which
    // is how a single upstream 500 would take the endpoint down for good.
    tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };
}
