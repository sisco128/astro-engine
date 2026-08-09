/**
 * Contract tests for POST /v1/transits/story-windows.
 *
 * The endpoint answers one question — for THIS story, when was it active,
 * strongest first — and everything asserted here is a property of that
 * sentence: that the story is selected by the handle a client actually stored,
 * that the ordering is by strength and the limit is applied after it, and that
 * a signature the chart does not carry is a different answer from a story that
 * happened to be quiet.
 *
 * That the numbers agree with /v1/transits/key-dates is asserted in
 * tests/golden/story-windows.golden.test.ts, against the real ephemeris.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_PAST_DAYS,
  MAX_STORY_WINDOWS,
  resolveStorySpan,
} from '../../src/http/schemas/funnel.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

// Imported after the ephemeris path is set, like every other contract suite:
// src/config/env.ts parses the environment once, at module load.
const { buildApp } = await import('../../src/http/app.js');

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const BIRTH = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

/**
 * Moon fused with the true Node, square Chiron — a story of the reference chart,
 * asserted by name in tests/contract/key-dates.test.ts as well. Chosen over the
 * chart's strongest story because it is an ordinary one: eight windows in the
 * ten years to 2026 rather than thirty-two, which is what the endpoint is for.
 */
const STORY = 'square:chiron|moon+trueNode';

/** Ten years of the recent past, fixed rather than defaulted, so the suite is repeatable. */
const SPAN = { from: '2016-01-01', to: '2026-01-01' };

interface StoryWindowsBody {
  chartRef: string;
  birthTime?: {
    assumed: true;
    assumedLocal: { hour: number; minute: number; zone: string };
    basis: string;
    uncertaintyHours: number;
  };
  funnel: { requested: unknown; resolved: { slow: { bodies: string[] } } };
  span: { from: string; to: string; days: number };
  density: { windowsPerQuarter: number; windows: number };
  limit: number;
  story: {
    id: string;
    signature: string;
    aspect: string;
    members: string[];
    strength?: number;
    scoringVersion: string;
    timeSensitive?: boolean;
  };
  windows: {
    from: string;
    to: string;
    intensity: number;
    pathCount: number;
    path: { tier: string; body: string; member: string; exact: string; durationDays: number }[];
  }[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * The same birth with the hour unknown, over the narrowest funnel the schema
 * allows and a fraction of the span. Nothing asserted about it depends on the
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
/** One computed result, reused: even scoped to a story the funnel costs seconds. */
let base: StoryWindowsBody;
/** The same, with an unknown birth hour. */
let assumed: StoryWindowsBody;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  base = (await post({ ...BIRTH, ...SPAN, signature: STORY })).json<StoryWindowsBody>();
  assumed = (
    await post({
      ...BIRTH_NO_HOUR,
      from: '2020-01-01',
      to: '2022-01-01',
      // The unknown-hour chart is a different chart, so it has different
      // stories; this one survives the 03:00 assumption because neither member
      // is time-sensitive.
      signature: 'trine:jupiter|neptune',
    })
  ).json<StoryWindowsBody>();
}, 180_000);

afterAll(async () => {
  await app.close();
});

async function post(payload: unknown): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/transits/story-windows',
    payload: payload as object,
  });
}

describe('one story, and the past it was active in', () => {
  it('answers for the story the signature names, and echoes it back', () => {
    expect(base.story.signature).toBe(STORY);
    expect(base.story.aspect).toBe('square');
    expect([...base.story.members].sort()).toEqual(['chiron', 'moon', 'trueNode']);
    // The per-chart id is returned too: a client that came from a key-dates
    // response can line the two up without recomputing anything.
    expect(base.story.id).toContain('square');
  });

  it('returns windows entirely inside the requested span', () => {
    expect(base.windows.length).toBeGreaterThan(0);

    for (const window of base.windows) {
      expect(window.from >= SPAN.from).toBe(true);
      expect(window.to <= `${SPAN.to}T00:00:00.000Z`).toBe(true);
    }
  });

  it('carries the whole slow-social-fast path on every window', () => {
    // The same chain key-dates returns, and for the same reason: a Jupiter
    // resonance means one thing inside a Neptune window and another inside a
    // Pluto window, so a client is given the route rather than the leaf.
    for (const window of base.windows) {
      expect(window.path.map((step) => step.tier)).toEqual(['slow', 'social', 'fast']);
      for (const step of window.path) {
        expect(base.story.members).toContain(step.member);
        expect(step.durationDays).toBeGreaterThan(0);
      }
    }
  });

  it('reports this story alone, not the chart', () => {
    // density.windows is the count for this story over this span. The chart as
    // a whole produces several times that; if this endpoint were reporting the
    // chart's density the number would not match its own window list.
    expect(base.density.windows).toBeGreaterThanOrEqual(base.windows.length);
    const quarters = (base.span.days / 365.25) * 4;
    expect(base.density.windowsPerQuarter).toBeCloseTo(base.density.windows / quarters, 4);
  });
});

describe('strongest first, then the top N', () => {
  it('orders by descending intensity', () => {
    const intensities = base.windows.map((window) => window.intensity);
    expect(intensities).toEqual([...intensities].sort((a, b) => b - a));
  });

  it('breaks the ties intensity cannot, since inside one story it is constant', () => {
    // Every path of a story carries that story's own strength as its intensity,
    // so all of one story's windows tie on it. The documented tiebreak is path
    // count, then recency — and without one the "top three" would be whatever
    // order the funnel emitted.
    expect(new Set(base.windows.map((window) => window.intensity)).size).toBe(1);

    for (let i = 1; i < base.windows.length; i += 1) {
      const previous = base.windows[i - 1];
      const current = base.windows[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous === undefined || current === undefined) continue;

      expect(previous.pathCount).toBeGreaterThanOrEqual(current.pathCount);
      if (previous.pathCount === current.pathCount) {
        expect(previous.from >= current.from).toBe(true);
      }
    }
  });

  it('defaults to the three the onboarding asks about', () => {
    expect(base.limit).toBe(3);
    expect(base.windows).toHaveLength(Math.min(3, base.density.windows));
    // The story has to have more to say than the three returned, or the limit
    // is not being exercised at all.
    expect(base.density.windows).toBeGreaterThan(3);
  });

  it('sorts before it slices', async () => {
    // The assertion that catches the inverted implementation. Asking for
    // everything and asking for three must agree on which three come first; a
    // slice-then-sort would return the three earliest, reordered.
    const all = await post({
      ...BIRTH,
      ...SPAN,
      signature: STORY,
      limit: MAX_STORY_WINDOWS,
    });

    expect(all.statusCode).toBe(200);
    const full = all.json<StoryWindowsBody>();

    expect(full.windows).toHaveLength(full.density.windows);
    expect(full.windows.slice(0, 3).map((window) => window.from)).toEqual(
      base.windows.map((window) => window.from),
    );
  });

  it('refuses a limit outside its bounds rather than clamping', async () => {
    for (const limit of [0, -1, MAX_STORY_WINDOWS + 1, 2.5]) {
      const response = await post({ ...BIRTH, ...SPAN, signature: STORY, limit });
      expect(response.statusCode, `limit ${String(limit)}`).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('a signature the chart does not carry', () => {
  it('answers 404 with a code of its own, not an empty 200', async () => {
    // An empty window list is a real answer here — it means the story was
    // quiet — so "this chart has no such story" must not be spelled the same
    // way. It is the difference between "nothing happened" and "wrong chart".
    const response = await post({
      ...BIRTH,
      ...SPAN,
      signature: 'square:betelgeuse|nibiru',
    });

    expect(response.statusCode).toBe(404);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('STORY_NOT_IN_CHART');
    expect(error.details?.['signature']).toBe('square:betelgeuse|nibiru');
  });

  it('lists the signatures the chart does carry, so a stale one is recoverable', async () => {
    const response = await post({ ...BIRTH, ...SPAN, signature: 'trine:nothing|here' });
    const signatures = response.json<ErrorBody>().error.details?.['signatures'];

    expect(Array.isArray(signatures)).toBe(true);
    expect(signatures).toContain(STORY);
  });

  it('distinguishes it from a story that simply had a quiet span', async () => {
    // The same real story over a span too narrow for any of its windows: 200,
    // an empty list, and a density of zero. Same endpoint, same story, opposite
    // meaning to the 404 above.
    const response = await post({
      ...BIRTH,
      from: '2020-01-01',
      to: '2020-01-08',
      signature: STORY,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<StoryWindowsBody>();
    expect(body.windows).toEqual([]);
    expect(body.density.windows).toBe(0);
    expect(body.story.signature).toBe(STORY);
  });
});

describe('the span, when nobody names one', () => {
  it('resolves to the ten years ending today', () => {
    // Asserted against a fixed instant rather than against the clock, so the
    // test says what the rule is instead of recomputing it.
    const fixed = Date.UTC(2026, 7, 9);
    expect(resolveStorySpan({}, fixed)).toEqual({ from: '2016-08-11', to: '2026-08-09' });
    expect(DEFAULT_PAST_DAYS).toBe(3650);
  });

  it('walks the whole span back from a `to` that was named', () => {
    // Not "ten years before today, ending at `to`", which for any `to` in the
    // past would produce a span running backwards.
    // 3650 days rather than ten calendar years, so the walk back from 2000
    // lands on the 3rd and not the 1st: the default is a span, not an anniversary.
    expect(resolveStorySpan({ to: '2000-01-01' }, Date.UTC(2026, 7, 9))).toEqual({
      from: '1990-01-03',
      to: '2000-01-01',
    });
  });

  it('accepts a request that names neither end', async () => {
    const response = await post({
      ...BIRTH_NO_HOUR,
      signature: 'trine:jupiter|neptune',
      limit: 1,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<StoryWindowsBody>();
    // The span is asserted by its length rather than against the clock — the
    // rule itself is pinned to a fixed instant in the two tests above, and
    // comparing `to` against `new Date()` here would fail on the one run that
    // straddles UTC midnight.
    expect(body.span.days).toBe(DEFAULT_PAST_DAYS);
    expect(body.span.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.span.from < body.span.to).toBe(true);
  }, 60_000);
});

describe('an unknown birth hour, degraded honestly', () => {
  it('accepts a date with no hour and declares what it assumed', () => {
    expect(assumed.birthTime?.assumed).toBe(true);
    expect(assumed.birthTime?.assumedLocal).toEqual({ hour: 3, minute: 0, zone: 'Europe/Rome' });
    expect(assumed.birthTime?.basis).toBe('spontaneous-birth-peak');
    // The assumption picks the likeliest hour; the uncertainty is still a day.
    expect(assumed.birthTime?.uncertaintyHours).toBe(24);
  });

  it('says whether the assumed hour puts this story in question', () => {
    // Jupiter and Neptune both move too slowly for a 24-hour uncertainty to
    // matter, so this story is answerable despite the unknown hour — which is
    // exactly what the flag is for.
    expect(assumed.story.timeSensitive).toBe(false);
    expect(assumed.story.signature).toBe('trine:jupiter|neptune');
  });

  it('says nothing at all when the birth time is known', () => {
    expect(base.birthTime).toBeUndefined();
    expect(base.story).not.toHaveProperty('timeSensitive');
  });
});

describe('the result cache', () => {
  it('serves a repeat of the same question from the cache', async () => {
    // The span here is deliberately not the one beforeAll computed: this has to
    // observe its own miss before its own hit, or a hit would prove nothing.
    const payload = { ...BIRTH, from: '2021-03-01', to: '2023-03-01', signature: STORY };

    const first = await post(payload);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');

    const second = await post(payload);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json<StoryWindowsBody>().windows).toEqual(first.json<StoryWindowsBody>().windows);
  }, 60_000);

  it('serves a different limit over the same span from the same entry', async () => {
    // The limit is applied after the cache, not baked into the key: a client
    // that asks for one more window must not pay for the funnel twice.
    const response = await post({
      ...BIRTH,
      from: '2021-03-01',
      to: '2023-03-01',
      signature: STORY,
      limit: 5,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache']).toBe('hit');
  });
});

describe('bounds and validation', () => {
  it('refuses a span longer than the engine will compute', async () => {
    const response = await post({
      ...BIRTH,
      from: '2000-01-01',
      to: '2500-01-01',
      signature: STORY,
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('WINDOW_TOO_LARGE');
    expect(error.details?.['maxDays']).toBeDefined();
  });

  it('refuses a span that runs backwards', async () => {
    const response = await post({
      ...BIRTH,
      from: '2026-01-01',
      to: '2016-01-01',
      signature: STORY,
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires a signature at all', async () => {
    const response = await post({ ...BIRTH, ...SPAN });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await post({ ...BIRTH, ...SPAN, signature: STORY, storyId: 'x' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown funnel preset by name', async () => {
    const response = await post({
      ...BIRTH,
      ...SPAN,
      signature: STORY,
      funnel: 'funnel.doesnotexist',
    });
    expect(response.statusCode).toBe(400);
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
