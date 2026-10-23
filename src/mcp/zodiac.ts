/**
 * Sign labels for the MCP surface, and only for it.
 *
 * `/v1` carries numbers and identifiers and nothing else; rendering is each
 * frontend's job, and a contract test fails if a `sign` or `formatted` key ever
 * reappears there. Over MCP the frontend is a language model, and turning
 * 139.1557 into "19°09′ Leo" is a small piece of arithmetic that models get
 * wrong often enough to matter. The engine already owns that arithmetic, so the
 * label is computed here — through src/math/angle.ts, like every other angle in
 * this codebase — and never left to the reader. See ADR 0006.
 *
 * The fields are named one by one, per response, and never found by walking
 * for any key called `lon`. A chart carries `geo.lon`, which is a terrestrial
 * longitude, and `angles.armc`, which is a right ascension; a walker would hand
 * both of them a zodiac sign.
 */

import { degreesInSign, signIndex } from '../math/angle.js';

/** English, as identifiers are: Claude translates them as it writes. */
const SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

/**
 * An ecliptic longitude as degree, minute and sign: 139.1557 → "19°09′ Leo".
 *
 * Minutes are truncated, never rounded. Rounding 29.9999° would print
 * "29°60′ Pisces", and carrying it would print "0°00′ Aries" for a body that
 * has not yet left Pisces — truncation is the only version that never names
 * the wrong sign.
 */
export function zodiacLabel(longitude: number): string {
  // Whole arcminutes into the sign, nudged by a hundred-millionth of one
  // before truncating: 75.1 is 15.099999999999994 within its sign as a double,
  // and truncating that printed 15°05′ for a longitude that is exactly 15°06′.
  // The clamp stops the nudge from carrying the last sliver of a sign into a
  // "30°00′" that names the wrong one.
  const arcminutes = Math.min(Math.floor(degreesInSign(longitude) * 60 + 1e-8), 30 * 60 - 1);
  const degrees = Math.floor(arcminutes / 60);
  const minutes = arcminutes - degrees * 60;
  // Total by construction: signIndex is 0..11 for every real input.
  const sign = SIGNS[signIndex(longitude)] ?? SIGNS[0];
  return `${String(degrees)}°${String(minutes).padStart(2, '0')}′ ${sign}`;
}

/** A side of a story: a conjunct cluster and its longitude. */
interface StorySide {
  readonly lon: number;
}

/** One tier of a key-date path, where the transiting body stood at the peak. */
interface PathStep {
  readonly lonAtKey: number;
}

interface Story {
  readonly a: StorySide;
  readonly b: StorySide;
}

interface Window {
  readonly path: readonly PathStep[];
}

/** The part of a POST /v1/charts body that carries ecliptic longitudes. */
export interface ChartBody {
  readonly bodies: readonly { readonly lon: number }[];
  readonly angles: {
    readonly ascendant: number;
    readonly midheaven: number;
    readonly vertex: number;
    readonly equatorialAscendant: number;
  };
  readonly houses: { readonly cusps: readonly number[] };
}

function side<T extends StorySide>(value: T): T & { zodiac: string } {
  return { ...value, zodiac: zodiacLabel(value.lon) };
}

function story<T extends Story>(value: T): T {
  return { ...value, a: side(value.a), b: side(value.b) };
}

function window<T extends Window>(value: T): T {
  return {
    ...value,
    path: value.path.map((step) => ({ ...step, zodiacAtKey: zodiacLabel(step.lonAtKey) })),
  };
}

/**
 * POST /v1/charts. `armc` is left alone: it is measured along the equator, and
 * a sign attached to it would be a sign for a number that has none.
 */
export function annotateChart<T extends ChartBody>(chart: T): T {
  const { angles } = chart;
  return {
    ...chart,
    bodies: chart.bodies.map((body) => ({ ...body, zodiac: zodiacLabel(body.lon) })),
    angles: {
      ...angles,
      zodiac: {
        ascendant: zodiacLabel(angles.ascendant),
        midheaven: zodiacLabel(angles.midheaven),
        vertex: zodiacLabel(angles.vertex),
        equatorialAscendant: zodiacLabel(angles.equatorialAscendant),
      },
    },
    houses: { ...chart.houses, zodiac: chart.houses.cusps.map(zodiacLabel) },
  };
}

/** The part of a POST /v1/transits/key-dates body that carries longitudes. */
export interface KeyDatesBody {
  readonly stories: readonly Story[];
  readonly keyDates: readonly Window[];
}

/** The part of a POST /v1/transits/story-windows body that carries longitudes. */
export interface StoryWindowsBody {
  readonly story: Story;
  readonly windows: readonly Window[];
}

/** POST /v1/transits/key-dates. */
export function annotateKeyDates<T extends KeyDatesBody>(body: T): T {
  return { ...body, stories: body.stories.map(story), keyDates: body.keyDates.map(window) };
}

/** POST /v1/transits/story-windows. */
export function annotateStoryWindows<T extends StoryWindowsBody>(body: T): T {
  return { ...body, story: story(body.story), windows: body.windows.map(window) };
}
