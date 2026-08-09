/**
 * Query normalisation, the zone lookup, and the cache.
 *
 * The upstream client is a stub; geo-tz is the real thing. That split is the
 * point of the module: the network part is injected and the zone part is
 * offline, deterministic and therefore worth asserting against actual
 * coordinates rather than against a mock of itself.
 */

import { describe, expect, it } from 'vitest';

import type { NominatimClient, NominatimPlace } from '../../src/geo/nominatim.js';
import { createGeoSearch, MAX_LIMIT, normalizeQuery } from '../../src/geo/search.js';

const ROMA: NominatimPlace = {
  name: 'Roma, Roma Capitale, Lazio, Italia',
  lat: 41.8933203,
  lon: 12.4829321,
  countryCode: 'IT',
};

const NEW_YORK: NominatimPlace = {
  name: 'New York, United States',
  lat: 40.7127281,
  lon: -74.0060152,
  countryCode: 'US',
};

/** A point in the Pacific, hundreds of miles from any land. */
const OPEN_OCEAN: NominatimPlace = { name: 'Pacific Ocean', lat: 0, lon: -140 };

interface Stub {
  client: NominatimClient;
  calls: { query: string; limit: number }[];
}

function stubClient(places: NominatimPlace[] = [ROMA]): Stub {
  const calls: { query: string; limit: number }[] = [];
  return {
    calls,
    client: (query, limit) => {
      calls.push({ query, limit });
      return Promise.resolve(places);
    },
  };
}

describe('normalizeQuery', () => {
  it('lower-cases, trims, and collapses inner whitespace', () => {
    expect(normalizeQuery('  ROMA  ')).toBe('roma');
    expect(normalizeQuery('New   York')).toBe('new york');
    expect(normalizeQuery('Roma,\n\tItalia')).toBe('roma, italia');
  });

  it('leaves an already-normal query alone, and is idempotent', () => {
    expect(normalizeQuery('roma')).toBe('roma');
    expect(normalizeQuery(normalizeQuery(' San   José '))).toBe(normalizeQuery(' San   José '));
  });

  it('does not fold anything but case and whitespace', () => {
    // Accents and punctuation are part of the query a geocoder is good at.
    // Stripping them here would be this module deciding it knows better than
    // the upstream what "Zürich" means.
    expect(normalizeQuery('Zürich')).toBe('zürich');
    expect(normalizeQuery("L'Aquila")).toBe("l'aquila");
  });
});

describe('the zone, from the coordinates', () => {
  async function zoneOf(place: NominatimPlace): Promise<string> {
    const search = createGeoSearch(stubClient([place]).client);
    const { results } = await search('anything', 5);
    return results[0]?.zone ?? '';
  }

  it('puts Rome in Europe/Rome', async () => {
    expect(await zoneOf(ROMA)).toBe('Europe/Rome');
  });

  it('puts New York in America/New_York', async () => {
    expect(await zoneOf(NEW_YORK)).toBe('America/New_York');
  });

  it('answers for a point in open ocean rather than failing', async () => {
    // geo-tz partitions the whole globe: open water falls in the nautical
    // Etc/GMT±N band for its meridian. A birth on a ship is rare and a
    // mistyped coordinate is not, and neither should crash the endpoint.
    const zone = await zoneOf(OPEN_OCEAN);

    expect(zone).toMatch(/^Etc\/GMT[+-]\d+$/);
    // Sensible means usable: whatever comes back has to be something the
    // charts endpoint can hand to Temporal.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
  });

  it('carries the country code through when the upstream had one', async () => {
    const search = createGeoSearch(stubClient([ROMA, OPEN_OCEAN]).client);
    const { results } = await search('roma', 5);

    expect(results[0]?.countryCode).toBe('IT');
    expect(results[1]).not.toHaveProperty('countryCode');
  });
});

describe('the cache', () => {
  it('asks the upstream once for a repeated query', async () => {
    const stub = stubClient();
    const search = createGeoSearch(stub.client);

    const first = await search('Roma', 5);
    const second = await search('Roma', 5);

    expect(stub.calls).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.results).toEqual(first.results);
  });

  it('treats queries that normalise the same as one query', async () => {
    const stub = stubClient();
    const search = createGeoSearch(stub.client);

    await search('Roma', 5);
    await search('  roma  ', 5);
    await search('ROMA', 5);

    // Three spellings, one rate-limited request. This is the whole reason
    // normalisation happens before the cache and not after it.
    expect(stub.calls).toHaveLength(1);
  });

  it('sends the normalised query upstream, not the raw one', async () => {
    const stub = stubClient();
    const search = createGeoSearch(stub.client);

    await search('  New   YORK ', 5);

    expect(stub.calls[0]?.query).toBe('new york');
  });

  it('asks for different queries separately', async () => {
    const stub = stubClient();
    const search = createGeoSearch(stub.client);

    await search('roma', 5);
    await search('napoli', 5);

    expect(stub.calls.map((call) => call.query)).toEqual(['roma', 'napoli']);
  });

  it('always fetches the maximum and slices, so a bigger limit is free', async () => {
    const places = Array.from({ length: MAX_LIMIT }, (_, index) => ({
      ...ROMA,
      name: `Roma ${String(index)}`,
    }));
    const stub = stubClient(places);
    const search = createGeoSearch(stub.client);

    const narrow = await search('roma', 2);
    const wide = await search('roma', MAX_LIMIT);

    expect(stub.calls).toEqual([{ query: 'roma', limit: MAX_LIMIT }]);
    expect(narrow.results).toHaveLength(2);
    expect(wide.results).toHaveLength(MAX_LIMIT);
  });

  it('does not cache a failure', async () => {
    // A cache with a week-long TTL that remembered an outage would be worse
    // than the outage.
    let attempts = 0;
    const client: NominatimClient = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('upstream down')) : Promise.resolve([ROMA]);
    };
    const search = createGeoSearch(client);

    await expect(search('roma', 5)).rejects.toThrow('upstream down');
    await expect(search('roma', 5)).resolves.toMatchObject({ cacheHit: false });
    expect(attempts).toBe(2);
  });

  it('evicts the least recently used entry when it is full', async () => {
    const stub = stubClient();
    const search = createGeoSearch(stub.client, { maxEntries: 2 });

    await search('roma', 5);
    await search('napoli', 5);
    await search('milano', 5);
    await search('roma', 5);

    // Four searches, four upstream calls: 'roma' was evicted by 'milano'.
    expect(stub.calls).toHaveLength(4);
  });
});
