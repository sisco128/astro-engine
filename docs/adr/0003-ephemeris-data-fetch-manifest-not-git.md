# 3. Fetch ephemeris data from a checksummed manifest; never commit it

- Status: accepted
- Date: 2026-08-08

## Context

The prototype's `ephem/` directory is **301 MB** and was not in `.gitignore` for
the twenty months the project existed. Its predecessor, `sisco128/meteorite`,
did commit them: roughly 117 MB of `.se1` files are permanently in that
repository's history. There was also no documentation anywhere on how to obtain
the files — `docs/SWISSEPH_INSTALL.md` covers only the npm package.

An audit of the 301 MB found that **almost none of it is needed**: ~190 MB is
`sat/` (planetary-moon files, for bodies this engine will never compute) and
13.5 MB is `seasnam.txt` (an asteroid name index, needed only to resolve
asteroids by name).

## Decision

`ephemeris.manifest.json` names every file with its SHA-256, byte count and
era. `scripts/fetch-ephemeris.ts` downloads what a named profile requires,
verifies each checksum before installing, and renames atomically.
`scripts/verify-ephemeris.ts` is the gate: it **never repairs**, only fails.

Profiles:

| Profile | Files | Size     | Coverage                                   |
| ------- | ----- | -------- | ------------------------------------------ |
| `core`  | 3     | 1.9 MB   | 1800–2399 CE — every realistic natal chart |
| `full`  | 150   | 103.4 MB | **13200 BCE – 16799 CE** — the default     |

`.gitignore` excludes `/ephem/`, and `.github/workflows/ci.yml` additionally
fails any diff that adds a `*.se1` or a blob over 5 MB. A passive ignore line is
provably insufficient — this repository's own two predecessors are the evidence.

## Consequences

**The upstream source had moved, and we only found out because of the
checksums.** `https://www.astro.com/ftp/swisseph/ephe/` — the URL that appears
throughout Swiss Ephemeris documentation — now returns **404 for every file**.
The live source is Astrodienst's official repository,
`https://github.com/aloistr/swisseph/raw/master/ephe/`.

**The data had also changed.** `seas_18.se1` is 223,004 bytes upstream against
223,002 in the 2023 local copy, with different hashes. Not a header edit — the
computed positions differ. Chiron, measured:

| JD          | Local (2023)  | Upstream      | Δ       |
| ----------- | ------------- | ------------- | ------- |
| 2451545.0   | 251.617623518 | 251.617626429 | 0.0105″ |
| 2447019.897 | 86.915241846  | 86.915237802  | 0.0146″ |
| 2460000.5   | 13.646647030  | 13.646643482  | 0.0128″ |

A refinement of the asteroid's orbital elements. 0.01″ sits far inside the
golden suite's 1″ tolerance, so neither is "wrong" — but they are not the same
data, and a manifest that claimed otherwise would be lying.

The manifest is therefore seeded **from upstream**: whoever clones this repo
gets upstream's bytes, and the manifest must describe what they will actually
receive. The 2023 local copy still earned its keep — it supplied the
**independent comparison** that established the agreement. Seeding from a fresh
download and then re-hashing it would have been a tautology, not a verification.

## Alternatives considered

- **Commit to git.** Permanent in history, ruins clone times forever, and
  `meteorite` already demonstrates the regret.
- **Git LFS.** Metered bandwidth to re-host immutable public data that has a
  canonical upstream. Cost with no benefit.
- **Docker layer only.** Leaves local development with no reproducible path —
  the exact hole `docs/SWISSEPH_INSTALL.md` was written to paper over.
