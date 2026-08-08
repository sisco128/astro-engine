/**
 * One-off: downloads every file named in the manifest WITHOUT checksum
 * verification, so the manifest can then be re-seeded from what upstream
 * actually serves.
 *
 * This exists because the checksums were originally seeded from a local 2023
 * copy, and upstream has since moved (www.astro.com/ftp/swisseph/ephe/ now
 * 404s) and changed: seas_18.se1 is 223004 bytes upstream vs 223002 locally,
 * and the two produce Chiron positions differing by ~0.01 arcsec. Anyone
 * cloning gets upstream's bytes, so the manifest must describe upstream.
 *
 * Never run this in CI or as part of a build. `pnpm ephem:fetch` is the
 * verifying path; this one deliberately trusts the network, which is exactly
 * what we do not want at build time.
 *
 *   node scripts/bootstrap-download.mjs [targetDir]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('ephemeris.manifest.json', 'utf8'));
const targetDir = process.argv[2] ?? './ephem';
await mkdir(targetDir, { recursive: true });

const names = manifest.files.map((f) => f.name);
const CONCURRENCY = 8;

let done = 0;
let failed = [];
let totalBytes = 0;

async function fetchOne(name) {
  const url = new URL(name, manifest.source).toString();
  const response = await fetch(url);
  if (!response.ok) {
    failed.push(`${name} -> ${response.status}`);
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(join(targetDir, name), body);
  totalBytes += body.byteLength;
  done += 1;
  if (done % 10 === 0) {
    process.stdout.write(
      `  ${done}/${names.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)\n`,
    );
  }
}

console.log(`bootstrap: ${names.length} files from ${manifest.source}`);
for (let i = 0; i < names.length; i += CONCURRENCY) {
  await Promise.all(names.slice(i, i + CONCURRENCY).map(fetchOne));
}

console.log(
  `\ndone: ${done} ok, ${failed.length} failed, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
);
if (failed.length > 0) {
  console.log('failures:');
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
