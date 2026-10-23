# 6. Expose the engine to Claude as a remote MCP connector

- Status: accepted
- Date: 2026-10-23

## Context

Everything this engine computes reaches people through frontends that call
`/v1` over HTTP. Claude can be one more client of the same engine, through the
Model Context Protocol: a connector added once in claude.ai shows up in Claude
on the web, in Claude Desktop and on mobile, and Claude Code takes the same
server with one command.

The fit is unusually good, for a reason this project chose long before MCP was
on the table: **the engine calculates and does not interpret.** Every response
is numbers and stable identifiers, and the interpretation is left to the
client. A language model is a client whose whole strength is interpretation,
and whose weakness is exactly the arithmetic the engine does: ephemeris
lookups, house cusps, root-finding for the instant of an exact transit.

Three facts constrain the design, and all three were checked rather than
assumed.

**claude.ai connectors authenticate with OAuth or not at all.** Anthropic's
documentation for custom connectors describes authless and OAuth servers, with
an optional OAuth client id and secret under Advanced settings. Nothing in that
documentation lets a connector send a static header, so the `x-api-key` that
every `/v1` route requires cannot be configured in claude.ai. Claude Code can
send any header (`claude mcp add --header`), and the Messages API's MCP
connector sends a bearer token.

**Some responses are too large to hand to a model whole.** Measured on the
reference chart (12 Aug 1987, 11:32, Rome) against a local engine with the
`full` ephemeris and a cold cache:

| Response                          | Bytes   | ≈ tokens | Time   |
| --------------------------------- | ------- | -------- | ------ |
| `/v1/charts`                      | 6.8 KB  | 2,100    | —      |
| `/v1/transits/key-dates`, 1 year  | 8.6 KB  | 2,700    | 1.2 s  |
| `/v1/transits/key-dates`, 5 years | 42 KB   | 13,300   | 5.9 s  |
| `/v1/transits/key-dates`, 15 yrs  | 163 KB  | 51,000   | 16.8 s |
| `/v1/transits/story-windows`      | 4.2 KB  | 1,300    | 4.8 s  |
| `/v1/transits/returns`, 100 years | 11.7 KB | 3,700    | 1.3 s  |

Token counts are estimated at about 3.2 bytes per token of JSON. Claude Code
warns above 10,000 tokens of MCP output and truncates at 25,000 by default, so
the span `/v1` allows for key dates, fifteen years, produces about twice what
one tool result can carry. Rounding every float to four decimals and every
timestamp to the minute was also measured: it saves about 22%, which does not
change that picture and would make the MCP answer disagree with the `/v1`
answer for the same input.

**The route handlers hold logic that the domain layer does not.** Span checks
and `WINDOW_TOO_LARGE`, funnel preset resolution, cache keying, dispatch to the
compute pool and response assembly all live in `src/http/routes/v1/`.
key-dates is 259 lines and story-windows 288. A second caller that wanted the
same answers would need either all of that or a way to go through it.

## Decision

**Mount an MCP endpoint in the existing Fastify app, at `/mcp`, outside
`/v1`.** It uses the Streamable HTTP transport in stateless mode (no session
ids) with plain JSON responses: nothing here streams or needs a session. It
ships in the same image and the same Render service, and uses the same pool,
cache and ephemeris. It sits outside `/v1` because it is not part of the HTTP
contract: the OpenAPI document does not describe it, and the route-coverage
test in `tests/contract/openapi.test.ts`, which scans `/v1/` paths only,
correctly ignores it.

### Five tools, each a thin wrapper over an existing route

| Tool                | Wraps                             | What Claude uses it for                    |
| ------------------- | --------------------------------- | ------------------------------------------ |
| `search_place`      | `GET /v1/geo/search`              | "Rome" → coordinates and IANA zone         |
| `natal_chart`       | `POST /v1/charts`                 | Positions, angles, houses, natal aspects   |
| `key_dates`         | `POST /v1/transits/key-dates`     | The transit funnel over a span             |
| `story_windows`     | `POST /v1/transits/story-windows` | Past windows of one story, strongest first |
| `planetary_returns` | `POST /v1/transits/returns`       | Returns and half-returns, with life phases |

**Each tool calls its route through `app.inject()`**, in process, with no
socket. The route stays the authority: it validates, resolves the local time,
checks the span, keys the cache, runs the pool and assembles the response,
exactly as it does for Navigate. Nothing is reimplemented, so nothing can
drift, and the existing contract and golden suites keep covering what Claude
receives.

**Tool input schemas are derived from the existing zod request schemas**, by
`.omit()` and `.extend()` on `ChartRequestSchema`, `KeyDatesRequestSchema` and
the rest, so that a field added to `/v1` reaches the tools in the same commit.
Arguments go into the injected request body as they are, and the route parses
them again. That second parse is cheap, and it is what keeps the route the
authority.

The MCP surface is narrower than `/v1` in three deliberate places:

- **`key_dates` accepts spans of up to five years**, against fifteen over
  HTTP. Five years measured at about 13,000 tokens, which is inside what one
  result can carry. The tool description tells Claude to ask year by year for
  longer stretches.
- **`key_dates` and `story_windows` take funnel presets only**
  (`funnel.default`, `funnel.strict`, `funnel.prototype`), not a custom
  `FunnelConfig`, and do not offer `scoring` (v2 always). A custom
  configuration can raise the density without bound, which defeats the size
  budget, and a full funnel schema is a lot of input surface for a model to
  get wrong.
- **`story_windows` accepts a `limit` of up to 20**, against 120 over HTTP.

`/v1/meta/funnel` and `/v1/meta/life-phases` are not tools. What a model needs
from them (the tier roles, the presets, the fact that returns arrive already
labelled with their phase) goes into tool descriptions and the server
instructions instead, where it costs nothing per call.

### Sign annotations in the MCP layer, and only there

`/v1` stays exactly as it is: numbers and identifiers, no `sign`, no
`formatted`. The contract tests that walk each payload for those keys are not
touched and keep passing, which is also the proof that nothing leaked.

The MCP layer adds a label next to each ecliptic longitude:

```json
{ "id": "sun", "lon": 139.1556628718923, "zodiac": "19°09′ Leo", "house": 10 }
```

Where the longitude is a bare number rather than a field of an object, the
label sits beside its siblings instead: `angles.zodiac` maps each ecliptic
angle to its label, `houses.zodiac` is the twelve cusps' labels in order, and
each path step's `lonAtKey` is joined by `zodiacAtKey`.

The rule exists because rendering is a frontend's job and every frontend
should render it its own way. Here the frontend is a language model, and
turning `139.1557` into "19°09′ Leo" is a small piece of arithmetic that models
get wrong often enough to matter. The engine already owns that arithmetic,
in `signIndex` and `degreesInSign` in `src/math/angle.ts`, so the annotation
reuses them and the `% 360` rule holds.

Three details matter more than they look:

- **The fields to annotate are named explicitly, per tool**, never found by a
  walker that annotates any key called `lon`. The chart response carries
  `geo.lon`, which is a terrestrial longitude, and `angles.armc`, which is a
  right ascension. A generic walker would give both of them a zodiac sign.
  The annotated fields are `bodies[].lon`, `angles.ascendant`,
  `angles.midheaven`, `angles.vertex`, `angles.equatorialAscendant`,
  `houses.cusps[]`, `stories[].a.lon` and `.b.lon`, and `lonAtKey` on every
  tier of a key-date or story-window path.
- **Minutes are truncated, never rounded**, so 29.9999° reads as "29°59′
  Pisces" and never as "29°60′ Pisces" or "30°00′ Pisces". Truncation brings
  its own trap: 75.1 is 15.099999999999994 within Gemini as a double, and a
  plain floor printed 15°05′. The arcminutes are nudged by a hundred-millionth
  of one before truncating, and clamped below the thirtieth degree.
- **Sign names are English.** Claude translates them as it writes, as a
  frontend would localise.

Numbers are not rounded. The 22% saving is not worth an MCP answer that
disagrees with the `/v1` answer for the same input.

### Authentication: header keys for Claude Code, URL tokens for claude.ai

Two routes, one per kind of client:

- **`POST /mcp`** takes `x-api-key`, or `Authorization: Bearer <key>`, matched
  against `API_KEYS` with the same SHA-256 digests and the same
  `timingSafeEqual` loop as every `/v1` route. This is what Claude Code (with
  `--header`) and the Messages API's MCP connector (with a bearer token) use.
- **`POST /mcp/:token`** takes a token in the path, matched against a new
  `MCP_URL_TOKENS` the same way. This is what a claude.ai custom connector
  uses, and through it Claude Desktop and mobile.

**The URL tokens are a separate list from `API_KEYS`, on purpose.** A URL gets
copied more than a header does: it is shown on the connector settings screen,
it ends up in screenshots, and it passes through proxy logs. A leaked token
has to be revocable without rotating the key Navigate runs on, and it must not
work as an `x-api-key` on `/v1`. Each token must be at least 32 characters, and
the process refuses to start otherwise, as it already does for an open
production deployment.

**The token must never reach a log.** Fastify's request serializer logs
`req.url`, which would write every token into Render's logs on every call. A
`req` serializer rewrites `/mcp/<token>` to `/mcp/:token` before anything is
written, and a test captures the logger and asserts the token appears nowhere.
A wrong token gets the usual `401` envelope, which does not echo the URL.

**How the injected calls get past the auth hook.** The `onRequest` hook runs
for injected requests too. At startup `buildApp` generates a 32-byte random
internal key, adds its digest to the accepted set, and never logs it, sends it
or stores it anywhere but that closure. It can do exactly what any API key can
do. Each injected call carries it, along with `x-caller-id: mcp:<digest prefix
of the outer credential>`, so the existing per-reader rate-limit buckets give
every MCP caller its own allowance. The outer `/mcp/:token` request is bucketed
by its token digest when the token is valid, the same way the outer request
on `/mcp` is already bucketed by its key, so other traffic from Anthropic's
shared egress addresses cannot exhaust it.

The posture follows the rest of the engine. In development with an empty
`API_KEYS`, `/mcp` is open, like everything else. `/mcp/:token` is mounted only
when `MCP_URL_TOKENS` is non-empty.

**OAuth is deferred, with a stated trigger.** A URL token is a bearer secret
with no expiry and no identity behind it. That is acceptable while the people
using the connector are the people who run the engine. The trigger to build
OAuth is anyone else needing access, for example offering the connector to
Navigate's users. At that point an authorization server is needed, either
self-hosted or a hosted identity provider, with dynamic client registration or
a pre-registered client.

### Errors are answers Claude can act on

A non-2xx envelope from the route becomes a tool result with `isError: true`
whose content is the envelope's `{ code, message, details }`. JSON-RPC errors
are kept for malformed protocol messages and unknown tools. The tool
descriptions name the codes a model can do something about:

- `NONEXISTENT_LOCAL_TIME`, `AMBIGUOUS_LOCAL_TIME`: ask the person which side
  of the clock change they meant, or use `utc`.
- `HOUSE_SYSTEM_UNDEFINED_AT_LATITUDE`: retry with one of
  `LATITUDE_SAFE_SYSTEMS` (Whole Sign, Porphyry, Equal, Morinus) and say so.
- `WINDOW_TOO_LARGE`: split the span.
- `STORY_NOT_IN_CHART`: the signature came from a different chart.
- `COMPUTE_*`, `SERVICE_OVERLOADED`: retry later.

### Server instructions

Sent once, at `initialize`, and kept short. They cover:

- **The workflow:** `search_place`, then `natal_chart`, then the transit
  tools, with story signatures taken from `key_dates` and passed to
  `story_windows`.
- **The frame:** tropical, geocentric, Placidus by default.
- **Unknown birth times:** the engine assumes 03:00 local time, the response
  says so in `birthTime`, and anything that depends on the hour (angles,
  houses, stories flagged `timeSensitive`) has to be presented to the person
  as uncertain. This is the same promise the engine makes to every frontend,
  and a model is the client most likely to drop it.
- **The division of labour:** the numbers are the engine's, the reading is
  Claude's, and an interpretation should never contradict a number the engine
  returned.
- **The licence and source**, as described next.

### AGPL-3.0 §13

The MCP layer is part of this repository and is AGPL like the rest of it. The
SDK is MIT, which is compatible. Someone using the engine through Claude is
interacting with it over a network, so the source offer has to reach them too.
It does so in three ways:

- **The server instructions** name the licence and the source URL
  (`SOURCE_URL`), and tell Claude to give the link when asked.
- **Each tool result** carries a small `license: { id, source }` block,
  about 20 tokens, so the offer is in the evidence of every answer and not
  only in an instruction a client may summarise away.
- **`GET /v1/meta/license`** stays public, as it is now.

A person in claude.ai never sees server instructions directly, which is why
the per-result block is there. Whether this counts as "prominently offering"
the source is a judgement, not legal advice. This design aims for the
conservative reading.

## Consequences

**One deploy, one pool, one cache.** A chart Claude asks for and the same
chart asked for by Navigate share a cache entry. Merging deploys both, because
Render auto-deploys `main`.

**One new dependency, `@modelcontextprotocol/sdk`, pinned exact.** It is the
heaviest dependency in the tree by far: its direct dependencies include
express, hono, `@hono/node-server`, ajv, jose and cors, for transports and
auth helpers this engine will not use. Only `McpServer` and the Streamable HTTP
server transport are imported. The alternative is below.

**The `/v1` contract does not move.** `docs/openapi.json` is unchanged, and the
no-presentation tests, the golden suite and Navigate see nothing different.

**The MCP surface has its own small contract**, pinned by its own tests:

- `tests/contract/mcp.test.ts`: an `initialize`, `tools/list`, `tools/call`
  round trip through `inject`; parity with `/v1` (the same input gives the same
  numbers, plus annotations); the span and limit caps; and the error mapping.
- `tests/contract/mcp-auth.test.ts`: keys, bearer tokens, URL tokens, wrong
  tokens, and the token never appearing in the logs. The logs are read
  through a `logStream` option on `buildApp`, the second seam in that function
  after `geoFetch`, because the claim is about the logs and only reading them
  can check it. With the redaction disabled, the test fails.
- `tests/contract/rate-limit.test.ts`: a valid token spends its own allowance,
  a second token is untouched, and a wrong one gets none.
- `tests/unit/env.test.ts`: the startup refusal for a short or non-base64url
  token, through the exported `parseUrlTokens`.
- `tests/unit/zodiac.test.ts`: 0°, 29.9999°, 359.9999°, 75.1°, inputs below 0
  and at or above 360, and the minute truncation.

**Files.** `src/mcp/tools.ts` (definitions, schemas and handlers),
`src/mcp/zodiac.ts` (the label and the per-tool annotators),
`src/mcp/server.ts` (one `McpServer` per request, with the instructions),
`src/http/routes/mcp.ts` (the routes and the token check), and
`src/http/credentials.ts` (the digest comparison, moved out of `app.ts` now
that two kinds of secret use it). The routes use the SDK's web-standard
transport rather than its Node one, so the answer goes back through `reply`
with this app's headers and hooks instead of being written to the raw socket.
Plus changes to `src/http/app.ts` (internal key, token routes, rate-limit
buckets, log serializer), `src/config/env.ts` (`MCP_URL_TOKENS`),
`.env.example`, `render.yaml` (`MCP_URL_TOKENS` as `sync: false`) and a README
section on adding the connector.

**Rollout.** Merge, let Render deploy, set `MCP_URL_TOKENS` in the dashboard,
then in claude.ai go to Settings → Connectors → Add custom connector and enter
`https://<host>/mcp/<token>`. For Claude Code:

```bash
claude mcp add --transport http astro-engine https://<host>/mcp --header "x-api-key: <key>"
```

## Alternatives considered

- **Call the domain functions directly instead of `inject()`.** This needs no
  internal key, but first the route handlers would have to be refactored into
  reusable cores. That is a large diff through the two biggest handlers, and
  it leaves two call paths to keep equal. Worth revisiting when the handlers
  are refactored to emit through response schemas, which `openapi.ts` already
  anticipates.
- **Write the JSON-RPC by hand instead of using the SDK.** A stateless server
  needs `initialize`, `tools/list`, `tools/call` and `ping`: about 150 lines,
  with no new dependencies. Rejected because protocol version negotiation and
  every future spec revision would become this project's to track, and that is
  a moving target.
- **A separate MCP service calling `/v1` over the network.** A second deploy,
  a second auth hop and network latency per call, for no gain.
- **A local stdio server, or a Claude Desktop extension.** Every machine would
  need the 103 MB ephemeris and the worker pool, and claude.ai on the web and
  on mobile cannot use a local server at all. Remote covers every surface.
- **OAuth now.** Real work, with an authorization server to run or rent,
  solving a problem that does not exist while the only users are the
  operators. Deferred with the trigger stated above.
- **Interpretation in the engine.** No. That rule is why this fits.

## Review

Proposed with five choices marked for a second opinion, all accepted as
recommended on 2026-10-23:

1. **Sign annotations in the MCP layer**, rather than keeping MCP output
   exactly as `/v1`.
2. **The label as a string, `"19°09′ Leo"`**, rather than a structured
   `{ sign: "leo", degInSign: 19.156 }`, which would keep to identifiers but
   leave the minute arithmetic to the model.
3. **URL tokens now, OAuth later**, rather than OAuth first.
4. **Presets only for the funnel, a five-year cap, `limit` ≤ 20**, rather than
   the full `/v1` surface.
5. **A licence block in every tool result**, rather than relying on the server
   instructions alone.
