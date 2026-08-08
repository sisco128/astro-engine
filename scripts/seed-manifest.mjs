/**
 * Seeds ephemeris.manifest.json from a local Swiss Ephemeris directory.
 *
 * This is a one-off, deliberate act — not part of the build. It exists so the
 * manifest's checksums come from a copy we already trust (the prototype's
 * ephem/, dated 2023-09-20 and matching Astrodienst's published byte sizes)
 * rather than from whatever a download happens to return. That makes
 * scripts/verify-ephemeris a real check against an independent reference
 * instead of a tautology that re-hashes what it just fetched.
 *
 *   node scripts/seed-manifest.mjs <path-to-ephem-dir>
 *
 * File naming convention (Astrodienst): each .se1 covers 600 years.
 *   sepl_18.se1  -> planets,   1800 CE onward
 *   seplm18.se1  -> planets,   1800 BCE onward
 * The trailing number is the starting century. We record it for documentation,
 * but coverage is never *trusted* from metadata — verify-ephemeris probes the
 * library at real dates instead.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sweph from 'sweph';

/**
 * Astrodienst's official repository (aloistr = Alois Treindl, Astrodienst's
 * founder). The historic www.astro.com/ftp/swisseph/ephe/ path — the one that
 * appears throughout the documentation — now returns 404 for every file.
 */
const SOURCE_URL = 'https://github.com/aloistr/swisseph/raw/master/ephe/';

/** Families we actually compute. `sat/` (planetary moons) and seasnam.txt are excluded on purpose. */
const FAMILIES = {
  sepl: { body: 'planets', label: 'Sun..Pluto' },
  semo: { body: 'moon', label: 'Moon' },
  seas: { body: 'asteroids', label: 'Chiron, Lilith, asteroids' },
};

/** The three files that cover every realistic natal chart, 1800-2399 CE. */
const CORE_FILES = ['sepl_18.se1', 'semo_18.se1', 'seas_18.se1'];

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** `sepl_18.se1` -> { family: 'sepl', era: 'CE', startYear: 1800 } */
function parseName(name) {
  const match = /^(sepl|semo|seas)(_|m)(\d+)\.se1$/.exec(name);
  if (match === null) return undefined;
  const [, family, eraMark, centuries] = match;
  const era = eraMark === 'm' ? 'BCE' : 'CE';
  const startYear = Number(centuries) * 100 * (era === 'BCE' ? -1 : 1);
  return { family, era, startYear };
}

const ephemDir = process.argv[2];
if (ephemDir === undefined) {
  console.error('usage: node scripts/seed-manifest.mjs <path-to-ephem-dir>');
  process.exit(1);
}

const entries = await readdir(ephemDir, { withFileTypes: true });
const files = [];

for (const entry of entries) {
  if (!entry.isFile()) continue;
  const parsed = parseName(entry.name);
  if (parsed === undefined) continue;

  const path = join(ephemDir, entry.name);
  const [hash, { size }] = await Promise.all([
    sha256(path),
    import('node:fs/promises').then((fs) => fs.stat(path)),
  ]);

  files.push({
    name: entry.name,
    sha256: hash,
    bytes: size,
    family: parsed.family,
    era: parsed.era,
    startYear: parsed.startYear,
  });
}

// Sort by family, then chronologically: BCE descending (most distant first), then CE ascending.
files.sort(
  (a, b) =>
    a.family.localeCompare(b.family) || a.startYear - b.startYear || a.name.localeCompare(b.name),
);

const missingFromCore = CORE_FILES.filter((name) => !files.some((f) => f.name === name));
if (missingFromCore.length > 0) {
  console.error(
    `refusing to write manifest: core files missing from source dir: ${missingFromCore.join(', ')}`,
  );
  process.exit(1);
}

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
const years = files.map((f) => f.startYear);

/**
 * Probe the coverage the library actually delivers, rather than trusting what
 * the filenames imply.
 *
 * These disagree. `seplm132.se1` is nominally 13200 BCE onward, but its data
 * begins around 12999 BCE — Swiss Ephemeris returns flag -1 for the two
 * centuries in between, with "asteroid eph. file (seplm132.se1): jd ... out of
 * range". A manifest that published the filename-derived bound would be
 * promising two hundred years it cannot deliver.
 */
function probeCoverage(dir) {
  const flags = sweph.constants.SEFLG_SWIEPH | sweph.constants.SEFLG_SPEED;

  /**
   * close() before every probe, and it is load-bearing.
   *
   * Swiss Ephemeris keeps open .se1 handles in process-global state, so an
   * instant that fails from a clean start can succeed once a neighbouring
   * file happens to be cached. Measured: bisecting without close() reported
   * the ceiling as JD 7857128 — and JD 7857128 fails in a fresh process. The
   * true last working instant is 7857125. The bisection was reading its own
   * side effects.
   *
   * With close() the probe is deterministic and repeatable.
   */
  const works = (jd) => {
    sweph.close();
    sweph.set_ephe_path(dir);
    return [sweph.constants.SE_SUN, sweph.constants.SE_MOON].every(
      (body) => sweph.calc_ut(jd, body, flags).flag >= 0,
    );
  };

  // Bisect from a known-good instant (J2000) outward to each edge.
  const bisect = (failing, working) => {
    for (let i = 0; i < 50; i += 1) {
      const mid = (failing + working) / 2;
      if (works(mid)) working = mid;
      else failing = mid;
    }
    return working;
  };

  const minJd = bisect(-4_000_000, 2451545);
  const maxJd = bisect(10_000_000, 2451545);

  // Report whole days, then step inward until the reported bound itself
  // verifies. Rounding a fractional bound outward would publish a day the
  // library refuses.
  let minJdUt = Math.ceil(minJd);
  while (!works(minJdUt)) minJdUt += 1;

  let maxJdUt = Math.floor(maxJd);
  while (!works(maxJdUt)) maxJdUt -= 1;

  const asDate = (jd) => {
    const { year, month, day } = sweph.revjul(jd, sweph.constants.SE_GREG_CAL);
    return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const result = {
    minJdUt,
    maxJdUt,
    minDate: asDate(minJdUt),
    maxDate: asDate(maxJdUt),
  };

  sweph.close();
  return result;
}

const coverage = probeCoverage(ephemDir);

const manifest = {
  $comment:
    'Generated by scripts/seed-manifest.mjs from a trusted local copy. Do not hand-edit — regenerate and review the diff.',
  seVersion: '2.10.03',
  source: SOURCE_URL,
  seededFrom: 'infra-test-2/ephem (Astrodienst build dated 2023-09-20)',
  seededAt: new Date().toISOString().slice(0, 10),
  families: FAMILIES,
  /**
   * Bounds the library actually delivers, probed by bisection rather than
   * derived from filenames. The two disagree; this is the one to trust.
   */
  measuredCoverage: coverage,
  profiles: {
    core: {
      description: '1800-2399 CE. Covers every realistic natal chart. Fast local-dev option.',
      files: CORE_FILES,
    },
    full: {
      description:
        'Maximum freely available coverage. Default. See measuredCoverage for the real bounds — ' +
        'the filename-derived range overstates the lower end by about two centuries.',
      files: files.map((f) => f.name),
    },
  },
  files,
};

await writeFile('ephemeris.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const coreBytes = files.filter((f) => CORE_FILES.includes(f.name)).reduce((s, f) => s + f.bytes, 0);

console.log(`wrote ephemeris.manifest.json`);
console.log(`  files:   ${files.length}`);
console.log(`  core:    ${CORE_FILES.length} files, ${mb(coreBytes)}`);
console.log(`  full:    ${files.length} files, ${mb(totalBytes)}`);
console.log(
  `  nominale (dai nomi file): ${Math.abs(Math.min(...years))} BCE -> ${Math.max(...years) + 599} CE`,
);
console.log(`  MISURATA:                 ${coverage.minDate} -> ${coverage.maxDate}`);
for (const [family, meta] of Object.entries(FAMILIES)) {
  const group = files.filter((f) => f.family === family);
  console.log(
    `  ${family}:    ${group.length} files, ${mb(group.reduce((s, f) => s + f.bytes, 0))}  (${meta.label})`,
  );
}
