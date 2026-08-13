/**
 * Natal chart assembly: birth data in, numbers out.
 *
 * Numbers only. No `formatted: "15°23' Sign"`, no glyphs, no sign names, no
 * `performance` block. The prototype generated all of those inside the
 * calculation layer (positions.js:29, planets.js:5-16) and shipped them over
 * the wire, which is how presentation decisions ended up frozen into the
 * engine. A sign index is `Math.floor(lon / 30)` in the client; shipping it
 * would only re-export the `SIGNS[12]` bug across the network.
 */

import { createHash } from 'node:crypto';

import { BODIES, type BodyId } from '../ephemeris/bodies.js';
import {
  bodyState,
  housesFor,
  jdFromUtc,
  type HouseSystem,
  type JulianDayUT,
} from '../ephemeris/swe.js';
import { houseOf } from './houses.js';
import { aspectsAmong, type Aspect } from './aspects.js';
import { ORB_POLICIES } from './orb-policy.js';

export interface ChartRequest {
  /** UTC instant of birth. Local-time resolution happens before this point. */
  readonly utc: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second?: number | undefined;
  };
  readonly geo: {
    readonly lat: number;
    readonly lon: number;
  };
  readonly houseSystem: HouseSystem;
  readonly bodies: readonly BodyId[];
  /**
   * Whether `utc` came from an assumed birth hour. Changes no number here —
   * the calculation cannot tell the difference and should not try — but it
   * does change the response, which declares the assumption. It therefore has
   * to reach the content hash, or a chart built on a guessed 03:00 and one
   * built on a stated 03:00 would share a chartRef and an ETag while
   * disagreeing about what they are.
   */
  readonly birthTimeAssumed?: boolean;
}

export interface ChartBody {
  readonly id: BodyId;
  readonly lon: number;
  readonly lat: number;
  readonly distAu: number;
  readonly lonSpeed: number;
  /**
   * Derived from the sign of `lonSpeed`, which the prototype could not do:
   * it read a field the binding does not emit, so this was false for every
   * body on every date.
   */
  readonly retrograde: boolean;
  readonly house: number;
}

export interface Chart {
  readonly chartRef: string;
  readonly jdUt: number;
  readonly utc: string;
  readonly geo: { readonly lat: number; readonly lon: number };
  readonly bodies: readonly ChartBody[];
  readonly angles: {
    readonly ascendant: number;
    readonly midheaven: number;
    readonly armc: number;
    readonly vertex: number;
    readonly equatorialAscendant: number;
  };
  readonly houses: {
    readonly system: HouseSystem;
    readonly cusps: readonly number[];
  };
  /**
   * The natal aspects, with their orbs.
   *
   * Computed here rather than left to the client for the same reason the orb
   * tables were consolidated in the first place: an aspect exists only
   * relative to a policy, and a second copy of that policy elsewhere is a
   * second answer waiting to disagree with this one.
   *
   * A client that wants the count takes `aspects.length`; one that wants to
   * print "orbe 2,1°" takes `orb`. Both were previously impossible without
   * reimplementing the policy.
   */
  readonly aspects: readonly Aspect[];
}

/**
 * A content hash of everything that determines the result — not a session id.
 *
 * The prototype had no chart identity at all, so `/api/analyze-activations`
 * required the client to POST the entire chart back and the server trusted
 * whatever arrived. Here the reference is derived, so two identical requests
 * from two different frontends produce the same key and the same cache entry,
 * and restarting the service loses nothing.
 */
function computeChartRef(request: ChartRequest, jdUt: number): string {
  const canonical = JSON.stringify({
    jdUt,
    lat: request.geo.lat,
    lon: request.geo.lon,
    houseSystem: request.houseSystem,
    bodies: [...request.bodies].sort(),
    // Only when true, so every reference minted before unknown birth times
    // existed still hashes to the same string. JSON.stringify drops an
    // undefined value, which would make the absent case implicit rather than
    // stated; the conditional makes it stated.
    ...(request.birthTimeAssumed === true ? { birthTimeAssumed: true } : {}),
  });

  const digest = createHash('sha256').update(canonical).digest('base64url');
  return `cr1_${digest.slice(0, 22)}`;
}

function toIsoUtc(utc: ChartRequest['utc']): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const year = utc.year < 0 ? `-${pad(Math.abs(utc.year), 6)}` : pad(utc.year, 4);
  return `${year}-${pad(utc.month)}-${pad(utc.day)}T${pad(utc.hour)}:${pad(utc.minute)}:${pad(utc.second ?? 0)}Z`;
}

export function calculateChart(request: ChartRequest): Chart {
  const jdUt: JulianDayUT = jdFromUtc(request.utc);

  const houses = housesFor(jdUt, request.geo.lat, request.geo.lon, request.houseSystem);

  const bodies: ChartBody[] = request.bodies.map((id) => {
    const state = bodyState(jdUt, id);
    return {
      id,
      lon: state.lon,
      lat: state.lat,
      distAu: state.distAu,
      lonSpeed: state.lonSpeed,
      // The Sun and Moon never retrograde; asserting it from the catalogue
      // rather than from the sign of a float avoids reporting -0 as retrograde.
      retrograde: BODIES[id].retrogradable && state.lonSpeed < 0,
      house: houseOf(state.lon, houses.cusps),
    };
  });

  /**
   * `natal.default` because that is what a natal chart means here. The transit
   * policies are tighter and belong to the funnel, not to the chart.
   *
   * The angles take part, and leaving them out was a real gap rather than a
   * simplification: `identifyStories` builds stories over the Ascendant and
   * the Midheaven, so a story could name a member this list could never
   * explain. On the reference chart that showed as a row reading "Ascendente"
   * with nothing after it — the Ascendant really is trine Chiron at 6.7°, and
   * the screen had no way to know.
   *
   * No `lonSpeed` for them, which `AspectPoint` already allows and says why:
   * the Ascendant moves with the Earth's rotation, and calling that "applying"
   * would be a category error rather than a useful number.
   */
  const aspects = aspectsAmong(
    [
      ...bodies.map((body) => ({ id: body.id, lon: body.lon, lonSpeed: body.lonSpeed })),
      { id: 'ascendant', lon: houses.ascendant },
      { id: 'midheaven', lon: houses.midheaven },
    ],
    ORB_POLICIES['natal.default'],
  );

  return {
    chartRef: computeChartRef(request, jdUt),
    jdUt,
    utc: toIsoUtc(request.utc),
    geo: { lat: request.geo.lat, lon: request.geo.lon },
    bodies,
    aspects,
    angles: {
      ascendant: houses.ascendant,
      midheaven: houses.midheaven,
      armc: houses.armc,
      vertex: houses.vertex,
      equatorialAscendant: houses.equatorialAscendant,
    },
    houses: {
      system: houses.system,
      cusps: houses.cusps,
    },
  };
}
