# 4. Publish under AGPL-3.0; licence the contract package MIT separately

- Status: partly superseded by
  [ADR 0005](0005-open-frontends-openapi-not-mit-package.md)
- Date: 2026-08-08

> The AGPL-3.0 decision below stands and is still in force. The
> `packages/contract` half does not: the package was built, then removed before
> merging, and the contract is served as `GET /v1/openapi.json` instead. Read
> ADR 0005 for what replaced it and why.

## Context

Swiss Ephemeris is offered by Astrodienst under exactly two terms: **AGPL-3.0**
(free) or a **professional licence** (paid, price not published — it requires a
signed contract returned by post and a purchase through their shop).

The `sweph` npm package declares `(AGPL-3.0-or-later OR LGPL-3.0-or-later)`,
which reads as though LGPL were freely available. It is not. The project README
qualifies it:

> "If you own a professional license for the Swiss Ephemeris, you may use any
> version of this library under `LGPL-3.0`."

Astrodienst's own licensing page lists AGPL and the professional licence only.
SPDX has no way to express "LGPL, conditional on a prior purchase", so the
packager collapsed the condition into an OR. **Without a professional licence
the terms are AGPL-3.0.**

This engine is designed to be called over HTTP by several frontend applications
living in separate, private repositories. AGPL-3.0 §13 obliges anyone running a
modified version that users interact with **over a network** to offer those
users the Corresponding Source.

Worth stating plainly, because it caused confusion: none of this has ever
required payment. Using Swiss Ephemeris is free. The professional licence buys
one thing only — the right _not_ to publish your source. Earlier projects
(`astro_app_1`, `meteorite`) triggered no obligation at all because they were
never distributed and had no third-party network users.

## Decision

`astro-engine` is a **public repository licensed AGPL-3.0-or-later**.

`GET /v1/meta/license` returns the licence identifier and the public source
URL, so a network user can locate the Corresponding Source. Publishing the
repository is what satisfies §13; the endpoint is how someone finds it.

**`packages/contract` carries its own MIT licence.**

## Consequences

**This is the one way the public/private split can fail.** Frontends that speak
to the engine only over HTTP are separate programs communicating at arm's
length; AGPL does not reach them, and they stay private. But
`@astro-engine/contract` lives _inside_ the AGPL repository, and a private
frontend that runs `pnpm add @astro-engine/contract` links it at build time. If
the package inherited AGPL, that argument collapses and every consuming
frontend would be obliged to publish.

Separating it is legitimate: the package contains no Swiss Ephemeris code at
all — zod schemas, inferred TypeScript types, and a generated `openapi.json`,
all original work describing an interface.

It must be **deliberate rather than inherited**:

- `packages/contract/LICENSE` containing the MIT text
- `"license": "MIT"` in its own `package.json`, not inherited from the root
- a note in `packages/contract/README.md` explaining why it differs
- a CI assertion on the field, so nobody "corrects" it into alignment later

**The trade is real.** Under AGPL the themes scoring model — the weights, the
stellium multipliers, the orb falloff — becomes public. If that turns out to be
the project's actual differentiator rather than the ephemeris arithmetic, the
professional licence becomes worth revisiting.

**Nothing here is irreversible.** The code is ours. A future decision to buy the
professional licence and close subsequent versions remains open; already-published
AGPL releases stay AGPL, and that is the whole extent of the lock-in.

## Alternatives considered

- **Professional licence now.** Unnecessary: nothing about the current plan
  requires closed source, the price is not published, and the purchase involves
  a posted paper contract.
- **Keep the repository private and hope §13 never fires.** It fires as soon as
  the frontends have users, which is the entire point of the project.
