/**
 * Planetary returns, and the vocabulary of the life phases they mark.
 *
 * A return is a body meeting its own natal position again. Unlike the
 * funnel's transits, this is not noise-reduced by a story: it happens on its
 * own schedule regardless of what else the chart is doing, which is exactly
 * why astrology treats it as a separate class of event from a transit — a
 * beat of biographical time rather than a resonance between two things.
 *
 * Four bodies carry named phases here, because their cycles sit on a
 * timescale a human life actually crosses: Saturn's ~29.5 years fits inside a
 * lifetime several times over; Uranus, Chiron and Pluto's cycles are long
 * enough that even one crossing is a landmark. The square and opposition
 * along the way — waxing before the return, waning after it for a body's
 * SECOND cycle, or simply the far side for a body whose return itself is out
 * of reach — carry the same weight in the literature as the return itself.
 * `layer1.cyclic` (src/domain/orb-policy.ts) is the exact orb table the
 * prototype used for this: conjunction, opposition, square, no trine — a
 * return in transit, not a story.
 *
 * What is NOT here, deliberately: Jupiter (whose ~12-year return repeats too
 * often to mark a single life phase) and Neptune (whose ~165-year cycle
 * completes no leg of interest inside a human lifetime that Uranus and Pluto
 * do not already cover). Both are still fully computable — `returns.ts`
 * accepts any body — they simply have no named phase attached, which is
 * honest: a label invented for them would not rest on the same convention
 * these four do.
 *
 * The instants themselves are never read off a table. They are found by
 * root-finding against the real ephemeris (see resonance.ts), because Chiron
 * and especially Pluto have markedly eccentric orbits — the true age at
 * square or opposition depends on where in the orbit a person's own natal
 * position happens to sit, sometimes by a decade. The ages below are the
 * conventional reference every introductory text quotes, given so a client
 * can sanity-check a result, not so it can skip computing one.
 */

import type { AspectId } from './orb-policy.js';
import type { BodyId } from '../ephemeris/bodies.js';

export interface LifePhase {
  readonly id: string;
  readonly title: string;
  /** One line: the conventional reading, including the reference age range. */
  readonly note: string;
}

const SATURN_PHASES: Readonly<Record<string, LifePhase>> = {
  'conjunction:1': {
    id: 'saturn.return',
    title: 'Saturn Return',
    note: 'The archetype completes its first circuit. Conventionally ~29-30 years; repeats every ~29.5 years after.',
  },
  'opposition:1': {
    id: 'saturn.opposition',
    title: 'Saturn Opposition',
    note: 'The structure built since birth is tested from the outside. Conventionally ~14-15 years.',
  },
  'square:1': {
    id: 'saturn.square.waxing',
    title: 'Saturn Square (waxing)',
    note: 'The first structural test, before any return has happened. Conventionally ~7 years.',
  },
  'square:-1': {
    id: 'saturn.square.waning',
    title: 'Saturn Square (waning)',
    note: "The cycle's final test before it closes. Conventionally ~21-22 years.",
  },
};

const URANUS_PHASES: Readonly<Record<string, LifePhase>> = {
  'conjunction:1': {
    id: 'uranus.return',
    title: 'Uranus Return',
    note: 'Conventionally ~84 years — reached late in life, if at all.',
  },
  'opposition:1': {
    id: 'uranus.opposition',
    title: 'Uranus Opposition',
    note: "Astrology's most cited midlife marker. Conventionally ~40-42 years.",
  },
  'square:1': {
    id: 'uranus.square.waxing',
    title: 'Uranus Square (waxing)',
    note: 'Conventionally ~20-21 years — the upheaval of early adulthood.',
  },
  'square:-1': {
    id: 'uranus.square.waning',
    title: 'Uranus Square (waning)',
    note: 'Conventionally ~63 years.',
  },
};

const CHIRON_PHASES: Readonly<Record<string, LifePhase>> = {
  'conjunction:1': {
    id: 'chiron.return',
    title: 'Chiron Return',
    note: "Conventionally ~50 years. Chiron's orbit is markedly eccentric, so the true instant depends heavily on natal position rather than a fixed age.",
  },
  'opposition:1': {
    id: 'chiron.opposition',
    title: 'Chiron Opposition',
    note: 'Conventionally ~25 years, with the same eccentricity caveat as the return.',
  },
  'square:1': {
    id: 'chiron.square.waxing',
    title: 'Chiron Square (waxing)',
    note: 'Timing varies more than for Saturn or Uranus, for the same orbital reason.',
  },
  'square:-1': {
    id: 'chiron.square.waning',
    title: 'Chiron Square (waning)',
    note: 'Timing varies more than for Saturn or Uranus, for the same orbital reason.',
  },
};

const PLUTO_PHASES: Readonly<Record<string, LifePhase>> = {
  'conjunction:1': {
    id: 'pluto.return',
    title: 'Pluto Return',
    note: 'Conventionally ~248 years — not reached within a human lifetime.',
  },
  'opposition:1': {
    id: 'pluto.opposition',
    title: 'Pluto Opposition',
    note: 'Conventionally ~124 years — not reached within a human lifetime.',
  },
  'square:1': {
    id: 'pluto.square.waxing',
    title: 'Pluto Square (waxing)',
    note: "Pluto's orbit is the most eccentric of the four: this falls anywhere from the mid-30s to past 40 depending on generation, far more than a single reference age can capture.",
  },
  'square:-1': {
    id: 'pluto.square.waning',
    title: 'Pluto Square (waning)',
    note: "Pluto's orbit is the most eccentric of the four: timing depends heavily on natal position.",
  },
};

/** The bodies with a named vocabulary of life phases. */
export const LIFE_PHASE_BODIES = ['saturn', 'uranus', 'chiron', 'pluto'] as const;

export type LifePhaseBodyId = (typeof LIFE_PHASE_BODIES)[number];

export function hasLifePhases(body: BodyId): body is LifePhaseBodyId {
  return (LIFE_PHASE_BODIES as readonly BodyId[]).includes(body);
}

const PHASES_BY_BODY: Readonly<Record<LifePhaseBodyId, Readonly<Record<string, LifePhase>>>> = {
  saturn: SATURN_PHASES,
  uranus: URANUS_PHASES,
  chiron: CHIRON_PHASES,
  pluto: PLUTO_PHASES,
};

/**
 * The named phase for a contact, or undefined if this body carries no
 * vocabulary (any body other than the four above) or this aspect is not part
 * of the cyclic set (a trine, say, computed because a caller asked for one).
 */
export function lifePhaseFor(body: BodyId, aspect: AspectId, side: 1 | -1): LifePhase | undefined {
  if (!hasLifePhases(body)) return undefined;
  return PHASES_BY_BODY[body][`${aspect}:${String(side)}`];
}

/**
 * The whole vocabulary, for /v1/meta. A client rendering a timeline needs the
 * full list of what CAN happen — including the phases this particular chart
 * never reaches — not only the labels attached to computed events.
 */
export function lifePhaseCatalogue(): {
  body: LifePhaseBodyId;
  phases: (LifePhase & { aspect: string; side: 1 | -1 })[];
}[] {
  return LIFE_PHASE_BODIES.map((body) => ({
    body,
    phases: Object.entries(PHASES_BY_BODY[body]).map(([key, phase]) => {
      const [aspect = '', side = '1'] = key.split(':');
      return { ...phase, aspect, side: side === '-1' ? -1 : 1 };
    }),
  }));
}
