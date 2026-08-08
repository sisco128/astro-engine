/**
 * A resonance: one transiting body touching one natal point, as a real
 * interval in time rather than a day that happened to be sampled.
 *
 * What this replaces: the prototype sampled once per day at local noon
 * (transit-calculator.js:35-39) and asked "is the orb within 1 degree on this
 * sample?". An aspect is then either present or absent on a given day, its
 * "exact" moment is whichever noon happened to be closest, and the activation
 * window is a flat 30 days for every body.
 *
 * Here each contact carries:
 *   - the instant it enters orb, and the instant it leaves
 *   - the exact contact, found by root-finding to sub-second precision
 *   - a continuous intensity peaking at that contact
 *   - which pass it is, when a retrograde loop crosses the same degree more
 *     than once
 *
 * The scan step adapts to the body. The prototype used one day for Neptune
 * (five times finer than needed) and one day for the Moon (fifty times too
 * coarse, which is why it could not track the Moon at all).
 */

import { BODIES, type BodyId } from '../ephemeris/bodies.js';
import { bodyState, type JulianDayUT } from '../ephemeris/swe.js';
import { signedSeparation, wrap180 } from '../math/angle.js';
import { brentRoot } from '../math/rootfind.js';
import { ASPECTS, type AspectId } from '../domain/orb-policy.js';
import { orbFalloff } from '../domain/scoring-v2.js';
import type { TierId } from '../domain/timescales.js';

export interface Resonance {
  readonly body: BodyId;
  readonly tier: TierId;
  /** The natal point touched. */
  readonly member: string;
  readonly aspect: AspectId;
  /**
   * Which of the two contacts of a non-symmetric aspect. A square meets a
   * natal point at +90 and at -90; the prototype's unsigned distance merged
   * them into one blob.
   */
  readonly side: 1 | -1;
  readonly enterJd: number;
  readonly exitJd: number;
  /** Exact contact, to the tolerance root-finding achieved. */
  readonly exactJd: number;
  /** Honest uncertainty on `exactJd`, in days. */
  readonly precisionDays: number;
  /** Peak intensity, always 1 at the exact contact. Present for symmetry. */
  readonly intensityAtPeak: number;
  readonly durationDays: number;
}

export interface ResonanceOptions {
  readonly orbDeg: number;
  readonly aspects: readonly AspectId[];
  readonly tier: TierId;
  /** Root-finding tolerance in days. 1e-6 is about 0.086 seconds. */
  readonly toleranceDays?: number;
}

/**
 * Scan step, from the body's own maximum speed.
 *
 * Nyquist-style: never advance more than 40% of the orb width, so a contact
 * cannot be stepped over. For a 1-degree orb this gives Mars 0.7 days and
 * Neptune 20 days, against the prototype's flat 1 day for both.
 */
export function scanStepDays(body: BodyId, orbDeg: number): number {
  const speed = BODIES[body].maxSpeedDegPerDay;
  const ideal = (0.4 * orbDeg) / speed;
  // Bounded so a very slow body does not stride past a retrograde loop, and a
  // very fast one does not produce a pointlessly fine grid.
  return Math.min(Math.max(ideal, 0.02), 10);
}

/** Intensity of a contact at a given separation from exact. Peaks at 1. */
export function intensityAt(orb: number, maxOrb: number): number {
  return orbFalloff(Math.abs(orb), maxOrb);
}

/**
 * Every resonance of one body against one natal longitude, over a window.
 *
 * Both contacts of a non-symmetric aspect are scanned separately. The
 * conjunction and opposition are symmetric and have one side each; scanning
 * both would double-count them.
 */
export interface ResonanceRequest {
  readonly body: BodyId;
  readonly member: string;
  readonly natalLon: number;
  readonly fromJd: JulianDayUT;
  readonly toJd: JulianDayUT;
  readonly options: ResonanceOptions;
}

/** One aspect, one side: scan for orb intervals and their exact contacts. */
function scanSide(request: ResonanceRequest, aspect: AspectId, side: 1 | -1): Resonance[] {
  const { body, member, natalLon, fromJd, toJd, options } = request;
  const tolerance = options.toleranceDays ?? 1e-6;
  const step = scanStepDays(body, options.orbDeg);
  const angle = ASPECTS[aspect].angle;
  const found: Resonance[] = [];

  const lonAt = (jd: number): number => bodyState(jd as JulianDayUT, body).lon;
  // Signed distance from the contact. Zero exactly at it; changes sign
  // through it, which is what makes root-finding possible.
  const f = (jd: number): number => signedSeparation(lonAt(jd), natalLon, angle, side);
  // Distance from the orb boundary. Negative inside orb.
  const g = (jd: number): number => Math.abs(f(jd)) - options.orbDeg;

  const close = (enterJd: number, exitJd: number): void => {
    const contact = findExactContact(f, enterJd, exitJd, tolerance);
    if (contact !== undefined) {
      found.push(buildResonance({ body, member, aspect, side, enterJd, exitJd, contact, options }));
    }
  };

  let previousJd: number = fromJd;
  let previousG = g(previousJd);
  let enterJd: number | undefined = previousG <= 0 ? fromJd : undefined;

  for (let jd = fromJd + step; jd <= toJd; jd += step) {
    const currentG = g(jd);

    if (previousG > 0 && currentG <= 0) {
      enterJd = brentRoot(g, previousJd, jd, { tolerance }).x;
    } else if (previousG <= 0 && currentG > 0 && enterJd !== undefined) {
      close(enterJd, brentRoot(g, previousJd, jd, { tolerance }).x);
      enterJd = undefined;
    }

    previousJd = jd;
    previousG = currentG;
  }

  // A contact still inside orb when the window ends.
  if (enterJd !== undefined) close(enterJd, toJd);

  return found;
}

export function resonancesFor(request: ResonanceRequest): Resonance[] {
  const found: Resonance[] = [];

  for (const aspect of request.options.aspects) {
    // Conjunction and opposition are symmetric and have one contact each;
    // scanning both sides would report every one of them twice.
    const sides: (1 | -1)[] = ASPECTS[aspect].symmetric ? [1] : [1, -1];
    for (const side of sides) found.push(...scanSide(request, aspect, side));
  }

  found.sort((a, b) => a.exactJd - b.exactJd);
  return found;
}

/**
 * The exact contact inside an orb interval.
 *
 * `f` changes sign through the contact, so this is a root find rather than the
 * prototype's ternary search for a minimum of an unsigned distance. Where the
 * body enters and leaves orb on the same side without crossing — a near miss,
 * possible when a station falls inside the window — there is no root, and the
 * closest approach is returned instead.
 */
function findExactContact(
  f: (jd: number) => number,
  enterJd: number,
  exitJd: number,
  tolerance: number,
): { jd: number; precision: number } | undefined {
  const fEnter = f(enterJd);
  const fExit = f(exitJd);

  if (Math.sign(fEnter) !== Math.sign(fExit)) {
    const root = brentRoot(f, enterJd, exitJd, { tolerance: tolerance });
    return { jd: root.x, precision: root.precision };
  }

  // No sign change: the body approached and withdrew without reaching exact.
  // Sample for the closest approach and report the coarse precision honestly
  // rather than pretending to a root that does not exist.
  const samples = 32;
  const width = exitJd - enterJd;
  let bestJd = enterJd;
  let best = Math.abs(fEnter);

  for (let i = 1; i <= samples; i += 1) {
    const jd = enterJd + (width * i) / samples;
    const value = Math.abs(f(jd));
    if (value < best) {
      best = value;
      bestJd = jd;
    }
  }

  return { jd: bestJd, precision: width / samples };
}

function buildResonance(input: {
  body: BodyId;
  member: string;
  aspect: AspectId;
  side: 1 | -1;
  enterJd: number;
  exitJd: number;
  contact: { jd: number; precision: number };
  options: ResonanceOptions;
}): Resonance {
  const { body, member, aspect, side, enterJd, exitJd, contact, options } = input;

  return {
    body,
    tier: options.tier,
    member,
    aspect,
    side,
    enterJd,
    exitJd,
    exactJd: contact.jd,
    precisionDays: contact.precision,
    intensityAtPeak: 1,
    durationDays: exitJd - enterJd,
  };
}

/** Intensity of a resonance at an arbitrary instant inside its window. */
export function intensityOfAt(
  resonance: Resonance,
  jd: number,
  natalLon: number,
  orbDeg: number,
): number {
  if (jd < resonance.enterJd || jd > resonance.exitJd) return 0;
  const lon = bodyState(jd as JulianDayUT, resonance.body).lon;
  const angle = ASPECTS[resonance.aspect].angle;
  const separation = wrap180(lon - natalLon - resonance.side * angle);
  return intensityAt(separation, orbDeg);
}
