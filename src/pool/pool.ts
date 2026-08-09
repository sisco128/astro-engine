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
}

interface Worker {
  readonly child: ChildProcess;
  ready: boolean;
  busy: Pending | undefined;
  timer: NodeJS.Timeout | undefined;
}

export interface PoolOptions {
  readonly size?: number;
  readonly taskTimeoutMs?: number;
  /** Queue depth before new work is refused rather than queued indefinitely. */
  readonly maxQueueDepth?: number;
  readonly workerPath?: string;
}

export class ComputePool {
  private readonly workers: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly size: number;
  private readonly taskTimeoutMs: number;
  private readonly maxQueueDepth: number;
  private readonly workerPath: string;
  private readonly typescript: boolean;
  private closing = false;
  /** Crashes in the last minute. Enough of them and the pool stops respawning. */
  private recentCrashes: number[] = [];

  constructor(options: PoolOptions = {}) {
    this.size = options.size ?? env.poolSize;
    this.taskTimeoutMs = options.taskTimeoutMs ?? env.poolTaskTimeoutMs;
    this.maxQueueDepth = options.maxQueueDepth ?? this.size * 4;
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

    const worker: Worker = { child, ready: false, busy: undefined, timer: undefined };
    this.workers.push(worker);

    child.on('message', (message: WorkerResponse) => {
      this.onMessage(worker, message);
    });

    child.on('exit', (code) => {
      this.onExit(worker, code);
    });
  }

  private onMessage(worker: Worker, message: WorkerResponse): void {
    if (message.kind === 'ready') {
      worker.ready = true;
      this.drain();
      return;
    }

    const pending = worker.busy;
    if (pending?.task.id !== message.id) return;

    if (worker.timer !== undefined) clearTimeout(worker.timer);
    worker.timer = undefined;
    worker.busy = undefined;

    if (message.kind === 'result') pending.resolve(message.payload);
    else pending.reject(new PoolError(message.code, message.message));

    this.drain();
  }

  private onExit(worker: Worker, code: number | null): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);

    if (worker.timer !== undefined) clearTimeout(worker.timer);
    worker.busy?.reject(
      new PoolError('COMPUTE_WORKER_LOST', `Worker exited with code ${String(code)} mid-task`),
    );

    if (this.closing) return;

    // Circuit-break rather than respawn-loop. A worker that cannot start —
    // a missing ephemeris, a broken binding — would otherwise burn CPU
    // restarting forever while every request times out.
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((at) => now - at < 60_000);
    this.recentCrashes.push(now);

    if (this.recentCrashes.length > 5) {
      process.stderr.write('pool: more than five worker crashes in a minute; not respawning\n');
      return;
    }

    this.spawn();
  }

  private drain(): void {
    for (const worker of this.workers) {
      if (!worker.ready || worker.busy !== undefined) continue;

      const next = this.queue.shift();
      if (next === undefined) return;

      worker.busy = next;
      worker.timer = setTimeout(() => {
        // SIGKILL, not SIGTERM: the worker is inside synchronous C and cannot
        // observe a signal handler. The exit handler rejects and respawns.
        worker.child.kill('SIGKILL');
      }, this.taskTimeoutMs);

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

  run<T>(task: Omit<WorkerRequest, 'id'>): Promise<T> {
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
      this.queue.push({
        task: { ...task, id: randomUUID() },
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  async close(): Promise<void> {
    this.closing = true;

    for (const pending of this.queue.splice(0)) {
      pending.reject(new PoolError('COMPUTE_UNAVAILABLE', 'The pool is shutting down'));
    }

    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            if (worker.timer !== undefined) clearTimeout(worker.timer);
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
