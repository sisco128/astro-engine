/**
 * Contract tests for POST /v1/transits/key-dates.
 *
 * The endpoint's job is to support every calculation and let the interface
 * decide what to show, so most of what is asserted here is that the filters
 * are genuinely filters — that changing them changes the result in the
 * direction claimed.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env['SE_EPHE_PATH'] ??= join(homedir(), 'Desktop/astro-engine/ephem');
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const BIRTH = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

interface KeyDatesBody {
  chartRef: string;
  funnel: { requested: unknown; resolved: { slow: { bodies: string[]; aspects: string[] } } };
  span: { days: number };
  density: { windowsPerQuarter: number; windows: number };
  stories: { id: string; strength?: number; scoringVersion: string }[];
  keyDates: {
    storyId: string;
    from: string;
    intensity: number;
    path: { tier: string; body: string; member: string; exact: string; durationDays: number }[];
  }[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let app: FastifyInstance;
/** One computed result, reused: the funnel costs seconds, not milliseconds. */
let base: KeyDatesBody;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  base = (await post({ ...BIRTH, from: '2024-01-01', to: '2027-01-01' })).json<KeyDatesBody>();
}, 120_000);

afterAll(async () => {
  await app.close();
});

async function post(payload: unknown): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/transits/key-dates',
    payload: payload as object,
  });
}

describe('the funnel comes back whole', () => {
  it('returns a path of three tiers per key date', () => {
    expect(base.keyDates.length).toBeGreaterThan(0);

    for (const keyDate of base.keyDates) {
      expect(keyDate.path.map((step) => step.tier)).toEqual(['slow', 'social', 'fast']);
    }
  });

  it('gives each tier a window of its own length, not a flat 30 days', () => {
    // The prototype used activationWindow = 30 for every body. Measured here:
    // Pluto around 40 days, Jupiter around 23, Mars around 3.
    const durations = new Map<string, number[]>();
    for (const keyDate of base.keyDates) {
      for (const step of keyDate.path) {
        const list = durations.get(step.tier) ?? [];
        list.push(step.durationDays);
        durations.set(step.tier, list);
      }
    }

    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

    const slow = median(durations.get('slow') ?? []);
    const social = median(durations.get('social') ?? []);
    const fast = median(durations.get('fast') ?? []);

    expect(slow).toBeGreaterThan(social);
    expect(social).toBeGreaterThan(fast);
    expect(fast).toBeLessThan(10);
  });

  it('keeps every level of a path on the same story', () => {
    const storyIds = new Set(base.stories.map((story) => story.id));
    for (const keyDate of base.keyDates) {
      expect(storyIds.has(keyDate.storyId)).toBe(true);
    }
  });

  it('reports the density it produced, so a client can retune', () => {
    expect(base.density.windowsPerQuarter).toBeGreaterThan(0);
    const quarters = (base.span.days / 365.25) * 4;
    expect(base.density.windowsPerQuarter).toBeCloseTo(base.density.windows / quarters, 4);
  });

  it('echoes the resolved preset, so nothing has to be guessed', () => {
    expect(base.funnel.requested).toBe('funnel.default');
    expect(base.funnel.resolved.slow.bodies).toContain('pluto');
    expect(base.funnel.resolved.slow.aspects).not.toContain('trine');
  });

  it('scores stories with v2 by default', () => {
    for (const story of base.stories) {
      expect(story.scoringVersion).toBe('v2');
      expect(story.strength).toBeDefined();
    }
  });
});

describe('the filters are genuinely filters', () => {
  it('accepts a full configuration, not only a preset', async () => {
    const response = await post({
      ...BIRTH,
      from: '2024-01-01',
      to: '2025-01-01',
      funnel: {
        slow: { bodies: ['neptune'], aspects: ['conjunction'], orbDeg: 1 },
        social: { bodies: ['saturn'], aspects: ['conjunction'], orbDeg: 1 },
        fast: { bodies: ['mars'], aspects: ['conjunction'], orbDeg: 1 },
        nesting: 'same-story',
        clusterDays: 5,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<KeyDatesBody>();
    expect(body.funnel.resolved.slow.bodies).toEqual(['neptune']);
  }, 60_000);

  it('produces fewer key dates from a narrower configuration', async () => {
    const narrow = await post({
      ...BIRTH,
      from: '2024-01-01',
      to: '2027-01-01',
      funnel: {
        slow: { bodies: ['neptune'], aspects: ['conjunction'], orbDeg: 0.5 },
        social: { bodies: ['saturn'], aspects: ['conjunction'], orbDeg: 0.5 },
        fast: { bodies: ['mars'], aspects: ['conjunction'], orbDeg: 0.5 },
        nesting: 'same-point',
        clusterDays: 5,
      },
    });

    expect(narrow.statusCode).toBe(200);
    // Fewer bodies, one aspect, half the orb and the strict rule: this must
    // land below the default, or the parameters are not doing what they say.
    expect(narrow.json<KeyDatesBody>().density.windows).toBeLessThan(base.density.windows);
  }, 60_000);

  it('rejects a body that is not in the catalogue', async () => {
    const response = await post({
      ...BIRTH,
      from: '2024-01-01',
      to: '2025-01-01',
      funnel: {
        slow: { bodies: ['nibiru'], aspects: ['conjunction'], orbDeg: 1 },
        social: { bodies: ['saturn'], aspects: ['conjunction'], orbDeg: 1 },
        fast: { bodies: ['mars'], aspects: ['conjunction'], orbDeg: 1 },
        nesting: 'same-story',
        clusterDays: 5,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown preset by name', async () => {
    const response = await post({
      ...BIRTH,
      from: '2024-01-01',
      to: '2025-01-01',
      funnel: 'funnel.doesnotexist',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('bounds', () => {
  it('refuses a span longer than the engine will compute', async () => {
    // The prototype accepted futureYears: 500 — roughly 180,000 days of
    // synchronous scanning on the request thread.
    const response = await post({ ...BIRTH, from: '2000-01-01', to: '2500-01-01' });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('WINDOW_TOO_LARGE');
    expect(error.details?.['maxDays']).toBeDefined();
  });

  it('refuses a span that runs backwards', async () => {
    const response = await post({ ...BIRTH, from: '2027-01-01', to: '2024-01-01' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await post({ ...BIRTH, from: '2024-01-01', to: '2025-01-01', fnnel: 'x' });
    expect(response.statusCode).toBe(400);
  });
});

describe('metadata', () => {
  it('describes the tiers and presets a client can choose from', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta/funnel' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      tiers: { id: string; availableBodies: string[] }[];
      presets: { id: string }[];
      nestingRules: { id: string }[];
    }>();

    expect(body.tiers.map((tier) => tier.id)).toEqual(['fast', 'social', 'slow']);
    expect(body.presets.map((preset) => preset.id)).toContain('funnel.default');
    expect(body.nestingRules.map((rule) => rule.id)).toEqual(['same-story', 'same-point']);
  });
});

describe('still numbers only', () => {
  it('carries no interpretation, glyphs or debug payload', () => {
    const forbidden = ['formatted', 'symbol', 'sign', 'performance', 'debug', 'interpretation'];
    const found: string[] = [];

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (forbidden.includes(key)) found.push(key);
        walk(value);
      }
    };

    walk(base);
    expect(found).toEqual([]);
  });
});
