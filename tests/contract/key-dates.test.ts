/**
 * Contract tests for POST /v1/transits/key-dates.
 *
 * The endpoint's job is to support every calculation and let the interface
 * decide what to show, so most of what is asserted here is that the filters
 * are genuinely filters — that changing them changes the result in the
 * direction claimed.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const BIRTH = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

interface KeyDatesBody {
  chartRef: string;
  birthTime?: {
    assumed: true;
    assumedLocal: { hour: number; minute: number; zone: string };
    basis: string;
    uncertaintyHours: number;
  };
  funnel: { requested: unknown; resolved: { slow: { bodies: string[]; aspects: string[] } } };
  span: { days: number };
  density: { windowsPerQuarter: number; windows: number };
  stories: {
    id: string;
    signature: string;
    aspect: string;
    members: string[];
    strength?: number;
    scoringVersion: string;
    timeSensitive?: boolean;
  }[];
  keyDates: {
    storyId: string;
    from: string;
    intensity: number;
    path: {
      tier: string;
      body: string;
      member: string;
      exact: string;
      durationDays: number;
      orbAtKeyDeg: number;
    }[];
  }[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * The same birth, with the hour unknown. Paired with the narrowest funnel the
 * schema allows and half the span: nothing asserted about it depends on the
 * windows, and the funnel is the part that costs seconds.
 */
const BIRTH_NO_HOUR = {
  when: { localDate: { year: 1987, month: 8, day: 12, zone: 'Europe/Rome' } },
  geo: BIRTH.geo,
  funnel: {
    slow: { bodies: ['neptune'], aspects: ['conjunction'], orbDeg: 0.5 },
    social: { bodies: ['saturn'], aspects: ['conjunction'], orbDeg: 0.5 },
    fast: { bodies: ['mars'], aspects: ['conjunction'], orbDeg: 0.5 },
    nesting: 'same-story',
    clusterDays: 5,
  },
};

let app: FastifyInstance;
/** One computed result, reused: the funnel costs seconds, not milliseconds. */
let base: KeyDatesBody;
/** The same, with an unknown birth hour. */
let assumed: KeyDatesBody;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  base = (await post({ ...BIRTH, from: '2024-01-01', to: '2027-01-01' })).json<KeyDatesBody>();
  assumed = (
    await post({ ...BIRTH_NO_HOUR, from: '2024-01-01', to: '2024-07-01' })
  ).json<KeyDatesBody>();
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

  it('says how close each tier is at the key date itself', () => {
    // The number the interface prints under each tier's sentence — "Plutone
    // trigono Luna · orbe 0,4°". It needs the transiting longitude AT the key
    // date, which only the engine can evaluate; leaving it derivable-but-absent
    // is how clients end up deriving it wrong.
    for (const keyDate of base.keyDates) {
      for (const step of keyDate.path) {
        expect(step.orbAtKeyDeg).toBeGreaterThanOrEqual(0);
        // NOT bounded by the configured orb, and the first run of this test
        // proved it: 1.086° against a 1° policy. A slow contact's interval is
        // the envelope of its retrograde passes, and between two passes the
        // body drifts outside the orb while the window, correctly, stays
        // open. That drift is real information — it is why the number is
        // published instead of left for clients to derive — so the bound here
        // is a sanity ceiling, not the policy.
        expect(step.orbAtKeyDeg).toBeLessThanOrEqual(5);
      }

      // The key date IS the fast contact's exact instant, so its orb is zero
      // up to root-finding tolerance: 1e-6 days at lunar speed is ~1.5e-5°.
      const fast = keyDate.path[2];
      expect(fast?.orbAtKeyDeg).toBeLessThanOrEqual(1e-3);

      // And the slow tier is genuinely NOT exact at the key date — if it were,
      // the field would be indistinguishable from a constant zero and this
      // test would prove nothing. At least one window's slow orb must be
      // meaningfully open.
    }

    const slowOrbs = base.keyDates.map((keyDate) => keyDate.path[0]?.orbAtKeyDeg ?? 0);
    expect(Math.max(...slowOrbs)).toBeGreaterThan(0.01);
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
    // The slow tier takes all five aspects. It took the hard three, and the
    // change is recorded in src/domain/timescales.ts: an average density
    // inside the target was hiding gaps of nearly two years.
    expect(base.funnel.resolved.slow.aspects).toContain('trine');
  });

  it('scores stories with v2 by default', () => {
    for (const story of base.stories) {
      expect(story.scoringVersion).toBe('v2');
      expect(story.strength).toBeDefined();
    }
  });
});

describe('every story carries its configuration, not only its name', () => {
  /**
   * The signature is the handle a name hangs on. Naming lives outside the
   * engine — a lookup service or a model keyed on this string — so the engine
   * has to emit something two different people's charts can agree on, and
   * nothing that only makes sense next to one of them.
   */

  it('spells the aspect and both member sides, and nothing else', () => {
    expect(base.stories.length).toBeGreaterThan(0);

    for (const story of base.stories) {
      expect(story.signature.startsWith(`${story.aspect}:`)).toBe(true);

      const [sideA, sideB, ...extra] = story.signature
        .slice(story.aspect.length + 1)
        .split('|')
        .map((side) => side.split('+'));

      expect(extra).toEqual([]);
      expect(sideA).toBeDefined();
      expect(sideB).toBeDefined();
      // Every member, exactly once, split across the two sides.
      expect([...(sideA ?? []), ...(sideB ?? [])].sort()).toEqual([...story.members].sort());
      // Sorted within a side and between the sides, so the configuration has
      // one spelling rather than several.
      expect(sideA).toEqual([...(sideA ?? [])].sort());
      expect(sideB).toEqual([...(sideB ?? [])].sort());
      expect((sideA ?? []).join('+') <= (sideB ?? []).join('+')).toBe(true);
    }
  });

  it('produces the exact string a lookup would be keyed on', () => {
    // Moon fused with the true Node, square Chiron: the reference chart's
    // configuration, written the one way it can be written.
    expect(base.stories.map((story) => story.signature)).toContain('square:chiron|moon+trueNode');
  });

  it('gives two stories in one chart two different signatures', () => {
    const signatures = base.stories.map((story) => story.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('an unknown birth hour, degraded honestly', () => {
  it('accepts a date with no hour and declares what it assumed', () => {
    expect(assumed.birthTime).toBeDefined();
    expect(assumed.birthTime?.assumed).toBe(true);
    expect(assumed.birthTime?.assumedLocal).toEqual({ hour: 3, minute: 0, zone: 'Europe/Rome' });
    expect(assumed.birthTime?.basis).toBe('spontaneous-birth-peak');
    // The assumption picks the likeliest hour; the uncertainty is still a day.
    expect(assumed.birthTime?.uncertaintyHours).toBe(24);
    expect(assumed.stories.length).toBeGreaterThan(0);
  });

  it('flags the stories the unknown hour actually puts in question', () => {
    // The Moon moves ~0.5 deg/hour, so ±12 hours is ±6 degrees — wider than
    // any orb that forms a story. The angles turn a full circle.
    const sensitive = ['moon', 'ascendant', 'midheaven'];

    const flagged = assumed.stories.filter((story) => story.timeSensitive === true);
    const unflagged = assumed.stories.filter((story) => story.timeSensitive === false);

    expect(flagged.length).toBeGreaterThan(0);
    expect(unflagged.length).toBeGreaterThan(0);

    for (const story of flagged) {
      expect(story.members.some((member) => sensitive.includes(member))).toBe(true);
    }
    for (const story of unflagged) {
      expect(story.members.some((member) => sensitive.includes(member))).toBe(false);
    }
  });

  it('says nothing at all when the birth time is known', () => {
    // Not `timeSensitive: false` everywhere: with a real hour nothing is
    // uncertain, and a false here would read as a property of the story rather
    // than of the request.
    expect(base.birthTime).toBeUndefined();
    for (const story of base.stories) {
      expect(story).not.toHaveProperty('timeSensitive');
    }
  });

  it('keeps the key dates themselves whole', () => {
    // The funnel is unaffected by where the hour came from: same three tiers,
    // same story references.
    const storyIds = new Set(assumed.stories.map((story) => story.id));
    for (const keyDate of assumed.keyDates) {
      expect(keyDate.path.map((step) => step.tier)).toEqual(['slow', 'social', 'fast']);
      expect(storyIds.has(keyDate.storyId)).toBe(true);
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
