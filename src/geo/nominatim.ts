/**
 * The Nominatim client: a place name in, candidate coordinates out.
 *
 * Nominatim is OpenStreetMap's geocoder and the prototype used it too
 * (server/geocoding.js), with none of the obligations that come with it: no
 * rate limiting, a User-Agent of "AstrologyCalculator/1.0" with no contact
 * route, and `limit=1` hardcoded so the caller never saw that "Roma" is also a
 * town in Texas, Queensland and Lesotho. The upstream choice was sound; the
 * terms of use were simply not implemented.
 *
 * Two things are structural here:
 *
 *   - Every request goes through a shared serial queue that spaces starts by
 *     one second. See src/geo/queue.ts — that interval is policy, not taste.
 *   - `fetch` is a parameter. Tests inject a fake and the suite never touches
 *     the network, which for an upstream with a 1 rps policy is not a
 *     convenience: a contract suite that hit the public instance would be both
 *     flaky and a violation of the terms this module exists to honour.
 *
 * The response is parsed with zod rather than trusted. It arrives from a
 * service this process does not control, and `parseFloat(result.lat)` on a
 * field that turned out to be absent yields NaN, which travels a long way
 * before it looks wrong.
 */

import { z } from 'zod';

import { env } from '../config/env.js';
import { GeoError } from './errors.js';
import { createSerialQueue, type SerialQueue } from './queue.js';

/**
 * The subset of `fetch` this module uses, structurally typed.
 *
 * Narrower than `typeof fetch` on purpose: a test fake has to satisfy this,
 * not the whole WHATWG interface, and the real global still assigns to it.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<HttpResponseLike>;

/** One candidate place, as far as the upstream is concerned. No zone yet. */
export interface NominatimPlace {
  /**
   * Nominatim's `display_name`: the full administrative path, e.g.
   * "Roma, Roma Capitale, Lazio, Italia". The short `name` is kept out of the
   * result because "Roma" alone is exactly what a chooser cannot choose
   * between — there are several, on three continents.
   */
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** ISO 3166-1 alpha-2, upper-cased. Absent when the upstream omits it. */
  readonly countryCode?: string;
}

export type NominatimClient = (query: string, limit: number) => Promise<NominatimPlace[]>;

/**
 * Nominatim's `format=jsonv2` row, reduced to the fields this engine returns.
 *
 * `lat`/`lon` arrive as strings; `z.coerce.number()` accepts either and still
 * rejects a value that is not a number, NaN included.
 */
const PlaceRowSchema = z.looseObject({
  display_name: z.string().min(1),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  address: z.looseObject({ country_code: z.string().optional() }).optional(),
});

const SearchResponseSchema = z.array(PlaceRowSchema);

/**
 * How long to wait on the upstream before giving up.
 *
 * Not configurable through the environment: the number that matters to a
 * deployment is REQUEST_TIMEOUT_MS, and a geocoding call that has not answered
 * in five seconds is not going to rescue the request it is holding up.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Nominatim's policy ceiling: one request per second, absolute. */
const MIN_REQUEST_INTERVAL_MS = 1_000;

export function createNominatimClient(
  options: {
    fetch?: FetchLike | undefined;
    baseUrl?: string | undefined;
    userAgent?: string | undefined;
    queue?: SerialQueue | undefined;
    timeoutMs?: number | undefined;
  } = {},
): NominatimClient {
  const doFetch: FetchLike = options.fetch ?? globalThis.fetch;
  // Trailing slashes trimmed rather than fed to `new URL('/search', base)`,
  // which would discard a path prefix — a self-hosted instance mounted at
  // https://internal/nominatim is the normal production shape.
  const baseUrl = (options.baseUrl ?? env.nominatimBaseUrl).replace(/\/+$/, '');
  const userAgent = options.userAgent ?? env.geoUserAgent;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One queue per client, and one client per process: the budget belongs to
  // the source address, so a per-request queue would enforce nothing at all.
  const queue = options.queue ?? createSerialQueue({ minIntervalMs: MIN_REQUEST_INTERVAL_MS });

  return async (query: string, limit: number): Promise<NominatimPlace[]> => {
    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    // The country code is the one field worth a heavier response: it is what
    // lets a client label two identically-named places apart.
    url.searchParams.set('addressdetails', '1');

    const payload = await queue(async () => {
      let response: HttpResponseLike;
      try {
        response = await doFetch(url.toString(), {
          headers: { 'user-agent': userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        // A timeout, a DNS failure and a refused connection all land here and
        // are the same fact: no answer.
        throw new GeoError('GEO_UPSTREAM_FAILED', 'The geocoding upstream did not answer', {
          reason: cause instanceof Error ? cause.name : 'unknown',
          timeoutMs,
        });
      }

      if (!response.ok) {
        // Includes 403, which is how Nominatim says the deployment has been
        // blocked. That is an operator problem rather than a caller problem,
        // but it is still nothing the caller can fix by rewording the query —
        // so it stays a 502, with the status visible for whoever investigates.
        throw new GeoError('GEO_UPSTREAM_FAILED', 'The geocoding upstream returned an error', {
          status: response.status,
        });
      }

      try {
        return await response.json();
      } catch {
        throw new GeoError('GEO_UPSTREAM_FAILED', 'The geocoding upstream returned invalid JSON');
      }
    });

    const parsed = SearchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      // Whole-response, not row-by-row. A shape this module does not recognise
      // means the upstream is not the one it was written against, and silently
      // dropping the rows that failed would report "no such city" for what is
      // really a broken integration.
      throw new GeoError(
        'GEO_UPSTREAM_FAILED',
        'The geocoding upstream returned an unrecognised shape',
        { issues: parsed.error.issues.slice(0, 5) },
      );
    }

    return parsed.data.map((row) => {
      const countryCode = row.address?.country_code?.toUpperCase();
      return {
        name: row.display_name,
        lat: row.lat,
        lon: row.lon,
        // exactOptionalPropertyTypes: the key is omitted rather than set to
        // undefined, so it does not appear as `"countryCode": null` on the wire.
        ...(countryCode === undefined ? {} : { countryCode }),
      };
    });
  };
}
