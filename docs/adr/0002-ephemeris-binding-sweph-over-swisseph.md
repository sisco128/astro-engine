# 2. Use `sweph` rather than `swisseph` as the Swiss Ephemeris binding

- Status: accepted
- Date: 2026-08-08

## Context

The prototype used `swisseph@0.5.17`. At the time of this decision it did not
load at all on the development machine:

```
NODE_MODULE_VERSION 131. This version of Node.js requires NODE_MODULE_VERSION 127
```

131 is Node 23, 127 is Node 22. The committed `build/Release/swisseph.node` had
been compiled under one and never rebuilt under the other. Eight of the
prototype's twenty-five tests were red as a direct result — precisely the eight
that touch real ephemeris maths.

That is not a one-time accident. `swisseph` is NAN-based, so its ABI is tied to
the V8 version and **every Node major re-breaks it**. `docs/SWISSEPH_INSTALL.md`
in the prototype exists entirely to document the resulting `node-gyp` /
Python-distutils recovery ritual.

The binding also shaped three of the prototype's worst bugs. Its `swe_calc_ut`
takes a callback of arity **one**, with errors delivered in `result.error`; the
prototype destructured `(result, err)` in three places, so `err` was
permanently `undefined` and every Swiss Ephemeris error passed as success.

## Decision

Use `sweph@2.10.3-7`.

|                   | `swisseph@0.5.17`                             | `sweph@2.10.3-7`                                                      |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| ABI model         | NAN — breaks every Node major                 | **N-API** (`node-addon-api@8`) — stable by design                     |
| Install           | `node-gyp rebuild`                            | prebuilds for `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64` |
| Swiss Ephemeris C | 2.09.03                                       | **2.10.03**                                                           |
| API shape         | callback of arity 1, errors in `result.error` | synchronous `{ data, flag, error }`                                   |
| Last publish      | 4 years ago                                   | 2 months ago                                                          |

Verified on Node 22.23.1: it loads with **no compilation** — no `node-gyp`, no
Python, no Xcode — and reports version `2.10.03`.

## Consequences

**The 2.09 → 2.10 jump is not incidental.** 2.10 adds native crossing solvers
that 2.09 does not have: `solcross_ut`, `mooncross_ut`, `mooncross_node_ut`,
`helio_cross_ut`. Confirmed present. These matter twice over for the transit
event engine (ADR 0007): they replace a JS scan-and-refine loop with one C
call, and they are an **independent implementation**, so the golden suite can
cross-check our own Brent root against `solcross_ut` for the Sun and get a free
correctness oracle at the sub-second level.

**The error contract is different, and the plan's assumption about it was
wrong.** Measured behaviour:

| Case                | `flag` | `error`                              |
| ------------------- | ------ | ------------------------------------ |
| Valid call          | 258    | empty                                |
| Moshier fallback    | 260    | **populated** ("using Moshier eph.") |
| Chiron out of range | **-1** | populated                            |

`error` is populated on _success_. Failure is signalled by a negative flag.
`src/ephemeris/swe.ts` tests the sign of the flag and treats `error` as
diagnostic text.

**A new hazard, absent from `swisseph` only because nothing checked.** Passing
an unrecognised body id (9999) does not fail: it returns flag 1048834, an empty
error, and a plausible longitude of 251.455°. `src/ephemeris/bodies.ts` holds an
explicit allowlist because the binding will not refuse one.

**Licensing.** `sweph`'s npm `license` field reads
`(AGPL-3.0-or-later OR LGPL-3.0-or-later)`, which appears to offer a permissive
escape. It does not. The project README qualifies it: _"If you own a
professional license for the Swiss Ephemeris, you may use any version of this
library under LGPL-3.0."_ Astrodienst's own page lists only AGPL and the
professional licence. SPDX cannot express "LGPL conditional on prior purchase",
so the packager collapsed it into an OR. See ADR 0004.

## Alternatives considered

- **Stay on `swisseph`, pin Node.** Pinning postpones the break rather than
  removing it, keeps the compile-from-source install, and leaves us on SE 2.09
  without the native crossing solvers.
- **A WASM build.** Removes the ABI problem entirely, but costs performance on
  what is a CPU-bound workload and the available packages are less maintained
  than `sweph`.
