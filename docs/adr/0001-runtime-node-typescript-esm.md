# 1. Node + TypeScript (strict, ESM) as the engine runtime

- Status: accepted
- Date: 2026-08-08

## Context

Three generations of this project exist. The one with the richest domain logic
— Layer 1/Layer 2 activation detection, themes scoring, transit refinement —
is the Node prototype, which had never been pushed to a remote. The one with a
working deployment (`sisco128/meteorite`, Render + Docker) is Python, and
older. Rewriting the domain logic in Python to reach the working deployment
would mean re-deriving the part that actually holds the value.

## Decision

Node + **TypeScript strict**, ESM.

Four compiler flags are treated as non-negotiable, each because it statically
catches a defect that shipped in the prototype:

| Flag                                 | Catches                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`           | `SIGNS[12]` — `degreesToSign` never normalised its input (`positions.js:9`) |
| `noPropertyAccessFromIndexSignature` | `result.speedLongitude` — the binding emits `longitudeSpeed`                |
| `exactOptionalPropertyTypes`         | optional fields silently present-but-undefined                              |
| `strict`                             | `any` banned; `unknown` plus a parse at every boundary                      |

ESM because the consuming frontends are ESM, and publishing
`@astro-engine/contract` as dual-format invites the dual-package hazard, where
zod schema identity breaks across the CJS/ESM boundary. `sweph` is CJS and
interoperates through Node's default-import interop.

## Consequences

The domain logic ports rather than being rewritten — the Layer 1/Layer 2
detection and the themes scoring model move across with their numbers intact,
which keeps behaviour verifiable against the prototype's output.

Deployment configuration does **not** carry over from `meteorite`; its
Dockerfile and `render.yaml` are a reference for structure only.

The `swisseph` → `sweph` binding change (ADR 0002) is a consequence of this
choice, not independent of it.

## Alternatives considered

- **Python + `pyswisseph`, continuing from `meteorite`.** A working deployment
  and a more mature binding, but the Layer 1/2 and themes logic — the part
  worth keeping — would have to be re-derived by hand.
- **Node core with a Python worker for ephemeris work.** Two runtimes to
  maintain for no benefit this project can currently name.
