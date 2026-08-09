/**
 * The production posture: NODE_ENV=production with no API_KEYS must not start.
 *
 * The failure this prevents is the quiet one. A deploy that drops a single
 * environment variable comes up, binds, passes its readiness probe and serves
 * every endpoint to anyone who finds the host — indistinguishable from a
 * correct deployment until someone notices. Nothing about an open API looks
 * broken, so the check has to happen where it can still stop the process.
 *
 * `NODE_ENV` is set before the dynamic import for the usual reason: env.ts
 * parses once at load. That also means this process can watch `buildApp()`
 * take exactly one of the four paths through the check, which is why the
 * other three are asserted against the exported predicate instead.
 */

import { describe, expect, it } from 'vitest';

import { useRepoEphemeris } from '../helpers/ephem-path.js';

useRepoEphemeris();
process.env['LOG_LEVEL'] = 'silent';
process.env['NODE_ENV'] = 'production';
process.env['API_KEYS'] = '';
process.env['AUTH_OPTIONAL'] = 'false';

const { buildApp, assertAuthPosture } = await import('../../src/http/app.js');

describe('buildApp in production with no keys', () => {
  it('refuses to start', async () => {
    await expect(buildApp()).rejects.toThrow(/API_KEYS/);
  });

  it('names the escape hatch in the message, so the fix is not a search', async () => {
    await expect(buildApp()).rejects.toThrow(/AUTH_OPTIONAL/);
  });

  it('throws before anything binds, allocates or forks', async () => {
    // The check is the first statement in buildApp. If it ever moves below the
    // pool construction, this file would leak a worker process per call and
    // the suite would hang on exit rather than fail.
    await expect(buildApp()).rejects.toThrow();
    await expect(buildApp()).rejects.toThrow();
  });
});

describe('the posture, across every combination', () => {
  it('permits development with no keys', () => {
    expect(() => {
      assertAuthPosture({ isProduction: false, keyCount: 0, authOptional: false });
    }).not.toThrow();
  });

  it('permits production with keys', () => {
    expect(() => {
      assertAuthPosture({ isProduction: true, keyCount: 2, authOptional: false });
    }).not.toThrow();
  });

  it('permits production without keys when the flag is set deliberately', () => {
    // For a deployment where something in front authenticates. The point is
    // that it is a decision someone made by name, not a variable nobody set.
    expect(() => {
      assertAuthPosture({ isProduction: true, keyCount: 0, authOptional: true });
    }).not.toThrow();
  });

  it('refuses production without keys and without the flag', () => {
    expect(() => {
      assertAuthPosture({ isProduction: true, keyCount: 0, authOptional: false });
    }).toThrow(/Refusing to start/);
  });
});
