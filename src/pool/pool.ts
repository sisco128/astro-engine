/**
 * A pool of compute processes.
 *
 * Every Swiss Ephemeris call is synchronous C. The "callbacks" the old binding
 * offered were never asynchronous either — it invoked them inline. So without
 * a pool, one key-dates request blocks the event loop for its whole duration
 * and every other request, including health checks, queues behind it.
 *
 * Processes rather than worker_threads: see the note in worker.ts. The library
 * keeps its state in a process-global struct, and this project has three
 * recorded instances of that state producing plausible wrong answers.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * A task as callers submit it — the pool assigns the id. Distributive on
 * purpose: plain `Omit` over a union keeps only the common keys, which would
 * strip every kind-specific field from both task types at once.
 */
export type PoolTask = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'id'>
    : never
  : never;

export class PoolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
  }
}

interface Pending {
  readonly task: WorkerRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  /**
   * Started at enqueue, not at assignment — see `run`. Cleared by `settle`,
   * which is also what guarantees a task is answered exactly once.
   */
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
}

interface Worker {
  readonly child: ChildProcess;
  ready: boolean;
  busy: Pending | undefined;
}

export interface PoolOptions {
  readonly size?: number;
  readonly taskTimeoutMs?: number;
  /** Queue depth before new work is refused rather than queued indefinitely. */
  readonly maxQueueDepth?: number;
  /**
   * How long the pool stays down after too many crashes before trying to
   * start a worker again. See `giveUp`.
   */
  readonly recoveryMs?: number;
  readonly workerPath?: string;
}

export class ComputePool {
  private readonly workers: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly size: number;
  private readonly taskTimeoutMs: number;
  private readonly maxQueueDepth: number;
  private readonly recoveryMs: number;
  private readonly workerPath: string;
  private readonly typescript: boolean;
  private closing = false;
  /** Crashes in the last minute. Enough of them and the pool stops respawning. */
  private recentCrashes: number[] = [];
  /** Set while the pool is down after `giveUp`, cleared when it tries again. */
  private recovery: NodeJS.Timeout | undefined;

  constructor(options: PoolOptions = {}) {
    this.size = options.size ?? env.poolSize;
    this.taskTimeoutMs = options.taskTimeoutMs ?? env.poolTaskTimeoutMs;
    this.maxQueueDepth = options.maxQueueDepth ?? this.size * 4;
    this.recoveryMs = options.recoveryMs ?? 30_000;
    // In development and under the test runner the modules are still
    // TypeScript and there is no build output to fork.
    this.typescript = import.meta.url.endsWith('.ts');
    const extension = this.typescript ? 'ts' : 'js';
    this.workerPath =
      options.workerPath ?? fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

    for (let i = 0; i < this.size; i += 1) this.spawn();
  }

  private spawn(): void {
    if (this.closing) return;

    const child = fork(this.workerPath, [], {
      // Passing the whole parent environment down is the point, and it is why
      // this one line reaches process.env directly rather than going through
      // config/env.ts. The Swiss Ephemeris C library reads SE_EPHE_PATH by
      // itself, independently of set_ephe_path — a fact this project learned
      // when an inherited value silently rescued a deliberately broken path in
      // a test. Reconstructing the child's environment from parsed config
      // would drop exactly the variable that has to survive.
      // eslint-disable-next-line no-restricted-properties
      env: process.env,
      serialization: 'advanced',
      // A forked child is a plain Node process and cannot run TypeScript on
      // its own. Inheriting execArgv is not enough under the test runner,
      // which transforms modules in-process and passes no loader down, so the
      // loader is named explicitly whenever the worker is still .ts.
      ...(this.typescript ? { execArgv: ['--import', 'tsx'] } : {}),
    });

    const worker: Worker = { child, ready: false, busy: undefined };
    this.workers.push(worker);

    child.on('message', (message: WorkerResponse) => {
      this.onMessage(worker, message);
    });

    child.on('exit', (code) => {
      this.onExit(worker, code);
    });
  }

  /**
   * Answer a task exactly once, and stop its clock.
   *
   * Every path that finishes a task goes through here. The `settled` guard is
   * not defensive tidiness: a task that expires while running is answered by
   * its own timer AND, a moment later, by the exit of the worker that timer
   * killed, and the second one must not throw away the first answer.
   */
  private settle(pending: Pending, answer: () => void): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    answer();
  }

  private onMessage(worker: Worker, message: WorkerResponse): void {
    if (message.kind === 'ready') {
      worker.ready = true;
      this.drain();
      return;
    }

    const pending = worker.busy;
    if (pending?.task.id !== message.id) return;

    worker.busy = undefined;

    this.settle(pending, () => {
      if (message.kind === 'result') pending.resolve(message.payload);
      else pending.reject(new PoolError(message.code, message.message));
    });

    this.drain();
  }

  private onExit(worker: Worker, code: number | null): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);

    const pending = worker.busy;
    worker.busy = undefined;
    if (pending !== undefined) {
      this.settle(pending, () => {
        pending.reject(
          new PoolError('COMPUTE_WORKER_LOST', `Worker exited with code ${String(code)} mid-task`),
        );
      });
    }

    if (this.closing) return;

    // Circuit-break rather than respawn-loop. A worker that cannot start —
    // a missing ephemeris, a broken binding — would otherwise burn CPU
    // restarting forever while every request times out.
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((at) => now - at < 60_000);
    this.recentCrashes.push(now);

    if (this.recentCrashes.length > 5) {
      this.giveUp();
      return;
    }

    this.spawn();
  }

  /**
   * Stop respawning — but answer everyone waiting, and try again later.
   *
   * The first version of this circuit breaker returned here and did nothing
   * else, which made it the most complete way to fail the service had: the
   * queue it left behind held promises that nothing would ever settle, and
   * because respawning only happens on a worker's exit, a pool with no
   * workers left had no event that could ever bring one back. It stayed dead
   * until someone redeployed, and every caller in the queue waited for a
   * timeout of its own rather than being told.
   */
  private giveUp(): void {
    process.stderr.write(
      `pool: more than five worker crashes in a minute; pausing for ${String(this.recoveryMs)}ms\n`,
    );

    for (const pending of this.queue.splice(0)) {
      this.settle(pending, () => {
        pending.reject(
          new PoolError('COMPUTE_UNAVAILABLE', 'No compute workers are running; the pool is down'),
        );
      });
    }

    if (this.recovery !== undefined) return;
    this.recovery = setTimeout(() => {
      this.recovery = undefined;
      // A fresh minute. Whatever killed the last five is either gone or about
      // to spend another five crashes proving it is not.
      this.recentCrashes = [];
      for (let i = 0; i < this.size; i += 1) this.spawn();
    }, this.recoveryMs);
    // Nothing here should hold the process open.
    this.recovery.unref();
  }

  private drain(): void {
    for (const worker of this.workers) {
      if (!worker.ready || worker.busy !== undefined) continue;

      const next = this.queue.shift();
      if (next === undefined) return;

      worker.busy = next;
      worker.child.send(next.task);
    }
  }

  /** Whether any worker has finished starting. */
  get ready(): boolean {
    return this.workers.some((worker) => worker.ready);
  }

  /**
   * Resolves once a worker is able to accept work, or rejects on timeout.
   *
   * Worker startup is asynchronous — each one forks, initialises its own
   * ephemeris and reports back over IPC — so a pool constructed a moment ago
   * is legitimately not ready yet. /v1/ready reflects that and returns 503,
   * which is the correct answer rather than a race to paper over. This exists
   * for callers that want to wait for it: a startup gate, or a test.
   */
  async whenReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!this.ready) {
      if (this.closing) throw new PoolError('COMPUTE_UNAVAILABLE', 'The pool is shutting down');
      if (Date.now() > deadline) {
        throw new PoolError(
          'COMPUTE_UNAVAILABLE',
          `No worker became ready within ${String(timeoutMs)}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  get depth(): number {
    return this.queue.length;
  }

  run<T>(task: PoolTask): Promise<T> {
    if (this.closing) {
      return Promise.reject(new PoolError('COMPUTE_UNAVAILABLE', 'The pool is shutting down'));
    }
    if (this.workers.length === 0) {
      return Promise.reject(new PoolError('COMPUTE_UNAVAILABLE', 'No compute workers are running'));
    }
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(
        new PoolError(
          'COMPUTE_OVERLOADED',
          `The compute queue is full (${String(this.maxQueueDepth)} waiting)`,
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        task: { ...task, id: randomUUID() },
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
        settled: false,
      };

      /**
       * The clock starts here, at the back of the queue — not in `drain` when
       * a worker finally picks the task up.
       *
       * Timing only the compute is timing the part the caller cannot see. On
       * 13 August the deployed pool killed its workers at exactly 60s of
       * compute each, and key-dates requests still took 101, 119 and 162
       * seconds, because every one of those had spent a minute or two waiting
       * in this queue first — unwatched, on nobody's clock. The caller's own
       * deadline was 60 seconds. It had been gone for a minute and a half by
       * the time the pool started working on its request, and nothing here
       * knew that or could have known it.
       */
      pending.timer = setTimeout(() => {
        const worker = this.workers.find((candidate) => candidate.busy === pending);

        if (worker === undefined) {
          const index = this.queue.indexOf(pending);
          if (index >= 0) this.queue.splice(index, 1);
          this.settle(pending, () => {
            pending.reject(
              new PoolError(
                'COMPUTE_OVERLOADED',
                `Waited ${String(this.taskTimeoutMs)}ms in the compute queue without reaching a worker`,
              ),
            );
          });
          return;
        }

        // SIGKILL, not SIGTERM: the worker is inside synchronous C and cannot
        // observe a signal handler. Clearing `busy` first means the exit this
        // provokes respawns without trying to answer a task already answered.
        worker.busy = undefined;
        worker.child.kill('SIGKILL');
        this.settle(pending, () => {
          pending.reject(
            new PoolError(
              'COMPUTE_WORKER_LOST',
              `Worker killed after ${String(this.taskTimeoutMs)}ms: the task did not finish in time`,
            ),
          );
        });
      }, this.taskTimeoutMs);

      this.queue.push(pending);
      this.drain();
    });
  }

  async close(): Promise<void> {
    this.closing = true;

    if (this.recovery !== undefined) {
      clearTimeout(this.recovery);
      this.recovery = undefined;
    }

    // Through settle, so the deadline each one is carrying is cleared with it.
    // A stray timer here outlives the pool and fires at a worker that is gone.
    for (const pending of this.queue.splice(0)) {
      this.settle(pending, () => {
        pending.reject(new PoolError('COMPUTE_UNAVAILABLE', 'The pool is shutting down'));
      });
    }

    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.child.once('exit', () => {
              resolve();
            });
            worker.child.kill('SIGTERM');
            // A worker inside synchronous C will not see SIGTERM; give it a
            // moment, then take it out.
            setTimeout(() => {
              worker.child.kill('SIGKILL');
              resolve();
            }, 2000).unref();
          }),
      ),
    );

    this.workers.length = 0;
  }
}
