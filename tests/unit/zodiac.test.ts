/**
 * The sign labels the MCP surface adds next to ecliptic longitudes.
 *
 * The edges are the point. The prototype's `degreesToSign` never normalised,
 * so 360 produced SIGNS[12] — undefined — and a rounding label prints
 * "29°60′" or moves a body into a sign it has not reached. Every case below is
 * one of those, asserted.
 */

import { describe, expect, it } from 'vitest';

import { annotateChart, annotateKeyDates, zodiacLabel } from '../../src/mcp/zodiac.js';

describe('zodiacLabel', () => {
  it('labels the reference Sun', () => {
    // 12 Aug 1987, Rome: the Sun at 139.1556628718923.
    expect(zodiacLabel(139.1556628718923)).toBe('19°09′ Leo');
  });

  it('starts the zodiac at 0°00′ Aries', () => {
    expect(zodiacLabel(0)).toBe('0°00′ Aries');
  });

  it('truncates the minutes, so the last arcsecond of a sign stays in it', () => {
    expect(zodiacLabel(29.9999)).toBe('29°59′ Aries');
    expect(zodiacLabel(359.9999)).toBe('29°59′ Pisces');
  });

  it('does not lose a minute to the binary form of a decimal', () => {
    // 75.1 is 15.099999999999994 within Gemini as a double; plain truncation
    // printed 15°05′.
    expect(zodiacLabel(75.1)).toBe('15°06′ Gemini');
    expect(zodiacLabel(10.1)).toBe('10°06′ Aries');
  });

  it('never prints a thirtieth degree, however close to the next sign', () => {
    expect(zodiacLabel(59.99999999999999)).toBe('29°59′ Taurus');
  });

  it('puts a cusp in the sign that begins there', () => {
    expect(zodiacLabel(30)).toBe('0°00′ Taurus');
    expect(zodiacLabel(330)).toBe('0°00′ Pisces');
  });

  it('normalises angles outside [0, 360)', () => {
    expect(zodiacLabel(360)).toBe('0°00′ Aries');
    expect(zodiacLabel(-0.5)).toBe('29°30′ Pisces');
    expect(zodiacLabel(725.25)).toBe('5°15′ Aries');
  });

  it('pads the minutes but not the degrees', () => {
    expect(zodiacLabel(245.0834)).toBe('5°05′ Sagittarius');
  });
});

describe('annotateChart', () => {
  const chart = {
    geo: { lat: 41.9028, lon: 12.4964 },
    bodies: [{ id: 'sun', lon: 139.1556628718923, house: 10 }],
    angles: {
      ascendant: 220.5,
      midheaven: 130.25,
      armc: 132.7,
      vertex: 75.1,
      equatorialAscendant: 222.0,
    },
    houses: {
      system: 'P',
      cusps: [220.5, 250, 280, 310, 340, 10, 40.5, 70, 100, 130.25, 160, 190],
    },
  };

  const annotated = annotateChart(chart);

  it('labels every body next to its longitude, and keeps the number', () => {
    expect(annotated.bodies[0]).toEqual({
      id: 'sun',
      lon: 139.1556628718923,
      zodiac: '19°09′ Leo',
      house: 10,
    });
  });

  it('labels the four ecliptic angles and not the right ascension', () => {
    expect(annotated.angles).toMatchObject({
      zodiac: {
        ascendant: '10°30′ Scorpio',
        midheaven: '10°15′ Leo',
        vertex: '15°06′ Gemini',
        equatorialAscendant: '12°00′ Scorpio',
      },
    });
    expect(annotated.angles).not.toHaveProperty('zodiac.armc');
  });

  it('labels all twelve cusps in order', () => {
    expect(annotated.houses).toHaveProperty('zodiac.length', 12);
    expect(annotated.houses).toHaveProperty(['zodiac', 0], '10°30′ Scorpio');
    expect(annotated.houses).toHaveProperty(['zodiac', 5], '10°00′ Aries');
  });

  it('leaves the terrestrial longitude alone', () => {
    expect(annotated.geo).toEqual({ lat: 41.9028, lon: 12.4964 });
  });

  it('does not touch its input', () => {
    expect(chart.bodies[0]).not.toHaveProperty('zodiac');
    expect(chart.angles).not.toHaveProperty('zodiac');
  });
});

describe('annotateKeyDates', () => {
  it('labels both sides of each story and where each transiting body stood', () => {
    const annotated = annotateKeyDates({
      stories: [
        {
          id: 's1',
          a: { members: ['sun'], lon: 137.3657 },
          b: { members: ['saturn'], lon: 258.7307 },
        },
      ],
      keyDates: [{ storyId: 's1', path: [{ tier: 'slow', body: 'neptune', lonAtKey: 359.9244 }] }],
    });

    expect(annotated.stories[0]?.a).toEqual({
      members: ['sun'],
      lon: 137.3657,
      zodiac: '17°21′ Leo',
    });
    expect(annotated.stories[0]?.b).toMatchObject({ zodiac: '18°43′ Sagittarius' });
    expect(annotated.keyDates[0]?.path[0]).toEqual({
      tier: 'slow',
      body: 'neptune',
      lonAtKey: 359.9244,
      zodiacAtKey: '29°55′ Pisces',
    });
  });
});
