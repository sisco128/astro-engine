/**
 * City name to coordinates and IANA zone.
 *
 * The zone is the reason this endpoint exists. POST /v1/charts needs latitude,
 * longitude and a zone together — a chart is wrong by hours without the third
 * — and every frontend that had to assemble those from separate sources
 * assembled them slightly differently. Geocoding lives in the engine so that
 * the answer is one answer.
 *
 * The zone comes from geo-tz, offline: it ships the timezone boundary polygons
 * and resolves a point against them locally. That is a real cost in bytes (see
 * the commit message) bought against a second network call on every search,
 * against a second upstream that can be down while the first one is up, and
 * against a second rate limit. It is also deterministic — the same coordinates
 * give the same zone forever, which a network lookup cannot promise.
 */

import { find as findZones } from 'geo-tz';
import { LRUCache } from 'lru-cache';

import type { NominatimClient, NominatimPlace } from './nominatim.js';

export interface GeoSearchResult {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** IANA identifier, ready to be handed straight to `when.local.zone`. */
  readonly zone: string;
  readonly countryCode?: string;
}

export interface GeoSearchOutcome {
  readonly results: readonly GeoSearchResult[];
  readonly cacheHit: boolean;
}

export type GeoSearch = (query: string, limit: number) => Promise<GeoSearchOutcome>;

/**
 * The most results the engine will ask the upstream for, and therefore the
 * most a client can ask for.
 *
 * Every search fetches this many regardless of the requested `limit`, and the
 * response is sliced afterwards. That is what lets the cache key be the query
 * alone: a client that asks for 3 and then for 10 pays one upstream request,
 * not two, and upstream requests are the scarce resource here — one per
 * second, for the whole process.
 */
export const MAX_LIMIT = 10;
export const DEFAULT_LIMIT = 5;

/**
 * Lower-cased, trimmed, inner whitespace collapsed.
 *
 * "Roma", " roma " and "Roma\n Italia" (with any spacing) are one query as far
 * as a geocoder is concerned, and treating them as three is three times the
 * rate-limited requests for one answer. Case folding is `toLowerCase` and not
 * locale-aware: the normalised string is a cache key, never a display value
 * and never what is sent upstream, so the only property it needs is that equal
 * queries collide.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The zone at a point.
 *
 * geo-tz partitions the entire globe: land falls in a named zone, and open
 * ocean falls in the nautical `Etc/GMT±N` band for its meridian. So an empty
 * array does not mean "nowhere" — it means the shipped boundary data failed to
 * load — and `Etc/UTC` is both the only defensible answer at that point and
 * exactly what a caller with no zone would have assumed anyway.
 */
function zoneAt(lat: number, lon: number): string {
  return findZones(lat, lon)[0] ?? 'Etc/UTC';
}

/**
 * A dedicated LRU rather than ResultCache.
 *
 * ResultCache keys everything on the engine version and a hash of the
 * ephemeris manifest, which is right for computed charts and wrong for this:
 * a city's coordinates have nothing to do with which .se1 files are installed,
 * and re-seeding the ephemeris would throw away a geocoding cache for no
 * reason. Its one-hour TTL and 256 MB byte bound are sized for multi-megabyte
 * chart payloads too. This holds a handful of small objects per city and wants
 * a long TTL, so it gets its own instance of the same underlying library.
 *
 * A week, because cities do not move. The bound is by entry count alone —
 * an entry is at most ten short records, kilobytes, so bounding bytes as well
 * would be arithmetic in service of nothing.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1_000;

export function createGeoSearch(
  client: NominatimClient,
  options: { maxEntries?: number | undefined } = {},
): GeoSearch {
  const cache = new LRUCache<string, GeoSearchResult[]>({
    max: options.maxEntries ?? CACHE_MAX_ENTRIES,
    ttl: CACHE_TTL_MS,
  });

  const toResult = (place: NominatimPlace): GeoSearchResult => ({
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    zone: zoneAt(place.lat, place.lon),
    ...(place.countryCode === undefined ? {} : { countryCode: place.countryCode }),
  });

  return async (query: string, limit: number): Promise<GeoSearchOutcome> => {
    const key = normalizeQuery(query);

    const cached = cache.get(key);
    if (cached !== undefined) {
      return { results: cached.slice(0, limit), cacheHit: true };
    }

    // The normalised form goes upstream, not the raw one: it is the same query
    // to a geocoder, and sending it keeps what was cached equal to what was
    // asked. Nothing is cached when the upstream fails — a GeoError propagates
    // from here, and a failure that stuck around for a week would be worse
    // than the failure.
    const places = await client(key, MAX_LIMIT);
    const results = places.map(toResult);
    cache.set(key, results);

    return { results: results.slice(0, limit), cacheHit: false };
  };
}
