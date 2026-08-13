/**
 * Contract tests for POST /v1/charts.
 *
 * These use Fastify's `inject`, so no port is bound. That is only possible
 * because `buildApp()` is pure: the prototype called `app.listen()` at module
 * load *and* exported the app (server/index.js:81-86), so importing it for a
 * test started a real server.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
// These tests assert on responses, not on stdout.
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** 12 Aug 1987, 11:32 CEST, Rome — the primary regression chart. */
const ROME_1987 = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
  houseSystem: 'P',
};

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface ChartBody {
  chartRef: string;
  utc: string;
  bodies: { id: string; lon: number; lonSpeed: number; retrograde: boolean; house: number }[];
  houses: { system: string; cusps: number[] };
  angles: { ascendant: number };
  birthTime?: {
    assumed: true;
    assumedLocal: { hour: number; minute: number; zone: string };
    basis: string;
    basisPeakLocalHours: { from: number; to: number };
    uncertaintyHours: number;
  };
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  // Readiness now includes the compute pool, whose workers start
  // asynchronously. Waiting here rather than loosening the assertion: a 503
  // before a worker exists is the right answer, and the test should observe
  // the steady state.
  await app.pool.whenReady();
}, 60_000);

afterAll(async () => {
  await app.close();
});

async function postChart(payload: unknown): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url: '/v1/charts', payload: payload as object });
}

describe('POST /v1/charts', () => {
  it('resolves a local time through its zone', async () => {
    const response = await postChart(ROME_1987);
    expect(response.statusCode).toBe(200);

    const body = response.json<ChartBody>();
    // 11:32 CEST is 09:32 UT. The prototype's own regression test passed 11:32
    // in as though it were UT, making every number it asserted 2 hours wrong.
    expect(body.utc).toBe('1987-08-12T09:32:00Z');

    const sun = body.bodies.find((entry) => entry.id === 'sun');
    expect(sun).toBeDefined();
    // JPL Horizons for this instant: 139.1556495.
    expect(sun?.lon).toBeWithinArcsec(139.1556495, 1.0);
  });

  it('accepts a UTC instant directly and agrees with the local-time route', async () => {
    const viaUtc = await postChart({
      when: { utc: { year: 1987, month: 8, day: 12, hour: 9, minute: 32 } },
      geo: ROME_1987.geo,
      houseSystem: 'P',
    });
    const viaLocal = await postChart(ROME_1987);

    // Same instant, same place, same system — therefore the same content hash.
    expect(viaUtc.json<ChartBody>().chartRef).toBe(viaLocal.json<ChartBody>().chartRef);
  });

  it('returns a strong ETag equal to the chart reference', async () => {
    const response = await postChart(ROME_1987);
    expect(response.headers.etag).toBe(`"${response.json<ChartBody>().chartRef}"`);
  });

  it('places every body in a house between 1 and 12', async () => {
    const body = (await postChart(ROME_1987)).json<ChartBody>();

    expect(body.bodies.length).toBeGreaterThanOrEqual(12);
    for (const entry of body.bodies) {
      expect(entry.house).toBeGreaterThanOrEqual(1);
      expect(entry.house).toBeLessThanOrEqual(12);
    }
  });

  it('reports retrograde from the sign of the speed', async () => {
    const body = (await postChart(ROME_1987)).json<ChartBody>();

    // The prototype read a field the binding does not emit, so this was false
    // for every body on every date. On 12 Aug 1987 the outer planets were
    // retrograde, so a suite that never sees a `true` here has regressed.
    expect(body.bodies.some((entry) => entry.retrograde)).toBe(true);

    for (const entry of body.bodies) {
      if (entry.retrograde) expect(entry.lonSpeed).toBeLessThan(0);
    }
    expect(body.bodies.find((entry) => entry.id === 'sun')?.retrograde).toBe(false);
  });
});

describe('an unknown birth time, declared rather than hidden', () => {
  /**
   * The date is on the birth certificate; the hour usually is not. The
   * customary answer is to compute noon and say nothing. Here the hour is
   * 03:00 — a UCL study of ~5M births found over half of spontaneous births
   * between 01:00 and 07:00 with a peak near 04:00, and a US study of ~43k
   * deliveries put the peak at 02:00-04:00 — and the response says so.
   */
  const ROME_1987_NO_HOUR = {
    when: { localDate: { year: 1987, month: 8, day: 12, zone: 'Europe/Rome' } },
    geo: ROME_1987.geo,
    houseSystem: 'P',
  };

  it('accepts a date without an hour and resolves it at 03:00 local', async () => {
    const response = await postChart(ROME_1987_NO_HOUR);
    expect(response.statusCode).toBe(200);

    // 03:00 CEST is 01:00 UT.
    expect(response.json<ChartBody>().utc).toBe('1987-08-12T01:00:00Z');
  });

  it('declares the assumption, in numbers and identifiers', async () => {
    const { birthTime } = (await postChart(ROME_1987_NO_HOUR)).json<ChartBody>();

    expect(birthTime).toBeDefined();
    expect(birthTime?.assumed).toBe(true);
    expect(birthTime?.assumedLocal).toEqual({ hour: 3, minute: 0, zone: 'Europe/Rome' });
    expect(birthTime?.basis).toBe('spontaneous-birth-peak');
    expect(birthTime?.basisPeakLocalHours).toEqual({ from: 2, to: 4 });
    // The assumption picks the likeliest hour; it does not narrow the range.
    expect(birthTime?.uncertaintyHours).toBe(24);
  });

  it('still computes houses and angles, rather than suppressing them', async () => {
    // An Ascendant nobody can check is still the best available estimate. The
    // birthTime block is what stops it being read as measured.
    const body = (await postChart(ROME_1987_NO_HOUR)).json<ChartBody>();

    expect(body.houses.cusps).toHaveLength(12);
    expect(body.angles.ascendant).toBeGreaterThanOrEqual(0);
    for (const entry of body.bodies) {
      expect(entry.house).toBeGreaterThanOrEqual(1);
      expect(entry.house).toBeLessThanOrEqual(12);
    }
  });

  it('does not hand an assumed chart the reference of a stated one', async () => {
    // Same instant, same numbers, different claim about where the hour came
    // from. If both hashed alike, the ETag on this response would validate the
    // other one — and the two disagree about what they are.
    const stated = await postChart({
      when: { local: { year: 1987, month: 8, day: 12, hour: 3, minute: 0, zone: 'Europe/Rome' } },
      geo: ROME_1987.geo,
      houseSystem: 'P',
    });
    const assumed = await postChart(ROME_1987_NO_HOUR);

    expect(assumed.json<ChartBody>().utc).toBe(stated.json<ChartBody>().utc);
    expect(assumed.json<ChartBody>().chartRef).not.toBe(stated.json<ChartBody>().chartRef);
    expect(assumed.headers.etag).toBe(`"${assumed.json<ChartBody>().chartRef}"`);
    expect(stated.json<ChartBody>().birthTime).toBeUndefined();
  });

  it('leaves a known birth time exactly as it was', async () => {
    // The whole point of spreading the block conditionally: a request with a
    // real hour gets the response it got before unknown times existed.
    const body = (await postChart(ROME_1987)).json<ChartBody>();

    expect(body.birthTime).toBeUndefined();
    expect(Object.keys(body)).not.toContain('birthTime');
    expect(body.utc).toBe('1987-08-12T09:32:00Z');
  });

  it('rejects an hour smuggled into the date-only variant', async () => {
    // Otherwise the hour would be dropped in silence and the response would
    // declare it unknown — the exact failure this feature exists to remove.
    const response = await postChart({
      when: { localDate: { year: 1987, month: 8, day: 12, hour: 11, zone: 'Europe/Rome' } },
      geo: ROME_1987.geo,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('the response carries numbers, not presentation', () => {
  /**
   * The pure-engine boundary, asserted rather than trusted. The prototype
   * shipped `formatted: "15 deg 23' Sign"` strings, glyphs, prose in
   * `analysis.interpretation` ("Placeholder: ... AI integration"), and a
   * `performance` block carrying process memory statistics.
   */
  const FORBIDDEN_KEYS = [
    'formatted',
    'symbol',
    'sign',
    'signIndex',
    'degrees',
    'minutes',
    'performance',
    'debug',
    'analysis',
    'interpretation',
  ];

  it('contains none of the forbidden keys anywhere in the payload', async () => {
    const payload = (await postChart(ROME_1987)).json<unknown>();
    const found: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          walk(item, `${path}[${String(index)}]`);
        });
        return;
      }
      if (node === null || typeof node !== 'object') return;

      for (const [key, value] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(key)) found.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };

    walk(payload, '$');
    expect(found).toEqual([]);
  });

  it('contains no glyph characters', async () => {
    const response = await postChart(ROME_1987);
    // Astrological and zodiac symbol blocks.
    expect(response.body).not.toMatch(/[☀-⛿←-⇿]/u);
  });
});

describe('error responses', () => {
  it('rejects a wall-clock time the clock skipped', async () => {
    const response = await postChart({
      when: {
        local: { year: 1978, month: 4, day: 30, hour: 2, minute: 30, zone: 'America/New_York' },
      },
      geo: { lat: 40.7128, lon: -74.006 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('NONEXISTENT_LOCAL_TIME');
  });

  it('returns both candidates for a wall-clock time that happened twice', async () => {
    const response = await postChart({
      when: {
        local: { year: 1978, month: 10, day: 29, hour: 1, minute: 30, zone: 'America/New_York' },
      },
      geo: { lat: 40.7128, lon: -74.006 },
    });

    expect(response.statusCode).toBe(409);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('AMBIGUOUS_LOCAL_TIME');
    expect(error.details?.['candidates']).toHaveLength(2);
  });

  it('refuses Placidus above the polar circle and suggests alternatives', async () => {
    const response = await postChart({
      when: { utc: { year: 1975, month: 6, day: 21, hour: 12, minute: 0 } },
      geo: { lat: 69.65, lon: 18.9553 },
      houseSystem: 'P',
    });

    expect(response.statusCode).toBe(422);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE');

    const suggested = error.details?.['suggestedSystems'] as { system: string }[];
    expect(suggested.length).toBeGreaterThan(0);
  });

  it('accepts a suggested system at that same latitude', async () => {
    // The suggestion has to actually work, or it is not a suggestion.
    const response = await postChart({
      when: { utc: { year: 1975, month: 6, day: 21, hour: 12, minute: 0 } },
      geo: { lat: 69.65, lon: 18.9553 },
      houseSystem: 'W',
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await postChart({ ...ROME_1987, hoseSystem: 'P' });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an out-of-range latitude', async () => {
    const response = await postChart({ ...ROME_1987, geo: { lat: 200, lon: 0 } });
    expect(response.statusCode).toBe(400);
  });

  it('never leaks a stack trace', async () => {
    // The prototype returned error.stack whenever NODE_ENV was development
    // (routes/activations.js:438).
    const response = await postChart({ nonsense: true });
    expect(response.body).not.toContain('at ');
    expect(response.body).not.toContain('.ts:');
  });
});

describe('service endpoints', () => {
  it('reports readiness with the ephemeris state', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('ready');
  });

  it('offers the source location, as AGPL section 13 requires', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/license' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ license: string; source: string }>();
    expect(body.license).toBe('AGPL-3.0-or-later');
    expect(body.source).toMatch(/^https?:\/\//);
  });

  it('returns a structured 404 rather than HTML', async () => {
    // The prototype's SPA catch-all returned index.html with status 200 for
    // any unknown path that did not begin with /api.
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('the natal aspects', () => {
  it('come back with the chart, with their orbs', async () => {
    // Neither the count nor the orb could be had before this. A client that
    // wanted either had to reimplement the orb policy — the exact duplication
    // this project spent a phase removing, seven copies down to one.
    const body = (await postChart(ROME_1987)).json<
      ChartBody & {
        aspects: { a: string; b: string; aspect: string; orb: number; separation: number }[];
      }
    >();

    expect(body.aspects.length).toBeGreaterThan(0);

    // Every end is a point this same response describes: a body in `bodies`,
    // or one of the two angles in `angles`. The angles were added because
    // stories are built on them and the list could not explain a story that
    // named one; this assertion used to allow bodies only, which is how that
    // gap stayed invisible.
    const named = (id: string): boolean =>
      body.bodies.some((entry) => entry.id === id) || id === 'ascendant' || id === 'midheaven';

    for (const aspect of body.aspects) {
      expect(named(aspect.a)).toBe(true);
      expect(named(aspect.b)).toBe(true);
      // Inside the policy's widest orb, and never negative.
      expect(aspect.orb).toBeGreaterThanOrEqual(0);
      expect(aspect.orb).toBeLessThanOrEqual(10);
    }
  });

  it('reports an orb that matches the longitudes it ships', async () => {
    // The whole point of publishing the number is that it can be checked, so
    // the test checks it the way a reader would: from the positions on screen.
    const body = (await postChart(ROME_1987)).json<
      ChartBody & {
        aspects: { a: string; b: string; aspect: string; exactAngle: number; orb: number }[];
      }
    >();

    const sample = body.aspects[0];
    expect(sample).toBeDefined();
    if (sample === undefined) return;

    const a = body.bodies.find((entry) => entry.id === sample.a)?.lon ?? 0;
    const b = body.bodies.find((entry) => entry.id === sample.b)?.lon ?? 0;
    // Deliberately hand-written, and the one place in this repository where
    // that is right: checking a published number with the same helper that
    // produced it proves only that the helper is self-consistent. A reader
    // with the longitudes on screen does this arithmetic, so the test does it
    // too. Safe here because both longitudes are already in [0, 360), which
    // is what the rule exists to guarantee elsewhere.
    // eslint-disable-next-line no-restricted-syntax
    const raw = Math.abs(a - b) % 360;
    const separation = raw > 180 ? 360 - raw : raw;

    expect(Math.abs(separation - sample.exactAngle)).toBeCloseTo(sample.orb, 6);
  });
});

describe('the angles take part in the aspect list', () => {
  /**
   * `identifyStories` builds stories over the Ascendant and the Midheaven, so
   * a story can name a member the aspect list could not explain. On the
   * reference chart that reached a screen as a row reading "Ascendente" with
   * nothing after it — while the Ascendant really is trine Chiron at 6.7°.
   *
   * A chart that cannot say why one of its own stories contains a point is a
   * chart with a hole in it, not a simpler chart.
   */
  it('names the Ascendant’s aspects, so a story can explain itself', async () => {
    const response = await postChart(ROME_1987);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      aspects: { a: string; b: string; aspect: string; orb: number }[];
    }>();
    const angled = body.aspects.filter((x) => x.a === 'ascendant' || x.b === 'ascendant');

    expect(angled.length).toBeGreaterThan(0);
    // Every one carries the number a reader checks it by.
    for (const aspect of angled) expect(aspect.orb).toBeGreaterThanOrEqual(0);
  });

  it('does not claim an angle is applying', async () => {
    // The Ascendant moves with the Earth's rotation. Calling that "applying"
    // would be a category error rather than a useful number, which is why
    // AspectPoint makes lonSpeed optional in the first place.
    const response = await postChart(ROME_1987);
    const body = response.json<{ aspects: { a: string; b: string; applying?: boolean }[] }>();

    for (const aspect of body.aspects) {
      if (aspect.a === 'ascendant' || aspect.b === 'ascendant') {
        expect(aspect.applying).toBeUndefined();
      }
    }
  });
});
