/**
 * Writes the OpenAPI document to docs/openapi.json.
 *
 * The document has always been generated from the zod schemas and served at
 * GET /v1/openapi.json; what this adds is a copy on disk, under review. Two
 * things needed it.
 *
 * A wire-shape change was invisible: editing a zod schema changed what every
 * client receives and produced no diff anyone read. Now it produces one, and
 * tests/contract/openapi.test.ts fails until this script has been run — so the
 * change to the contract arrives in the same commit as the change that caused
 * it.
 *
 * And a client had nothing to pin to. Generating types from a running engine
 * makes a frontend build depend on a server being up, and on whichever version
 * that server happened to be. navigate.fyi copies this file instead and
 * generates from the copy, which is why its build needs no engine at all.
 *
 * Formatted through prettier's own API, with this repository's own config
 * resolved rather than prettier's defaults: `prettier --check .` covers docs/,
 * and a file this script writes must be a file that check accepts. It also has
 * to be a file navigate.fyi's check accepts unchanged, because that repository
 * keeps a byte-identical copy and compares it against this one — two prettier
 * configurations that agree are what let a copy be compared instead of parsed.
 *
 *   pnpm contract:emit
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { buildOpenApiDocument } from '../src/http/openapi.js';

const target = fileURLToPath(new URL('../docs/openapi.json', import.meta.url));

const options = await resolveConfig(target);

const formatted = await format(JSON.stringify(buildOpenApiDocument(), null, 2), {
  ...options,
  parser: 'json',
  filepath: target,
});

await writeFile(target, formatted, 'utf8');

console.log(`wrote ${target}`);
