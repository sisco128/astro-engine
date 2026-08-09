/**
 * The one link between the manifest and the config module that validates
 * against a copy of its profile names.
 *
 * `src/config/env.ts` deliberately does not read ephemeris.manifest.json —
 * it is the codebase's one place that touches process.env, and reading a
 * file there for a value used only in the readiness report was not worth
 * blurring that boundary. Adding `bounds` to the manifest without adding it
 * here is exactly what shipped: CI failed with "EPHEMERIS_PROFILE must be
 * one of core, full, got: bounds" because the two lists had drifted.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EPHEMERIS_PROFILES } from '../../src/config/env.js';

describe('EPHEMERIS_PROFILE validation stays in step with the manifest', () => {
  it('accepts every profile the manifest defines', () => {
    const manifest = JSON.parse(readFileSync('ephemeris.manifest.json', 'utf8')) as {
      profiles: Record<string, unknown>;
    };

    const missing = Object.keys(manifest.profiles).filter(
      (name) => !(EPHEMERIS_PROFILES as readonly string[]).includes(name),
    );

    expect(missing).toEqual([]);
  });
});
