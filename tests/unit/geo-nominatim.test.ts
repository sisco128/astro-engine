/**
 * The Nominatim client, with `fetch` injected.
 *
 * Nothing here touches the network — which is not only a speed choice. The
 * upstream this module talks to allows one request per second and blocks
 * addresses that exceed it, so a test suite that called it for real would be
 * flaky *and* a violation of the terms the client exists to honour.
 *
 * The queue is injected as a pass-through for the same reason it exists in
 * production: with the real one, each of these tests would cost a second.
 * Its behaviour is asserted separately in geo-queue.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { GeoError } from '../../src/geo/errors.js';
import {
  createNominatimClient,
  type FetchLike,
  type HttpResponseLike,
} from '../../src/geo/nominatim.js';
import type { SerialQueue } from '../../src/geo/queue.js';

const immediate: SerialQueue = (task) => task();

/** One row as Nominatim's `format=jsonv2` actually returns it. */
const ROMA_ROW = {
  place_id: 297_960_745,
  osm_type: 'relation',
  osm_id: 41_485,
  lat: '41.8933203',
  lon: '12.4829321',
  category: 'boundary',
  type: 'administrative',
  place_rank: 12,
  importance: 0.79,
  addresstype: 'city',
  name: 'Roma',
  display_name: 'Roma, Roma Capitale, Lazio, Italia',
  address: { city: 'Roma', country: 'Italia', country_code: 'it' },
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(respond: (url: string) => Partial<HttpResponseLike> & { body?: unknown }): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers });
    const reply = respond(url);
    return Promise.resolve({
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: () => Promise.resolve(reply.body),
    });
  };
  return { fetch, calls };
}

describe('the request it sends', () => {
  it('asks /search for jsonv2 with address details, at the requested limit', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: [ROMA_ROW] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    await client('roma', 7);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('roma');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe('7');
    // The country code is the field that lets a client tell two identically
    // named places apart, and jsonv2 omits it without this.
    expect(url.searchParams.get('addressdetails')).toBe('1');
  });

  it('identifies the application in the User-Agent', async () => {
    // Nominatim's policy refuses requests without one. The default names the
    // engine and carries a contact route; a deployment overrides it with its
    // own address.
    const { fetch, calls } = stubFetch(() => ({ body: [] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    await client('roma', 5);

    expect(calls[0]?.headers['user-agent']).toContain('astro-engine');
  });

  it('keeps a path prefix on a self-hosted base URL', async () => {
    // The production path is a self-hosted instance, which is routinely
    // mounted under a prefix. `new URL('/search', base)` would silently throw
    // the prefix away and 404 against the reverse proxy's root.
    const { fetch, calls } = stubFetch(() => ({ body: [] }));
    const client = createNominatimClient({
      fetch,
      queue: immediate,
      baseUrl: 'https://internal.example/nominatim/',
    });

    await client('roma', 5);

    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/nominatim/search');
  });
});

describe('the answer it accepts', () => {
  it('returns the full display name, not the bare one', async () => {
    // "Roma" alone is what a chooser cannot choose between: there are several,
    // on three continents. The administrative path is what disambiguates them.
    const { fetch } = stubFetch(() => ({ body: [ROMA_ROW] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    const [place] = await client('roma', 5);

    expect(place?.name).toBe('Roma, Roma Capitale, Lazio, Italia');
  });

  it('parses the string coordinates into numbers', async () => {
    const { fetch } = stubFetch(() => ({ body: [ROMA_ROW] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    const [place] = await client('roma', 5);

    expect(place?.lat).toBeCloseTo(41.8933203, 7);
    expect(place?.lon).toBeCloseTo(12.4829321, 7);
  });

  it('upper-cases the country code, and omits it when the upstream has none', async () => {
    const { address, ...withoutAddress } = ROMA_ROW;
    expect(address.country_code).toBe('it');

    const { fetch } = stubFetch(() => ({ body: [ROMA_ROW, withoutAddress] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    const places = await client('roma', 5);

    expect(places[0]?.countryCode).toBe('IT');
    expect(places[1]).not.toHaveProperty('countryCode');
  });

  it('returns an empty list for a place that does not exist', async () => {
    // Not an error: "no such city" is a real, useful answer, and the caller
    // should not have to distinguish it from the upstream being down.
    const { fetch } = stubFetch(() => ({ body: [] }));
    const client = createNominatimClient({ fetch, queue: immediate });

    await expect(client('zzzzzzzz', 5)).resolves.toEqual([]);
  });
});

describe('the ways it fails', () => {
  async function expectUpstreamFailure(client: () => Promise<unknown>): Promise<GeoError> {
    const error = await client().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GeoError);
    expect((error as GeoError).code).toBe('GEO_UPSTREAM_FAILED');
    return error as GeoError;
  }

  it('reports a 500 as an upstream failure, with the status in details', async () => {
    const { fetch } = stubFetch(() => ({ ok: false, status: 500, body: undefined }));
    const client = createNominatimClient({ fetch, queue: immediate });

    const error = await expectUpstreamFailure(() => client('roma', 5));
    expect(error.details['status']).toBe(500);
  });

  it('reports a 403 the same way', async () => {
    // 403 is how Nominatim says the deployment has been blocked. An operator
    // problem, but still nothing the caller can fix by rewording the query.
    const { fetch } = stubFetch(() => ({ ok: false, status: 403, body: undefined }));
    const client = createNominatimClient({ fetch, queue: immediate });

    const error = await expectUpstreamFailure(() => client('roma', 5));
    expect(error.details['status']).toBe(403);
  });

  it('reports a network failure or timeout as an upstream failure', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('fetch failed'));
    const client = createNominatimClient({ fetch, queue: immediate });

    await expectUpstreamFailure(() => client('roma', 5));
  });

  it('refuses a body that is not the shape it was written against', async () => {
    // parseFloat on a field that turned out to be absent yields NaN, which
    // travels a long way before it looks wrong. Whole-response, not
    // row-by-row: dropping the rows that failed would report "no such city"
    // for what is really a broken integration.
    const { fetch } = stubFetch(() => ({ body: { error: 'Unable to geocode' } }));
    const client = createNominatimClient({ fetch, queue: immediate });

    await expectUpstreamFailure(() => client('roma', 5));
  });

  it('refuses a row whose coordinates are not coordinates', async () => {
    const { fetch } = stubFetch(() => ({
      body: [{ ...ROMA_ROW, lat: 'not a latitude' }],
    }));
    const client = createNominatimClient({ fetch, queue: immediate });

    await expectUpstreamFailure(() => client('roma', 5));
  });
});
