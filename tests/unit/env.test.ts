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

import { EPHEMERIS_PROFILES, MIN_URL_TOKEN_LENGTH, parseUrlTokens } from '../../src/config/env.js';

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

describe('MCP_URL_TOKENS validation', () => {
  const VALID = 'abcdefghijklmnopqrstuvwxyz0123456789_-';

  it('accepts base64url tokens of at least the minimum length', () => {
    expect(parseUrlTokens([VALID, 'A'.repeat(MIN_URL_TOKEN_LENGTH)])).toEqual([
      VALID,
      'A'.repeat(MIN_URL_TOKEN_LENGTH),
    ]);
  });

  it('accepts none at all, which leaves the route unmounted', () => {
    expect(parseUrlTokens([])).toEqual([]);
  });

  it('refuses to start on a token one character short', () => {
    expect(() => parseUrlTokens(['A'.repeat(MIN_URL_TOKEN_LENGTH - 1)])).toThrow(/at least 32/);
  });

  it('refuses a token that would need encoding in a URL', () => {
    // A `/` would split the path; `+` and `=` are the base64 characters that
    // base64url exists to avoid.
    expect(() => parseUrlTokens([`${'A'.repeat(32)}/x`])).toThrow(/MCP_URL_TOKENS/);
    expect(() => parseUrlTokens([`${'A'.repeat(32)}+=`])).toThrow(/MCP_URL_TOKENS/);
  });

  it('refuses the whole list when one entry is bad, not just that entry', () => {
    expect(() => parseUrlTokens([VALID, 'short'])).toThrow(/MCP_URL_TOKENS/);
  });
});
