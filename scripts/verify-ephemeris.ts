/**
 * Verifies the installed ephemeris data. Runs in CI and at container start.
 *
 * Unlike `ephem:fetch`, this NEVER repairs anything — it fails. Fetch is the
 * path that may reach the network; verify is the gate that must be able to say
 * "what is on disk is not what the manifest promised" and stop the deploy.
 *
 * Two layers, because a checksum alone is not enough:
 *
 *   1. Checksums — catches truncated, corrupted or substituted files.
 *   2. A live probe — computes real positions and checks the returned flag.
 *      This is what catches the failure the prototype could not see at all:
 *      files present but out of range for the requested date, where Swiss
 *      Ephemeris silently degrades to the Moshier model and returns plausible
 *      numbers. server/astrology/core/ephemeris.js:27 did an fs.existsSync on
 *      the directory and called it initialised.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import sweph from 'sweph';

interface ManifestFile {
  name: string;
  sha256: string;
  bytes: number;
}

interface Manifest {
  seVersion: string;
  profiles: Record<string, { description: string; files: string[] }>;
  files: ManifestFile[];
}

/**
 * Reference positions at J2000.0 (JD 2451545.0 UT), apparent geocentric
 * ecliptic longitude, from Swiss Ephemeris 2.10.03 with the manifest's files.
 *
 * These are a smoke test, not ground truth — the golden suite (phase 2) is
 * what validates against JPL Horizons. Their job here is to notice that the
 * files on disk are not the files that produced these numbers.
 */
const PROBE = [
  { body: 'sun', se: 0, lon: 280.36891867, lonSpeed: 1.019434163 },
  { body: 'moon', se: 1, lon: 223.323751446, lonSpeed: 12.021303767 },
] as const;

/** Arcseconds. Anything above this means different data, not rounding. */
const PROBE_TOLERANCE_ARCSEC = 0.001;

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

/** Layer 1 — one file's size and checksum against the manifest. */
async function checkFile(dir: string, name: string, expected: ManifestFile): Promise<boolean> {
  const path = join(dir, name);

  let size: number;
  try {
    ({ size } = await stat(path));
  } catch {
    fail(`${name}: missing (run: pnpm ephem:fetch)`);
    return false;
  }

  if (size !== expected.bytes) {
    fail(`${name}: expected ${String(expected.bytes)} bytes, found ${String(size)}`);
    return false;
  }

  const actual = await sha256(path);
  if (actual !== expected.sha256) {
    fail(`${name}: checksum mismatch\n    expected ${expected.sha256}\n    found    ${actual}`);
    return false;
  }

  return true;
}

/** Layer 3 — compute a known position and inspect the returned flag. */
function probe(expected: (typeof PROBE)[number]): void {
  const flags = sweph.constants.SEFLG_SWIEPH | sweph.constants.SEFLG_SPEED;
  const result = sweph.calc_ut(2451545.0, expected.se, flags);

  if (result.flag < 0) {
    fail(`probe ${expected.body}: calculation failed — ${result.error.trim()}`);
    return;
  }

  // The check the prototype had no equivalent of anywhere.
  if ((result.flag & sweph.constants.SEFLG_SWIEPH) === 0) {
    fail(
      `probe ${expected.body}: Swiss Ephemeris fell back to the Moshier model ` +
        `(flag ${String(result.flag)}). The .se1 files are present but not being used. ` +
        `serr: ${result.error.trim()}`,
    );
    return;
  }

  const deltaArcsec = Math.abs(result.data[0] - expected.lon) * 3600;
  if (deltaArcsec > PROBE_TOLERANCE_ARCSEC) {
    fail(
      `probe ${expected.body}: longitude off by ${deltaArcsec.toFixed(4)}" ` +
        `(expected ${String(expected.lon)}, got ${result.data[0].toFixed(9)})`,
    );
    return;
  }

  console.log(
    `  probe:     ${expected.body.padEnd(5)} ${result.data[0].toFixed(6)}  (Δ ${deltaArcsec.toFixed(6)}")`,
  );
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile('ephemeris.manifest.json', 'utf8')) as Manifest;

  const profileName = process.env['EPHEMERIS_PROFILE'] ?? 'full';
  const profile = manifest.profiles[profileName];
  if (profile === undefined) {
    throw new Error(`Unknown profile "${profileName}"`);
  }

  const dir = process.env['SE_EPHE_PATH'] ?? './ephem';
  const byName = new Map(manifest.files.map((f) => [f.name, f]));

  console.log(`verifying profile "${profileName}" in ${dir}`);

  let checked = 0;
  for (const name of profile.files) {
    const expected = byName.get(name);
    if (expected === undefined) {
      fail(`${name}: named by profile but absent from the manifest's file list`);
      continue;
    }
    if (await checkFile(dir, name, expected)) checked += 1;
  }

  console.log(`  checksums: ${String(checked)}/${String(profile.files.length)} ok`);

  const version = sweph.version();
  if (version !== manifest.seVersion) {
    fail(`Swiss Ephemeris version is ${version}, manifest expects ${manifest.seVersion}`);
  }
  console.log(`  library:   ${version}`);

  sweph.set_ephe_path(dir);
  for (const expected of PROBE) {
    probe(expected);
  }
  sweph.close();

  if (failures.length > 0) {
    console.error(`\nFAILED — ${String(failures.length)} problem(s):\n`);
    for (const failure of failures) {
      console.error(`  • ${failure}`);
    }
    process.exit(1);
  }

  console.log('\nok');
}

await main();
