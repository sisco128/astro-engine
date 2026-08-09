/**
 * Planetary returns against the real ephemeris, on the reference chart.
 *
 * The ages asserted here are MEASURED on 12 Aug 1987 Rome, not copied from
 * the conventional tables — and the two disagree in exactly the way the
 * vocabulary warns about. Chiron's first opposition lands at 13.8 years, not
 * the ~25 every introductory text quotes, because Chiron's orbit is markedly
 * eccentric and this natal position sits on the fast side of it. That gap is
 * the reason the engine root-finds against the ephemeris instead of shipping
 * a table of ages.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { ORB_POLICIES } from '../../src/domain/orb-policy.js';
import {
  bodyState,
  jdFromUtc,
  setEphemerisPath,
  setForbidFallback,
  type JulianDayUT,
} from '../../src/ephemeris/swe.js';
import {
  planetaryReturns,
  RETURN_BODIES,
  type PlanetaryReturn,
} from '../../src/transits/returns.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

const EPHE_PATH = useRepoEphemeris();

let natalJd: JulianDayUT;
let events: PlanetaryReturn[];

const ageOf = (event: PlanetaryReturn): number => (event.exactJd - natalJd) / 365.25;

function find(body: string, aspect: string, side: 1 | -1, occurrence: number): PlanetaryReturn {
  const found = events.find(
    (event) =>
      event.body === body &&
      event.aspect === aspect &&
      event.side === side &&
      event.occurrence === occurrence,
  );
  if (found === undefined) {
    throw new Error(
      `expected an event: ${body} ${aspect} side ${String(side)} occ ${String(occurrence)}`,
    );
  }
  return found;
}

beforeAll(() => {
  setEphemerisPath(EPHE_PATH);
  setForbidFallback(true);

  // 12 Aug 1987, 11:32 CEST Rome. One scan for the whole suite: a century of
  // four bodies costs about 1.2 seconds.
  natalJd = jdFromUtc({ year: 1987, month: 8, day: 12, hour: 9, minute: 32 });
  const natalLon = new Map(RETURN_BODIES.map((id) => [id, bodyState(natalJd, id).lon]));

  events = planetaryReturns({
    natalLon,
    birthJd: natalJd,
    toJd: (natalJd + 365.25 * 100) as JulianDayUT,
  });
});

describe('the milestones land where the ephemeris puts them', () => {
  it('finds the first Saturn Return near age 29', () => {
    const saturnReturn = find('saturn', 'conjunction', 1, 1);
    expect(ageOf(saturnReturn)).toBeGreaterThan(28);
    expect(ageOf(saturnReturn)).toBeLessThan(30);
  });

  it('finds the Uranus opposition — the midlife marker — in the early 40s', () => {
    const midlife = find('uranus', 'opposition', 1, 1);
    expect(ageOf(midlife)).toBeGreaterThan(40);
    expect(ageOf(midlife)).toBeLessThan(45);
  });

  it('finds the Chiron Return around 50', () => {
    const chironReturn = find('chiron', 'conjunction', 1, 1);
    expect(ageOf(chironReturn)).toBeGreaterThan(49);
    expect(ageOf(chironReturn)).toBeLessThan(52);
  });

  it('shows Chiron eccentricity: this opposition is a decade early', () => {
    // ~25 by convention; 13.8 measured. The table would have been wrong.
    const opposition = find('chiron', 'opposition', 1, 1);
    expect(ageOf(opposition)).toBeGreaterThan(13);
    expect(ageOf(opposition)).toBeLessThan(15);
  });

  it('finds a Pluto waxing square but no Pluto return in a century', () => {
    expect(find('pluto', 'square', 1, 1)).toBeDefined();
    expect(events.some((event) => event.body === 'pluto' && event.aspect === 'conjunction')).toBe(
      false,
    );
  });

  it('orders one Saturn cycle: waxing square, opposition, waning square, return', () => {
    const waxing = find('saturn', 'square', 1, 1);
    const opposition = find('saturn', 'opposition', 1, 1);
    const waning = find('saturn', 'square', -1, 1);
    const saturnReturn = find('saturn', 'conjunction', 1, 1);

    expect(ageOf(waxing)).toBeLessThan(ageOf(opposition));
    expect(ageOf(opposition)).toBeLessThan(ageOf(waning));
    expect(ageOf(waning)).toBeLessThan(ageOf(saturnReturn));
  });
});

describe('the natal self-coincidence is not a return', () => {
  it('reports no conjunction at birth', () => {
    // At the birth instant every body IS its natal position. A scan that
    // started there and did not filter would report four "returns" at age
    // zero. Squares and oppositions cannot fake this — they start 90 and 180
    // degrees away — so only conjunctions need the check.
    for (const event of events) {
      if (event.aspect === 'conjunction') {
        expect(event.enterJd).toBeGreaterThan(natalJd);
      }
    }
  });

  it('still counts the first real return as occurrence 1', () => {
    // The filter must remove the birth artefact, not renumber what follows.
    const first = events.find((event) => event.body === 'saturn' && event.aspect === 'conjunction');
    expect(first?.occurrence).toBe(1);
  });
});

describe('retrograde passes fold into one occurrence', () => {
  it('reports the first Saturn Return as one event with multiple passes', () => {
    // Saturn stationed and reversed through the natal degree: three exact
    // crossings over ~292 days. Lived, that is one Saturn Return — the
    // occurrence counter must say 1, 2, 3 for the RETURNS of a lifetime, not
    // for the wobbles of a single one.
    expect(find('saturn', 'conjunction', 1, 1).passes.length).toBeGreaterThan(1);
  });

  it('numbers the second Saturn Return occurrence 2, near age 58', () => {
    const second = find('saturn', 'conjunction', 1, 2);
    expect(ageOf(second)).toBeGreaterThan(57);
    expect(ageOf(second)).toBeLessThan(60);
  });

  it('keeps every pass inside its occurrence window, in order', () => {
    for (const event of events) {
      expect(event.passes.length).toBeGreaterThan(0);
      for (const pass of event.passes) {
        expect(pass.exactJd).toBeGreaterThanOrEqual(event.enterJd);
        expect(pass.exactJd).toBeLessThanOrEqual(event.exitJd);
      }
      const sorted = [...event.passes].sort((a, b) => a.exactJd - b.exactJd);
      expect(event.passes).toEqual(sorted);
      // The representative instant is one of the passes, not an average.
      expect(event.passes.some((pass) => pass.exactJd === event.exactJd)).toBe(true);
    }
  });

  it('separates occurrences by at least an orbital period, per body and aspect', () => {
    const byKey = new Map<string, PlanetaryReturn[]>();
    for (const event of events) {
      const key = `${event.body}:${event.aspect}:${String(event.side)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), event]);
    }

    for (const list of byKey.values()) {
      const sorted = [...list].sort((a, b) => a.exactJd - b.exactJd);
      for (let i = 1; i < sorted.length; i += 1) {
        const current = sorted[i];
        const previous = sorted[i - 1];
        if (current === undefined || previous === undefined) throw new Error('unreachable');
        const gapYears = (current.exactJd - previous.exactJd) / 365.25;
        // The shortest real gap in this set is Saturn's ~29.5-year period.
        expect(gapYears).toBeGreaterThan(20);
        expect(current.occurrence).toBe(previous.occurrence + 1);
      }
    }
  });
});

describe('the vocabulary is attached, not computed', () => {
  it('names every event of the four covered bodies', () => {
    for (const event of events) {
      expect(event.phase).toBeDefined();
      expect(event.phase?.title.toLowerCase()).toContain(event.body);
    }
  });

  it('distinguishes waxing from waning squares', () => {
    expect(find('saturn', 'square', 1, 1).phase?.id).toBe('saturn.square.waxing');
    expect(find('saturn', 'square', -1, 1).phase?.id).toBe('saturn.square.waning');
  });

  it('computes a body outside the vocabulary without naming it', () => {
    // The engine computes anything; the vocabulary names four. Jupiter's
    // return exists and is real — it just carries no phase label.
    const natalLon = new Map([['jupiter' as const, bodyState(natalJd, 'jupiter').lon]]);
    const jupiter = planetaryReturns({
      bodies: ['jupiter'],
      natalLon,
      birthJd: natalJd,
      toJd: (natalJd + 365.25 * 15) as JulianDayUT,
    });

    const jupiterReturn = jupiter.find((event) => event.aspect === 'conjunction');
    if (jupiterReturn === undefined) throw new Error('expected a Jupiter return within 15 years');
    expect(ageOf(jupiterReturn)).toBeGreaterThan(11);
    expect(ageOf(jupiterReturn)).toBeLessThan(13);
    expect(jupiterReturn.phase).toBeUndefined();
  });
});

describe('independence from the funnel', () => {
  it('uses the cyclic policy: conjunction, opposition, square, no trine', () => {
    expect(Object.keys(ORB_POLICIES['layer1.cyclic']).sort()).toEqual([
      'conjunction',
      'opposition',
      'square',
    ]);
    for (const event of events) {
      expect(['conjunction', 'opposition', 'square']).toContain(event.aspect);
    }
  });

  it('skips a requested body with no natal longitude rather than guessing', () => {
    const result = planetaryReturns({
      bodies: ['saturn'],
      natalLon: new Map(),
      birthJd: natalJd,
      toJd: (natalJd + 365.25 * 40) as JulianDayUT,
    });
    expect(result).toEqual([]);
  });
});
