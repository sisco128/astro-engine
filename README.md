# astro-engine

A high-precision astrological calculation engine. HTTP API over
[Swiss Ephemeris](https://www.astro.com/swisseph/), consumed by frontend
applications living in separate repositories.

**The engine returns numbers.** Formatted degrees, glyphs, sign names and
interpretive text are presentation, and belong to the clients.

## Status

Phase 1 of 8 — ephemeris adapter and service skeleton. Chart, transit-event and
activation endpoints are not implemented yet. See `docs/adr/` for the decisions
already taken.

## Quickstart

```bash
pnpm install
cp .env.example .env
pnpm ephem:fetch      # ~103 MB, or EPHEMERIS_PROFILE=core for 1.9 MB
pnpm ephem:verify
pnpm dev
```

```bash
curl localhost:3000/v1/ready
```

`node --version` must satisfy `>=22.21.0 <23`; `.nvmrc` pins it exactly. No
compiler is needed — `sweph` ships prebuilt N-API binaries.

## Ephemeris data

The `.se1` data files are **never committed**. `ephemeris.manifest.json` names
each file with its SHA-256; `pnpm ephem:fetch` downloads and verifies them.

| Profile | Files | Size     | Coverage                       |
| ------- | ----- | -------- | ------------------------------ |
| `core`  | 3     | 1.9 MB   | 1800–2399 CE                   |
| `full`  | 150   | 103.4 MB | 13200 BCE – 16799 CE (default) |

`pnpm ephem:verify` is the gate, and it never repairs — it checksums every
file, asserts the library version, then computes the Sun and Moon at J2000 and
checks the **returned flag**, not just the numbers. That last part matters:
Swiss Ephemeris degrades silently to its built-in Moshier model when a file is
missing or out of range, and near the present the difference is under one
arcsecond — inside our own test tolerances. At 3000 BCE it is 355 arcseconds
for Mars. The flag is the only reliable signal.

## Endpoints

| Method | Path               |                                                             |
| ------ | ------------------ | ----------------------------------------------------------- |
| `GET`  | `/v1/health`       | Liveness. No dependencies, answers under load.              |
| `GET`  | `/v1/ready`        | Readiness — ephemeris state, library version, probe result. |
| `GET`  | `/v1/meta/license` | Licence and source URL (AGPL-3.0 §13).                      |

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test          # unit + contract
pnpm test:golden   # against the real ephemeris files
```

### Conventions

There is no line-count rule. Every enforced rule maps to a defect that shipped
in the predecessor codebase, and the lint message names it. The ones worth
knowing before you write code:

- **`src/ephemeris/swe.ts` is the only file that may import `sweph`.** Three
  separate bugs came from callers each guessing at the binding's contract and
  reading `speedLongitude`, `speed`, or `longitudeSpeed`. Speed is `data[3]`,
  it is called `lonSpeed`, and it is named once.
- **`src/config/env.ts` is the only file that may read `process.env`.**
- **`new Date(y, m, d)` is banned** — it uses the server timezone, and dates
  built that way were compared against UTC ephemeris data.
- **`% 360` is banned** outside `src/math/angle.ts`.

## Licence

**AGPL-3.0-or-later.** See [LICENSE](LICENSE) and
[ADR 0004](docs/adr/0004-agpl-public-repo-mit-contract-package.md).

If you run a modified version of this service and users interact with it over a
network, AGPL §13 obliges you to offer them the corresponding source.

`packages/contract` is **MIT**, deliberately and separately, so that private
frontends can depend on it. That separation is load-bearing — read ADR 0004
before changing it.

Swiss Ephemeris is © Astrodienst AG, used here under its AGPL option. A
professional licence from Astrodienst is the alternative.
