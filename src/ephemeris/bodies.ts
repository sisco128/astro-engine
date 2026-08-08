/**
 * The catalogue of bodies this engine will compute — an explicit allowlist,
 * not a passthrough.
 *
 * This is not bureaucracy. Measured against sweph 2.10.03: passing an
 * unrecognised body id (9999) does NOT fail. It returns flag 1048834, an
 * empty error string, and a perfectly plausible longitude of 251.455 degrees.
 * A typo in a body id would therefore produce confident nonsense rather than
 * an error, and no downstream test would notice. The only defence is refusing
 * ids that are not on this list.
 *
 * `minJdUt` / `maxJdUt` record per-body validity where Swiss Ephemeris imposes
 * one. Chiron is the live case: outside JD 1967601.5 .. 3419437.5 swe_calc_ut
 * returns flag -1 with "Chiron's ephemeris is restricted to ...".
 */

export const BODY_IDS = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
  'trueNode',
  'meanNode',
  'lilith',
  'chiron',
] as const;

export type BodyId = (typeof BODY_IDS)[number];

export interface BodyMeta {
  /** Swiss Ephemeris numeric constant. */
  readonly se: number;
  /** Human-facing name. Presentation is the frontend's job; this is for /v1/meta only. */
  readonly name: string;
  /** Whether the body can appear retrograde. The Sun and Moon never do. */
  readonly retrogradable: boolean;
  /** Maximum apparent geocentric longitude speed, deg/day. Sets the transit scan step. */
  readonly maxSpeedDegPerDay: number;
  readonly minJdUt?: number;
  readonly maxJdUt?: number;
}

export const BODIES: Readonly<Record<BodyId, BodyMeta>> = {
  sun: { se: 0, name: 'Sun', retrogradable: false, maxSpeedDegPerDay: 1.02 },
  moon: { se: 1, name: 'Moon', retrogradable: false, maxSpeedDegPerDay: 15.4 },
  mercury: { se: 2, name: 'Mercury', retrogradable: true, maxSpeedDegPerDay: 2.3 },
  venus: { se: 3, name: 'Venus', retrogradable: true, maxSpeedDegPerDay: 1.3 },
  mars: { se: 4, name: 'Mars', retrogradable: true, maxSpeedDegPerDay: 0.8 },
  jupiter: { se: 5, name: 'Jupiter', retrogradable: true, maxSpeedDegPerDay: 0.25 },
  saturn: { se: 6, name: 'Saturn', retrogradable: true, maxSpeedDegPerDay: 0.14 },
  uranus: { se: 7, name: 'Uranus', retrogradable: true, maxSpeedDegPerDay: 0.065 },
  neptune: { se: 8, name: 'Neptune', retrogradable: true, maxSpeedDegPerDay: 0.04 },
  pluto: { se: 9, name: 'Pluto', retrogradable: true, maxSpeedDegPerDay: 0.045 },
  trueNode: { se: 11, name: 'True Node', retrogradable: true, maxSpeedDegPerDay: 0.25 },
  meanNode: { se: 10, name: 'Mean Node', retrogradable: true, maxSpeedDegPerDay: 0.06 },
  lilith: { se: 12, name: 'Mean Lilith', retrogradable: false, maxSpeedDegPerDay: 0.12 },
  chiron: {
    se: 15,
    name: 'Chiron',
    retrogradable: true,
    maxSpeedDegPerDay: 0.15,
    minJdUt: 1967601.5,
    maxJdUt: 3419437.5,
  },
};

/**
 * The default set for a natal chart.
 *
 * The prototype computed nine bodies (Sun..Neptune) and deliberately skipped
 * Pluto even though it was in its PLANETS table, along with the nodes, Lilith
 * and Chiron. There was no stated reason; it looks like an oversight that
 * ossified.
 */
export const DEFAULT_BODIES: readonly BodyId[] = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
  'trueNode',
  'chiron',
];

export function isBodyId(value: unknown): value is BodyId {
  return typeof value === 'string' && (BODY_IDS as readonly string[]).includes(value);
}
