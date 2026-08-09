/**
 * The messages a pool worker understands.
 *
 * Deliberately small and plain: everything crosses a process boundary by
 * structured clone, so nothing here may carry a class instance, a function or
 * a branded type that matters at runtime.
 */

import type { NatalPoint } from '../transits/funnel.js';
import type { BodyId } from '../ephemeris/bodies.js';
import type { FunnelConfig } from '../domain/timescales.js';
import type { Story } from '../domain/themes.js';

export interface FunnelTask {
  readonly kind: 'funnel';
  readonly id: string;
  readonly stories: readonly Story[];
  readonly natalPoints: readonly NatalPoint[];
  readonly fromJd: number;
  readonly toJd: number;
  readonly config: FunnelConfig;
}

export interface ReturnsTask {
  readonly kind: 'returns';
  readonly id: string;
  readonly bodies: readonly BodyId[];
  /** Natal longitudes as entries rather than a Map, keeping the message plain. */
  readonly natalLon: readonly (readonly [BodyId, number])[];
  readonly birthJd: number;
  readonly toJd: number;
}

export type WorkerRequest = FunnelTask | ReturnsTask;

export interface WorkerReady {
  readonly kind: 'ready';
  readonly seVersion: string;
}

export interface WorkerSuccess {
  readonly kind: 'result';
  readonly id: string;
  readonly payload: unknown;
  readonly computeMs: number;
}

export interface WorkerFailure {
  readonly kind: 'error';
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export type WorkerResponse = WorkerReady | WorkerSuccess | WorkerFailure;
