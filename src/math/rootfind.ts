/**
 * Root finding on a bracketed interval.
 *
 * This replaces the prototype's two search routines, both in
 * full-transit-calculator.js:
 *
 *   refineCrossingDate (:111-152) — 15 bisection steps, stopping at a
 *   one-hour tolerance, on an UNSIGNED orb. An unsigned function has no sign
 *   change to bracket, so it had to guess the direction from two samples.
 *
 *   refineExactDate (:162-198) — a 20-iteration ternary search for a minimum,
 *   two evaluations per iteration, also stopping at an hour. It silently
 *   returned the window centre when the minimum lay outside a +/-5 day window.
 *
 * The fix upstream is signedSeparation: a function that changes sign through
 * the contact turns "find the minimum of |f|" into "find the zero of f", which
 * is a far easier and better-conditioned problem.
 *
 * Brent's method: inverse quadratic interpolation where it behaves, bisection
 * where it does not. Superlinear on smooth functions, and it cannot fail to
 * converge on a valid bracket — unlike a bare secant method.
 */

export interface RootResult {
  /** The root. */
  readonly x: number;
  /** Function evaluations spent. Tracked because ephemeris calls are the cost. */
  readonly evaluations: number;
  /** Half-width of the final bracket — the honest uncertainty. */
  readonly precision: number;
}

export class BracketError extends Error {
  constructor(a: number, b: number, fa: number, fb: number) {
    super(
      `f(${String(a)}) = ${String(fa)} and f(${String(b)}) = ${String(fb)} have the same sign; ` +
        `no root is bracketed.`,
    );
    this.name = 'BracketError';
  }
}

/**
 * Find x in [a, b] where f(x) = 0, given that f(a) and f(b) differ in sign.
 *
 * `tolerance` is in the units of x. For transit work x is a Julian Day, so
 * 1e-6 days is about 0.086 seconds — well past what the ephemeris itself
 * warrants, and reached in four to six evaluations rather than the prototype's
 * fifteen-to-fifty.
 */
export interface BrentOptions {
  /** In the units of x. For transit work, days: 1e-6 is 0.086 seconds. */
  readonly tolerance?: number;
  readonly maxEvaluations?: number;
}

/**
 * The next estimate: inverse quadratic interpolation through three distinct
 * points, falling back to the secant when two of the function values coincide
 * and the quadratic would divide by zero.
 */
function interpolate(state: {
  lo: number;
  hi: number;
  prev: number;
  fLo: number;
  fHi: number;
  fPrev: number;
}): number {
  const { lo, hi, prev, fLo, fHi, fPrev } = state;

  if (fLo !== fPrev && fHi !== fPrev) {
    return (
      (lo * fHi * fPrev) / ((fLo - fHi) * (fLo - fPrev)) +
      (hi * fLo * fPrev) / ((fHi - fLo) * (fHi - fPrev)) +
      (prev * fLo * fHi) / ((fPrev - fLo) * (fPrev - fHi))
    );
  }

  return hi - (fHi * (hi - lo)) / (fHi - fLo);
}

/**
 * Brent's acceptance test: take the interpolated step only when it is clearly
 * better than bisection. These five conditions ARE the algorithm — they are
 * what turns a fast-but-fragile secant method into one that cannot fail to
 * converge on a valid bracket.
 */
function shouldBisect(state: {
  candidate: number;
  lo: number;
  hi: number;
  prev: number;
  older: number;
  usedBisection: boolean;
  tolerance: number;
}): boolean {
  const { candidate, lo, hi, prev, older, usedBisection, tolerance } = state;

  const bound = (3 * lo + hi) / 4;
  const outsideBracket = !(
    (candidate > bound && candidate < hi) ||
    (candidate < bound && candidate > hi)
  );
  const slowProgress = usedBisection
    ? Math.abs(candidate - hi) >= Math.abs(hi - prev) / 2
    : Math.abs(candidate - hi) >= Math.abs(prev - older) / 2;
  const tinyStep = usedBisection
    ? Math.abs(hi - prev) < tolerance
    : Math.abs(prev - older) < tolerance;

  return outsideBracket || slowProgress || tinyStep;
}

/*
 * eslint-disable-next-line complexity -- Brent's method has a canonical form,
 * and its branches ARE the algorithm: two guard returns, the bracket-ordering
 * swaps, the bisection fallback, the exact-root exit. Interpolation and the
 * acceptance test are already extracted above; splitting the remainder further
 * would scatter a well-known routine across helpers and make it harder to
 * check against the published reference, not easier.
 */
// eslint-disable-next-line complexity
export function brentRoot(
  f: (x: number) => number,
  a: number,
  b: number,
  options: BrentOptions = {},
): RootResult {
  const tolerance = options.tolerance ?? 1e-6;
  const maxEvaluations = options.maxEvaluations ?? 60;
  let evaluations = 0;
  const evaluate = (x: number): number => {
    evaluations += 1;
    return f(x);
  };

  let lo = a;
  let hi = b;
  let fLo = evaluate(lo);
  let fHi = evaluate(hi);

  if (fLo === 0) return { x: lo, evaluations, precision: 0 };
  if (fHi === 0) return { x: hi, evaluations, precision: 0 };
  if (Math.sign(fLo) === Math.sign(fHi)) throw new BracketError(a, b, fLo, fHi);

  // Keep |f(hi)| the smaller of the two: hi is the running best estimate.
  if (Math.abs(fLo) < Math.abs(fHi)) {
    [lo, hi] = [hi, lo];
    [fLo, fHi] = [fHi, fLo];
  }

  let prev = lo;
  let fPrev = fLo;
  let older = prev;
  let usedBisection = true;

  while (evaluations < maxEvaluations) {
    if (Math.abs(hi - lo) <= tolerance) break;

    let candidate = interpolate({ lo, hi, prev, fLo, fHi, fPrev });

    if (shouldBisect({ candidate, lo, hi, prev, older, usedBisection, tolerance })) {
      candidate = (lo + hi) / 2;
      usedBisection = true;
    } else {
      usedBisection = false;
    }

    const fCandidate = evaluate(candidate);

    // Landing exactly on the root is not rare here: a linear approach to an
    // aspect contact hits it on the first secant step. Without this the
    // bracket never shrinks past that point — one endpoint stops moving — and
    // the loop grinds to maxEvaluations re-evaluating the answer it already
    // has. Measured: 22 evaluations for f(x) = x - 0.5 before this check.
    if (fCandidate === 0) {
      return { x: candidate, evaluations, precision: 0 };
    }

    older = prev;
    prev = hi;
    fPrev = fHi;

    if (Math.sign(fLo) === Math.sign(fCandidate)) {
      lo = candidate;
      fLo = fCandidate;
    } else {
      hi = candidate;
      fHi = fCandidate;
    }

    if (Math.abs(fLo) < Math.abs(fHi)) {
      [lo, hi] = [hi, lo];
      [fLo, fHi] = [fHi, fLo];
    }
  }

  return { x: hi, evaluations, precision: Math.abs(hi - lo) / 2 };
}
