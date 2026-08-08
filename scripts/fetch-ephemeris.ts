/**
 * Downloads the Swiss Ephemeris data files named by ephemeris.manifest.json.
 *
 * Idempotent: a file already present whose SHA-256 matches is skipped, so
 * re-running costs one stat and one hash per file and no network.
 *
 * Rejected alternatives, for the record (ADR 0003):
 *   - Commit to git — 104 MB is permanent in history and blows clone times
 *     forever. sisco128/meteorite already demonstrates the regret.
 *   - Git LFS — metered bandwidth to re-host immutable public data that has a
 *     canonical upstream. Pure cost.
 *   - Docker layer only — leaves local dev with no reproducible path, which is
 *     the hole docs/SWISSEPH_INSTALL.md was written to paper over.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ManifestFile {
  name: string;
  sha256: string;
  bytes: number;
  family: string;
  era: string;
  startYear: number;
}

interface Manifest {
  seVersion: string;
  source: string;
  profiles: Record<string, { description: string; files: string[] }>;
  files: ManifestFile[];
}

const MANIFEST_PATH = 'ephemeris.manifest.json';

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

async function hashIfPresent(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  return sha256(path);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Manifest;

  const profileName = process.env['EPHEMERIS_PROFILE'] ?? 'full';
  const profile = manifest.profiles[profileName];
  if (profile === undefined) {
    throw new Error(
      `Unknown profile "${profileName}". Available: ${Object.keys(manifest.profiles).join(', ')}`,
    );
  }

  const targetDir = process.env['SE_EPHE_PATH'] ?? './ephem';
  await mkdir(targetDir, { recursive: true });
  const tmpDir = join(targetDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });

  const wanted = new Map(
    manifest.files.filter((f) => profile.files.includes(f.name)).map((f) => [f.name, f]),
  );

  const missing = profile.files.filter((name) => !wanted.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Manifest profile "${profileName}" names files it does not describe: ${missing.join(', ')}`,
    );
  }

  console.log(`profile ${profileName}: ${String(wanted.size)} files, ${profile.description}`);
  console.log(`target:  ${targetDir}`);
  console.log('');

  let skipped = 0;
  let downloaded = 0;
  let downloadedBytes = 0;

  for (const file of wanted.values()) {
    const finalPath = join(targetDir, file.name);
    const existing = await hashIfPresent(finalPath);

    if (existing === file.sha256) {
      skipped += 1;
      continue;
    }
    if (existing !== undefined) {
      console.log(`  ${file.name}: checksum mismatch, re-downloading`);
    }

    const url = new URL(file.name, manifest.source).toString();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GET ${url} -> ${String(response.status)} ${response.statusText}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    const tmpPath = join(tmpDir, file.name);
    await writeFile(tmpPath, body);

    const actual = await sha256(tmpPath);
    if (actual !== file.sha256) {
      await rm(tmpPath, { force: true });
      throw new Error(
        `Checksum mismatch for ${file.name}\n  expected ${file.sha256}\n  got      ${actual}\n` +
          `The upstream file changed, or the download was corrupted. Refusing to install it.`,
      );
    }
    if (body.byteLength !== file.bytes) {
      await rm(tmpPath, { force: true });
      throw new Error(
        `Size mismatch for ${file.name}: expected ${String(file.bytes)} bytes, got ${String(body.byteLength)}`,
      );
    }

    // Atomic: the file only appears at its final path once verified.
    await rename(tmpPath, finalPath);
    downloaded += 1;
    downloadedBytes += body.byteLength;
    console.log(`  ${file.name.padEnd(16)} ${mb(body.byteLength).padStart(9)}  ok`);
  }

  await rm(tmpDir, { recursive: true, force: true });

  await writeFile(
    join(targetDir, '.manifest.lock'),
    `${JSON.stringify(
      {
        profile: profileName,
        seVersion: manifest.seVersion,
        fetchedAt: new Date().toISOString(),
        files: Object.fromEntries([...wanted.values()].map((f) => [f.name, f.sha256])),
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log(
    `done: ${String(skipped)} already present, ${String(downloaded)} downloaded (${mb(downloadedBytes)})`,
  );
}

await main();
