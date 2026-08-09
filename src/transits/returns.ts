/**
 * Planetary returns: a body against its own natal position, over a life.
 *
 * Structurally separate from the funnel on purpose. A key date is three
 * bodies converging on the same story; a return is one body completing its
 * own cycle, and it happens on schedule whether or not anything else in the
 * chart is doing anything at all. Nesting it inside the funnel's tiers would
 * force an independence into a dependency it does not have.
 *
 * The scan always starts at birth, never at the caller's `fromJd`. Which
 * repetition a return is — the first Saturn Return at ~29 reads as "arriving
 * at structure"; the second at ~58 reads as "what you do with it" — is part
 * of the vocabulary (src/domain/life-phases.ts) and can only be counted
 * correctly by walking forward from the actual beginning, not from wherever a
 * query happens to start looking.
 */

import type { AspectId, OrbPolicy } from '../domain/orb-policy.js';
import { ORB_POLICIES } from '../domain/orb-policy.js';
import { LIFE_PHASE_BODIES, lifePhaseFor, type LifePhase } from '../domain/life-phases.js';
import type { BodyId } from '../ephemeris/bodies.js';
import type { JulianDayUT } from '../ephemeris/swe.js';
import { contactsFor, type Contact } from './resonance.js';

/** The four bodies whose returns carry a named phase. Any body can be requested. */
export const RETURN_BODIES: readonly BodyId[] = LIFE_PHASE_BODIES;

/**
 * Multiple exact contacts inside one retrograde loop are one life event, not
 * several. A Saturn Return crosses the exact degree two or three times over
 * several months as Saturn stations and reverses within orb — measured on the
 * reference chart (12 Aug 1987), the widest such spread was Pluto's square at
 * 0.86 years (314 days) across four passes. Consecutive passes closer
 * together than this are folded into one occurrence.
 *
 * The threshold has a wide margin on both sides: over twice the widest
 * observed spread, and still more than five times short of the tightest
 * REAL gap between two distinct occurrences — one full orbital period, at
 * minimum Saturn's 29.5 years. There is no ambiguous middle ground between
 * "still the same return" and "the next one", so getting the exact number
 * right matters less than staying inside that gap.
 */
const RETURN_CLUSTER_DAYS = 1825;

export interface ReturnPass {
  readonly exactJd: number;
  readonly precisionDays: number;
}

export interface PlanetaryReturn {
  readonly body: BodyId;
  readonly aspect: AspectId;
  readonly side: 1 | -1;
  /**
   * Which repetition of this (body, aspect, side) since birth: 1 for the
   * first Saturn Return, 2 for the second, and so on. Counts occurrences —
   * whole retrograde-loop windows — not individual exact passes.
   */
  readonly occurrence: number;
  /** First entry into orb, across every pass in this occurrence. */
  readonly enterJd: number;
  /** Last exit from orb, across every pass in this occurrence. */
  readonly exitJd: number;
  /**
   * The representative exact instant: the middle pass in time. Every pass is
   * equally exact by construction (zero separation), so "middle" is a
   * judgement about which one best represents the window, not a measurement —
   * recorded here rather than left implicit. A caller that wants a different
   * one has the whole list in `passes`.
   */
  readonly exactJd: number;
  readonly precisionDays: number;
  readonly durationDays: number;
  /** Every exact crossing in this occurrence, chronological. Length 1 unless Saturn/Uranus/Chiron/Pluto retrograded through orb. */
  readonly passes: readonly ReturnPass[];
  /** Absent for a body or aspect the vocabulary does not cover. */
  readonly phase: LifePhase | undefined;
}

export interface PlanetaryReturnsRequest {
  /** Defaults to RETURN_BODIES. The engine computes any body; the vocabulary only names four. */
  readonly bodies?: readonly BodyId[];
  /** Natal longitude for each requested body. A body missing here is silently skipped. */
  readonly natalLon: ReadonlyMap<BodyId, number>;
  readonly birthJd: JulianDayUT;
  readonly toJd: JulianDayUT;
  /**
   * Which aspects count, and at what orb. Defaults to `layer1.cyclic`
   * (conjunction, opposition, square, no trine — orb-policy.ts) — the
   * prototype's own table for exactly this, ported unchanged.
   */
  readonly policy?: OrbPolicy;
}

function clusterPasses(contacts: readonly Contact[]): {
  enterJd: number;
  exitJd: number;
  exactJd: number;
  precisionDays: number;
  passes: ReturnPass[];
}[] {
  const groups: Contact[][] = [];

  for (const contact of contacts) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (
      group !== undefined &&
      previous !== undefined &&
      contact.enterJd - previous.exitJd <= RETURN_CLUSTER_DAYS
    ) {
      group.push(contact);
    } else {
      groups.push([contact]);
    }
  }

  return groups.map((group) => {
    const passes = group.map((contact) => ({
      exactJd: contact.exactJd,
      precisionDays: contact.precisionDays,
    }));
    // Lower-middle pass by index — deterministic, and does not need an extra
    // ephemeris call to find the slowest (most-stationary) one.
    const middle = group[Math.floor((group.length - 1) / 2)];
    if (middle === undefined)
      throw new Error('unreachable: a cluster always has at least one pass');

    return {
      enterJd: Math.min(...group.map((contact) => contact.enterJd)),
      exitJd: Math.max(...group.map((contact) => contact.exitJd)),
      exactJd: middle.exactJd,
      precisionDays: middle.precisionDays,
      passes,
    };
  });
}

/** Every return, square and opposition for one body against its own natal position. */
function returnsForBody(input: {
  body: BodyId;
  natalLon: number;
  birthJd: JulianDayUT;
  toJd: JulianDayUT;
  policy: OrbPolicy;
}): PlanetaryReturn[] {
  const { body, natalLon, birthJd, toJd, policy } = input;

  const byKey = new Map<string, Contact[]>();
  for (const [aspect, orbDeg] of Object.entries(policy) as [AspectId, number][]) {
    const contacts = contactsFor({
      body,
      member: body,
      natalLon,
      fromJd: birthJd,
      toJd,
      options: { orbDeg, aspects: [aspect] },
    });
    for (const contact of contacts) {
      const key = `${contact.aspect}:${String(contact.side)}`;
      const list = byKey.get(key) ?? [];
      list.push(contact);
      byKey.set(key, list);
    }
  }

  const found: PlanetaryReturn[] = [];

  for (const contacts of byKey.values()) {
    contacts.sort((a, b) => a.exactJd - b.exactJd);
    // Every contact in this group shares one (aspect, side) — that is how
    // byKey grouped them — so the first one names the group. It always
    // exists: a group only appears in byKey because a contact was pushed
    // into it, but index access cannot see that.
    const first = contacts[0];
    if (first === undefined) continue;
    const { aspect, side } = first;

    // At the birth instant the transiting body IS the natal position, so a
    // conjunction scan starting exactly there finds itself already "in orb"
    // — of a return that has not happened, it is the natal placement being
    // mistaken for one. Only conjunction is affected: square and opposition
    // start 90 and 180 degrees from natal, never inside a one-degree orb of
    // themselves. Dropped AFTER clustering, not before, so a body that
    // wobbles back within orb again shortly after birth — plausible for
    // Chiron, whose motion is markedly irregular — has its whole lingering
    // absorbed into the one discarded window rather than resurfacing as a
    // false "occurrence 1" a few months in.
    const windows = clusterPasses(contacts).filter((window) => window.enterJd > birthJd);

    windows.forEach((window, index) => {
      found.push({
        body,
        aspect,
        side,
        occurrence: index + 1,
        enterJd: window.enterJd,
        exitJd: window.exitJd,
        exactJd: window.exactJd,
        precisionDays: window.precisionDays,
        durationDays: window.exitJd - window.enterJd,
        passes: window.passes,
        phase: lifePhaseFor(body, aspect, side),
      });
    });
  }

  found.sort((a, b) => a.exactJd - b.exactJd);
  return found;
}

export function planetaryReturns(request: PlanetaryReturnsRequest): PlanetaryReturn[] {
  const bodies = request.bodies ?? RETURN_BODIES;
  const policy = request.policy ?? ORB_POLICIES['layer1.cyclic'];
  const found: PlanetaryReturn[] = [];

  for (const body of bodies) {
    const lon = request.natalLon.get(body);
    if (lon === undefined) continue;

    found.push(
      ...returnsForBody({
        body,
        natalLon: lon,
        birthJd: request.birthJd,
        toJd: request.toJd,
        policy,
      }),
    );
  }

  found.sort((a, b) => a.exactJd - b.exactJd);
  return found;
}
