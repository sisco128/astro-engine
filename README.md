# astro-engine

A high-precision astrological calculation engine. An HTTP API over
[Swiss Ephemeris](https://www.astro.com/swisseph/), consumed by frontend
applications that live in separate repositories.

**The engine calculates. It does not interpret.** Every response is numbers and
stable identifiers: longitudes, house indices, Julian Days, aspect and body ids.
Formatted degrees, glyphs, sign names and interpretive prose are presentation,
and belong to the clients. A contract test walks each payload and fails if a
`formatted`, `sign`, `symbol` or `interpretation` key ever reappears.

Three things are computed, and they build on each other:

- **Natal charts** — positions, speeds, retrograde state, the five angles, and
  house cusps in any of the systems Swiss Ephemeris supports, with the
  high-latitude cases refused rather than fudged.
- **Key dates** — the transit funnel. A natal chart is first reduced to
  _stories_ (scored aspect groups), then a date window is scanned for moments
  where a slow, a social and a fast transit all activate the same story at once.
  The output is clustered windows with the full activation path, not a list of
  every aspect that was technically in orb.
- **Planetary returns** — birth-anchored root-finding for the returns and
  half-returns of Saturn, Uranus, Chiron and Pluto (or any other body), each
  labelled with its life phase where the vocabulary has one. Ages are found
  against the ephemeris, not read from a table: on the reference chart Chiron's
  first opposition lands at 13.8 years, not the ~25 the textbooks quote.

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
curl -s localhost:3000/v1/openapi.json | head

curl -s localhost:3000/v1/charts -H 'content-type: application/json' -d '{
  "when": { "local": { "year": 1987, "month": 8, "day": 12,
                       "hour": 11, "minute": 32, "zone": "Europe/Rome" } },
  "geo": { "lat": 41.9028, "lon": 12.4964 }
}'
```

`node --version` must satisfy `>=22.21.0 <23`; `.nvmrc` pins it exactly. No
compiler is needed — `sweph` ships prebuilt N-API binaries.

## Endpoints

| Method | Path                     |                                                                    |
| ------ | ------------------------ | ------------------------------------------------------------------ |
| `GET`  | `/v1/health`             | Liveness. No dependencies; answers under load.                     |
| `GET`  | `/v1/ready`              | Readiness — ephemeris state, library version, probe, pool.         |
| `GET`  | `/v1/openapi.json`       | The machine-readable contract. See below.                          |
| `GET`  | `/v1/meta/license`       | Licence and source URL (AGPL-3.0 §13).                             |
| `GET`  | `/v1/meta/funnel`        | Funnel vocabulary: tiers, presets, aspects, nesting rules, limits. |
| `GET`  | `/v1/meta/life-phases`   | The life-phase catalogue, chart-independent.                       |
| `GET`  | `/v1/geo/search`         | Place name → coordinates + IANA zone, in one call.                 |
| `POST` | `/v1/charts`             | Natal chart. Deterministic; carries a strong ETag.                 |
| `POST` | `/v1/transits/key-dates` | Key dates for a window, with the funnel as request parameters.     |
| `POST` | `/v1/transits/returns`   | Planetary returns from birth, with life phases.                    |

Every non-2xx response from every endpoint has the same envelope — branch on
`error.code`, never on the message:

```json
{ "error": { "code": "WINDOW_TOO_LARGE", "message": "…", "requestId": "req-3", "details": {} } }
```

`/v1/ready` is the exception: its 503 is a readiness report, not an error.

### The contract

`GET /v1/openapi.json` serves an OpenAPI 3.1 document whose request bodies are
generated, via `z.toJSONSchema`, from the same zod schemas that validate every
incoming request. Frontends generate a typed client from it rather than
hand-maintaining a copy of the server's shapes:

```bash
npx openapi-typescript http://localhost:3000/v1/openapi.json -o src/api.d.ts
```

Two things about that document are deliberate. It has no separate licence and no
separate package — it is served by the engine, generated from the engine, and
covered by the engine's AGPL, because generating a client from a description of
an interface links none of this code into the client. And its responses are
documented honestly: `/v1/charts` carries a full schema because a zod response
schema exists for it, while key-dates and returns are described in prose,
because writing zod schemas purely for documentation would create a second copy
of the truth that nothing keeps equal to the handler. A contract test asserts
that every registered route appears in the document and that the version it
advertises is the version a live call returns.

## Ephemeris data

The `.se1` data files are **never committed**. `ephemeris.manifest.json` names
each file with its SHA-256; `pnpm ephem:fetch` downloads and verifies them.

| Profile  | Files | Size     | Coverage                                    |
| -------- | ----- | -------- | ------------------------------------------- |
| `core`   | 3     | 1.9 MB   | 1800–2399 CE. Every realistic natal chart.  |
| `bounds` | 9     | 7.2 MB   | Core plus the coverage edges. What CI uses. |
| `full`   | 150   | 103.4 MB | 12999 BCE – 16799 CE (default)              |

`pnpm ephem:verify` is the gate, and it never repairs — it checksums every file,
asserts the library version, then computes the Sun and Moon at J2000 and checks
the **returned flag**, not just the numbers. That last part matters: Swiss
Ephemeris degrades silently to its built-in Moshier model when a file is missing
or out of range, and near the present the difference is under one arcsecond —
inside our own test tolerances. At 3000 BCE it is 355 arcseconds for Mars. The
flag is the only reliable signal.

The `full` range above is **measured**, by bisection, not derived from
filenames. The filenames promise about two centuries at the lower end that the
library will not actually deliver.

## Tests

```bash
pnpm test          # unit + contract
pnpm test:golden   # the numbers, at full tolerance
pnpm test:all
```

Only `tests/unit` runs without data. The contract suite boots the real engine
and calculates real charts, so it needs a populated ephemeris directory; the
tests default to the repository's own `ephem/`, and `SE_EPHE_PATH` overrides it.
Nothing here is mocked. A mocked ephemeris cannot validate an ephemeris.

Three suites, doing three different jobs:

- **`tests/unit`** — pure functions: angle wrapping, root-finding, aspect
  geometry, timezone resolution, the result cache, config parsing.
- **`tests/contract`** — the HTTP surface, through Fastify's `inject`, so no
  port is bound. Status codes, the error envelope, ETags, cache headers, the
  no-presentation rule, and the OpenAPI document.
- **`tests/golden`** — the numbers, against the real `.se1` files.

**"Golden" here means checked against an independent source, and the suite is
explicit about how independent each check really is.** Tier A compares Swiss
Ephemeris against **JPL Horizons** — a different organisation, a different
integrator, a different codebase — from a committed fixture that CI never
refetches, because a reference that silently refreshes is not a reference.
Tolerances are 0.5″ for planets and 1.0″ for the Moon: about five times the
largest disagreement actually observed, tight enough that a real integration
error cannot hide.

Tier B compares house cusps against `swetest`. That is weaker on purpose and
labelled as such: `swetest` is built from the same C source, so it cannot catch
an error _inside_ Swiss Ephemeris, only one between the library and our
response. The Ascendant and MC in that same file are checked a third way,
computed from spherical trigonometry that never touches the library's house
code — Horizons publishes nothing comparable for cusps.

The rest of the golden suite pins behaviour that only the real data can show:
the ephemeris bounds and what happens just past them, that a transit contact is
an interval with an exact instant inside it rather than a sampled day, and that
the funnel hits its stated target of one to two key windows per quarter.

## Configuration

All of it is environment variables, documented with their rationale in
[`.env.example`](.env.example) and parsed in exactly one place,
[`src/config/env.ts`](src/config/env.ts). Parsing happens once at module load
and throws before the server binds, so a misconfigured deploy fails at startup
rather than at the first request.

The ones that decide whether results are trustworthy are `SE_EPHE_PATH`,
`SE_STRICT_EPHEMERIS` and `SE_FORBID_FALLBACK` — read the comments above them
before turning any of the last two off. `CORS_ORIGINS` is not optional in
production: the engine exists to be called from other origins.

`NOMINATIM_BASE_URL` defaults to the public OpenStreetMap geocoder, whose usage
policy forbids heavy production use and is enforced by blocking the source
address. Self-hosting Nominatim is the production path; the engine's outbound
queue holds to one request per second either way.

Design decisions and their trade-offs are recorded in [`docs/adr/`](docs/adr).

## Deploy

Not documented yet.

## Conventions

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
- **A constant with two definitions is a bug waiting to happen.** The engine
  version lives in `src/version.ts` and nowhere else; it used to be a private
  const in four files at once, and it stamps both cache keys and responses.

## Deploy

```bash
pnpm build     # tsc -p tsconfig.build.json → dist/
pnpm start     # node dist/main.js
```

`tsconfig.build.json` compiles `src/` alone, re-rooted, so the entrypoint lands
at `dist/main.js` and the compute worker at `dist/pool/worker.js`. That second
path matters more than it looks: `src/pool/pool.ts` picks `worker.ts` or
`worker.js` from its own file extension, so a build is only proven by booting
it and watching `/v1/ready` turn 200 — readiness waits for a forked worker to
report in. CI does exactly that on every run.

### Docker

```bash
docker build -t astro-engine .
docker run --rm -p 3000:3000 astro-engine
curl localhost:3000/v1/ready
```

Multi-stage, `node:22-slim`, non-root, `HEALTHCHECK` on `/v1/ready`. No
compiler is involved: `sweph` ships prebuilt N-API binaries for linux.

The design point is that **the ephemeris gets a stage of its own**, which
copies nothing but `ephemeris.manifest.json` and the fetch script. The 103 MB
of `.se1` data is immutable and slow to download — far slower than compiling
the whole engine — so its layer is keyed on the manifest and survives every
code, dependency and config change. It is re-downloaded when the manifest is
re-seeded, and never otherwise. The image ships the `full` profile at
`/app/ephem`, with `SE_EPHE_PATH` already pointing there.

## Licence

**AGPL-3.0-or-later.** See [LICENSE](LICENSE) and
[ADR 0004](docs/adr/0004-agpl-public-repo-mit-contract-package.md).

If you run a modified version of this service and users interact with it over a
network, AGPL §13 obliges you to offer them the corresponding source.
`GET /v1/meta/license` is how a network user finds it.

The whole repository is AGPL, including the contract. ADR 0004 anticipated a
separately MIT-licensed `packages/contract` for private frontends to depend on;
that package was not built. The contract is `GET /v1/openapi.json` instead — a
frontend fetches a description of an interface and generates its own client
from it, linking none of this code, so nothing needs a second licence to keep
the public/private split intact.

Swiss Ephemeris is © Astrodienst AG, used here under its AGPL option. A
professional licence from Astrodienst is the alternative, and it buys exactly
one thing: the right not to publish your source.
