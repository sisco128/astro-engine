/**
 * The engine version, defined exactly once.
 *
 * It used to be a private `const ENGINE_VERSION = '0.1.0'` in four files at
 * the same time — app.ts, routes/v1/charts.ts, routes/v1/key-dates.ts,
 * routes/v1/returns.ts — with nothing keeping them equal. That is the drift
 * this codebase keeps rediscovering (a profile list, an ephemeris path, a
 * house-system validator), and here a mismatch would be nastier than most: the
 * value goes into cache keys *and* into the `engine.version` of every
 * response, so half the endpoints would report one version while serving
 * results cached under another, and the OpenAPI document would describe a
 * version no route emits.
 *
 * package.json carries the same string and deliberately stays a separate copy:
 * importing JSON from ESM would drag an import attribute and a build-time copy
 * step into the runtime for one constant, and nothing the engine serves is
 * read from it. This module is the one the wire sees, and the contract test
 * pins it by comparing the OpenAPI document against a live response.
 */
export const ENGINE_VERSION = '0.1.0';
