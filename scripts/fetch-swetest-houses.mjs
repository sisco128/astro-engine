/**
 * Generates the Tier B house-cusp reference by driving `swetest`.
 *
 * Tier B is weaker than Tier A and the distinction matters. `swetest` is built
 * from the same C source that `sweph` binds, so it cannot catch an error in
 * Swiss Ephemeris itself — it would make the same one. What it does catch is
 * everything between the C library and our response: a misread `points[]`
 * index, a wrong house-system letter, a dropped normalisation, a flag we
 * forgot to pass. JPL Horizons offers nothing comparable for house cusps, so
 * this is the best external check available for them.
 *
 * The genuinely independent check on the angles lives in the golden test
 * itself: the Ascendant and MC have closed forms in ARMC and the obliquity,
 * and reproducing them from spherical trigonometry does not touch Swiss
 * Ephemeris's house code at all.
 *
 * `swetest` is not a build dependency. Build it once from
 * github.com/aloistr/swisseph:
 *
 *   gcc -o swetest *.c -lm -w
 *
 * then run, and commit the result:
 *
 *   node scripts/fetch-swetest-houses.mjs <path-to-swetest> <ephe-dir>
 */

import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import sweph from 'sweph';

/**
 * Charts chosen so each one can break something different.
 */
const CASES = [
  {
    id: 'rome-1987',
    note: 'Primary regression chart. 11:32 CEST = 09:32 UT.',
    date: '12.8.1987',
    ut: '9:32',
    lat: 41.9028,
    lon: 12.4964,
    systems: ['P', 'K', 'O', 'R', 'C', 'W', 'E', 'B', 'M', 'T'],
  },
  {
    id: 'sydney-1996',
    note: 'Southern hemisphere. House ordering differs below the equator.',
    date: '21.12.1996',
    ut: '6:00',
    lat: -33.8688,
    lon: 151.2093,
    systems: ['P', 'K', 'W'],
  },
  {
    id: 'oslo-1975',
    note: 'High northern latitude, still below the polar circle.',
    date: '21.6.1975',
    ut: '12:00',
    lat: 59.9139,
    lon: 10.7522,
    systems: ['P', 'K', 'W'],
  },
  {
    id: 'equator-j2000',
    note: 'Equator and prime meridian at J2000. Degenerate-looking but valid.',
    date: '1.1.2000',
    ut: '12:00',
    lat: 0,
    lon: 0,
    systems: ['P', 'W'],
  },
  {
    id: 'tromso-1975-wholesign',
    note: 'Above the polar circle. Only latitude-safe systems are defined here.',
    date: '21.6.1975',
    ut: '12:00',
    lat: 69.65,
    lon: 18.9553,
    systems: ['W', 'O', 'E', 'M'],
  },
];

/** "200°11'59.5292" -> 200.19986922 */
function parseDms(text) {
  const match = /^(-?\d+)°\s*(\d+)'\s*([\d.]+)$/.exec(text.trim());
  if (match === null) return undefined;
  const [, deg, min, sec] = match;
  const sign = deg.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(deg)) + Number(min) / 60 + Number(sec) / 3600);
}

/**
 * The two sides must be handed the same instant, and by default they are not.
 *
 * Our `jdFromUtc` goes through `swe_utc_to_jd`, which converts civil UTC to
 * UT1. swetest's `-ut` flag takes UT1 directly. For the 1987 chart that is a
 * 0.441-second difference — trivial-looking, and it moves the Ascendant by
 * 5.17 arcseconds, ten times the cusp tolerance. A Tier B comparison built on
 * `-ut9:32` would fail for a reason that has nothing to do with our code.
 *
 * So: derive JD(UT1) exactly as the engine does, then express THAT back as the
 * h:m:s swetest needs, and record the JD in the fixture as the canonical
 * instant both sides refer to.
 */
function canonicalInstant(testCase) {
  const [day, month, year] = testCase.date.split('.').map(Number);
  const [hour, minute] = testCase.ut.split(':').map(Number);

  const converted = sweph.utc_to_jd(year, month, day, hour, minute, 0, sweph.constants.SE_GREG_CAL);
  const jdUt = converted.data[1];

  const civil = sweph.revjul(jdUt, sweph.constants.SE_GREG_CAL);
  const h = Math.floor(civil.hour);
  const m = Math.floor((civil.hour - h) * 60);
  const sec = ((civil.hour - h) * 60 - m) * 60;

  return {
    jdUt,
    swetestDate: `${String(civil.day)}.${String(civil.month)}.${String(civil.year)}`,
    swetestUt: `${String(h)}:${String(m)}:${sec.toFixed(4)}`,
  };
}

function runSwetest({ binary, ephe, testCase, system, instant }) {
  const args = [
    `-b${instant.swetestDate}`,
    `-ut${instant.swetestUt}`,
    '-p0',
    `-house${String(testCase.lon)},${String(testCase.lat)},${system}`,
    '-eswe',
    `-edir${ephe}`,
  ];

  const output = execFileSync(binary, args, { encoding: 'utf8' });
  const cusps = [];

  for (const line of output.split('\n')) {
    const match = /^house\s+(\d+)\s+(-?\d+°\s*\d+'\s*[\d.]+)/.exec(line.trim());
    if (match === null) continue;
    const value = parseDms(match[2]);
    if (value === undefined) continue;
    cusps[Number(match[1]) - 1] = value;
  }

  if (cusps.length !== 12 || cusps.some((c) => c === undefined)) {
    throw new Error(
      `swetest returned ${String(cusps.filter((c) => c !== undefined).length)} cusps for ` +
        `${testCase.id}/${system}; expected 12.\n${output}`,
    );
  }

  return cusps;
}

const [binaryArg, epheArg] = process.argv.slice(2);
if (binaryArg === undefined || epheArg === undefined) {
  console.error('usage: node scripts/fetch-swetest-houses.mjs <path-to-swetest> <ephe-dir>');
  process.exit(1);
}

const binary = resolve(binaryArg);
const ephe = resolve(epheArg);

// swetest has no --version flag; the banner on any run carries it.
const banner = execFileSync(binary, ['-b1.1.2000', '-ut12:00', '-p0', '-eswe', `-edir${ephe}`], {
  encoding: 'utf8',
});
const version = /version ([\d.]+)/.exec(banner)?.[1] ?? 'unknown';
console.log(`swetest: Swiss Ephemeris ${version}`);
if (version !== '2.10.03') {
  console.error(`refusing to generate: swetest reports ${version}, expected 2.10.03`);
  process.exit(1);
}

const charts = [];

for (const testCase of CASES) {
  const instant = canonicalInstant(testCase);
  const systems = {};
  for (const system of testCase.systems) {
    systems[system] = runSwetest({ binary, ephe, testCase, system, instant });
    console.log(`  ${testCase.id.padEnd(26)} ${system}  cusp1 = ${systems[system][0].toFixed(7)}`);
  }
  charts.push({
    id: testCase.id,
    note: testCase.note,
    civilUtc: `${testCase.date} ${testCase.ut} UTC`,
    jdUt: instant.jdUt,
    swetestUt: instant.swetestUt,
    geo: { lat: testCase.lat, lon: testCase.lon },
    systems,
  });
}

await writeFile(
  'tests/golden/fixtures/swetest-houses.json',
  `${JSON.stringify(
    {
      $comment:
        'Tier B reference. Generated by scripts/fetch-swetest-houses.mjs from a locally built swetest. ' +
        'Regenerate deliberately and review the diff; CI never regenerates it.',
      provider: 'swetest',
      seVersion: '2.10.03',
      generated: new Date().toISOString().slice(0, 10),
      charts,
    },
    null,
    2,
  )}\n`,
);

console.log(`\nwrote tests/golden/fixtures/swetest-houses.json (${String(charts.length)} charts)`);
