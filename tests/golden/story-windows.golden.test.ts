/**
 * The one assertion that stops /v1/transits/story-windows becoming a second
 * funnel.
 *
 * The endpoint exists to be cheap: it passes one story to buildFunnel instead
 * of all of them, which on the reference chart over ten years is 1.4 seconds
 * against 9.5 — 86% of the work not done. That saving is only legitimate while
 * the answer is the same answer. Nothing in the type system says so; the two
 * routes assemble their responses separately, and a change to the ordering, the
 * clustering or the path mapping in one of them would go unnoticed until a
 * client showed a user two different dates for the same window.
 *
 * So both routes are called over the same chart, the same span and the same
 * funnel, through the real HTTP surface and the real ephemeris, and the windows
 * are compared field for field. The cost — one full-chart key-dates run — is
 * exactly what the endpoint avoids paying at runtime, spent once here.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_STORY_WINDOWS } from '../../src/http/schemas/funnel.js';
import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../../src/http/app.js');

/** 12 Aug 1987, 11:32 CEST Rome — the chart every preset was tuned against. */
const BIRTH = {
  when: { local: { year: 1987, month: 8, day: 12, hour: 11, minute: 32, zone: 'Europe/Rome' } },
  geo: { lat: 41.9028, lon: 12.4964 },
};

/** Ten years of the recent past: the endpoint's own default span, pinned. */
const SPAN = { from: '2016-01-01', to: '2026-01-01' };

/**
 * Every story of the reference chart, written out.
 *
 * A list rather than whatever the key-dates response happens to return, so that
 * a chart which grows or loses a story fails here instead of quietly narrowing
 * what the agreement was checked over.
 */
const SIGNATURES = [
  'trine:mars+mercury+sun+venus|saturn+uranus',
  'square:moon+trueNode|neptune',
  'trine:jupiter|neptune',
  'square:chiron|moon+trueNode',
  'opposition:jupiter|pluto',
  'square:jupiter|midheaven',
  'trine:ascendant|chiron',
] as const;

interface Window {
  from: string;
  to: string;
  intensity: number;
  pathCount: number;
  path: Record<string, unknown>[];
}

interface KeyDatesBody {
  stories: { id: string; signature: string }[];
  keyDates: (Window & { storyId: string })[];
}

interface StoryWindowsBody {
  story: { id: string; signature: string };
  density: { windows: number };
  windows: Window[];
}

let app: FastifyInstance;
let keyDates: KeyDatesBody;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const response = await app.inject({
    method: 'POST',
    url: '/v1/transits/key-dates',
    payload: { ...BIRTH, ...SPAN },
  });
  expect(response.statusCode).toBe(200);
  keyDates = response.json<KeyDatesBody>();
}, 300_000);

afterAll(async () => {
  await app.close();
});

async function storyWindows(signature: string): Promise<StoryWindowsBody> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/transits/story-windows',
    // The ceiling, not the default of 3: the claim under test is about the
    // whole window list, and a limit would hide any disagreement past the third.
    payload: { ...BIRTH, ...SPAN, signature, limit: MAX_STORY_WINDOWS },
  });
  expect(response.statusCode, `story-windows for ${signature}`).toBe(200);
  return response.json<StoryWindowsBody>();
}

/** By date, so two lists ordered on different keys can be compared. */
function byDate(windows: readonly Window[]): Window[] {
  return [...windows]
    .map((window) => ({
      from: window.from,
      to: window.to,
      intensity: window.intensity,
      pathCount: window.pathCount,
      path: window.path,
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

describe('the scoped funnel and the full funnel agree', () => {
  it('finds the same stories in the chart at all', () => {
    // The precondition for everything below: both routes identify stories from
    // the same chart with the same scoring, so a signature that names a story
    // on one has to name it on the other.
    expect(keyDates.stories.length).toBeGreaterThan(0);
    expect(keyDates.stories.map((story) => story.signature)).toContain(
      'square:chiron|moon+trueNode',
    );
  });

  // Every story on the chart, not a chosen one. Seven scoped runs cost more
  // than the one full run they are compared against — the memo in
  // src/transits/funnel.ts is what makes a full run cheap, and a scoped call
  // cannot share a Mars scan with another scoped call — but a single story
  // would only prove the two routes agree about a story, not about a mechanism.
  for (const signature of SIGNATURES) {
    it(`returns exactly the key-dates windows for ${signature}`, async () => {
      const story = keyDates.stories.find((candidate) => candidate.signature === signature);
      expect(story, `${signature} is not a story of the reference chart`).toBeDefined();
      if (story === undefined) return;

      const scoped = await storyWindows(signature);

      // Same story, reached by signature rather than by the per-chart id.
      expect(scoped.story.id).toBe(story.id);

      const expected = keyDates.keyDates.filter((window) => window.storyId === story.id);

      // Not merely the same count: the same windows, with the same
      // slow/social/fast paths, the same instants and the same intensities.
      expect(scoped.density.windows).toBe(expected.length);
      expect(scoped.windows).toHaveLength(expected.length);
      expect(byDate(scoped.windows)).toEqual(byDate(expected));
    }, 120_000);
  }

  it('covers every story the chart actually has', () => {
    // The other direction. The per-story assertions above would all pass while
    // silently checking six stories out of seven; this is what fails if the
    // chart grows one nobody added to SIGNATURES.
    expect(new Set(keyDates.stories.map((story) => story.signature))).toEqual(new Set(SIGNATURES));
    expect(keyDates.keyDates.length).toBeGreaterThan(0);
  });
});
