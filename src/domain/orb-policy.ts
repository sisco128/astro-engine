/**
 * The single source of aspect definitions and orbs.
 *
 * The prototype had seven copies. Five named tables in utils/aspects.js
 * (natal, transit, layer1 archetypal, layer1 cyclic, layer2), plus two inline
 * duplicates: natal-aspects.js:22-27 redefined the natal table rather than
 * importing it, and themes.js:296-301 did the same again. Nothing kept them in
 * step; they were simply the same numbers typed three times.
 *
 * Policies are named and versioned because they are a published contract:
 * /v1/meta/aspects serves this file, and a frontend that draws an aspect grid
 * needs to know which orbs produced it.
 */

/** Angles are exact; orbs vary by policy. */
export const ASPECTS = {
  conjunction: { angle: 0, harmonic: 1, symmetric: true },
  opposition: { angle: 180, harmonic: 2, symmetric: true },
  trine: { angle: 120, harmonic: 3, symmetric: false },
  square: { angle: 90, harmonic: 4, symmetric: false },
  sextile: { angle: 60, harmonic: 6, symmetric: false },
  quincunx: { angle: 150, harmonic: 12, symmetric: false },
  semisextile: { angle: 30, harmonic: 12, symmetric: false },
  semisquare: { angle: 45, harmonic: 8, symmetric: false },
  sesquiquadrate: { angle: 135, harmonic: 8, symmetric: false },
} as const;

export type AspectId = keyof typeof ASPECTS;

export const ASPECT_IDS = Object.keys(ASPECTS) as AspectId[];

/**
 * A policy maps an aspect to the orb, in degrees, within which it counts.
 * An aspect absent from a policy is not considered at all — which is how the
 * prototype's Layer 1 Cyclic table excluded the trine.
 */
export type OrbPolicy = Partial<Record<AspectId, number>>;

export const ORB_POLICIES = {
  /**
   * Natal aspects. The four orbs are the prototype's exact values
   * (utils/aspects.js:5-10).
   *
   * The sextile is NEW. The prototype had no sextile anywhere — despite
   * full-transit-calculator.js:34 defining a 60-degree angle that nothing
   * could ever produce. 5 degrees sits proportionally between its square (6)
   * and its trine (7) relative to conventional practice; it is a judgement,
   * not a value inherited from the old code, and it is called out here so
   * nobody mistakes it for one.
   */
  'natal.default': {
    conjunction: 10,
    opposition: 8,
    trine: 7,
    square: 6,
    sextile: 5,
  },

  /**
   * The prototype's natal set, exactly. Kept so theme scores can be compared
   * against the old implementation without the sextile changing the result.
   */
  'natal.v1': {
    conjunction: 10,
    opposition: 8,
    trine: 7,
    square: 6,
  },

  /** utils/aspects.js:16-21. */
  'transit.default': {
    conjunction: 5,
    opposition: 4,
    trine: 3,
    square: 3,
  },

  /** utils/aspects.js:27-32. One degree, the prototype's note says to match Astro Gold. */
  'layer1.archetypal': {
    conjunction: 1,
    opposition: 1,
    trine: 1,
    square: 1,
  },

  /**
   * utils/aspects.js:38-42.
   *
   * Deliberately has no trine — a body returning to its own natal position is
   * tracked at the conjunction (the return), opposition and square only. The
   * prototype labelled the conjunction "Return"; that is presentation, so the
   * aspect keeps its real name here.
   */
  'layer1.cyclic': {
    conjunction: 1,
    opposition: 1,
    square: 1,
  },

  /** utils/aspects.js:48-53. */
  'layer2.default': {
    conjunction: 1,
    opposition: 1,
    trine: 1,
    square: 1,
  },
} as const satisfies Record<string, OrbPolicy>;

export type OrbPolicyId = keyof typeof ORB_POLICIES;

export const ORB_POLICY_IDS = Object.keys(ORB_POLICIES) as OrbPolicyId[];

export function orbPolicy(id: OrbPolicyId): OrbPolicy {
  return ORB_POLICIES[id];
}
