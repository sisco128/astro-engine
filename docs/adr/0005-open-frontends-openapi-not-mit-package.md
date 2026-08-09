# 5. Keep everything open; serve the contract as OpenAPI, not as an MIT package

- Status: accepted
- Date: 2026-08-09
- Supersedes: [ADR 0004](0004-agpl-public-repo-mit-contract-package.md), in part

## Context

ADR 0004 kept the engine AGPL-3.0 and proposed a `packages/contract` workspace
package under its own MIT licence, so that private frontends could depend on
the wire types without inheriting the obligation to publish.

That package was built and then removed before it merged. Building it made the
cost concrete: a pnpm workspace, a second `tsconfig`, a build step every test
run had to depend on, a vocabulary module the engine then had to import _back_
from the package to avoid two copies of the body ids drifting apart, and a
boundary test asserting the package never imports from `src/` — because the
moment it does, it becomes a derivative work of AGPL code and the MIT header on
it stops meaning anything.

Meanwhile the price of the alternative turned out to be published after all.
Astrodienst's [ordering page](https://www.astro.com/swisseph/swephprice_e.htm)
lists the Swiss Ephemeris Professional Edition at **700 CHF**, an unlimited
one-time licence. ADR 0004 was written believing the price was unpublished and
the purchase awkward; both premises were wrong.

## Decision

**Everything stays open.** The engine remains AGPL-3.0-or-later, and the
frontend applications will be open too. No separately-licensed package exists.

**The contract frontends consume is `GET /v1/openapi.json`**, generated at
runtime from the same zod schemas the engine validates requests with. Clients
generate typed clients from it.

## Consequences

**The split ADR 0004 protected is now protected by protocol rather than by
licence.** A frontend that only speaks HTTP is a separate program at arm's
length, and an OpenAPI document it fetches is data, not linked code. The
question the MIT package existed to answer — "can a private client import our
types?" — stops being asked, because no client imports anything.

**There is one source of truth for the wire shape.** The zod schemas validate
requests and generate the document from the same definitions, so the two cannot
disagree. The prototype's `client/src/types/api.ts` was a hand-maintained
mirror that every consumer had to keep correct by eye; this is the failure that
motivated a shared package in the first place, and generation removes it more
completely than publishing a package would have.

**Reversibility is unchanged, and is the reason this is safe.** The copyright
in this code belongs to one person, so relicensing later is always available.
The only external constraint is Swiss Ephemeris, and that constraint now has a
known, fixed price: 700 CHF, one-time, not recurring and not revenue-scaled. If
the project turns out to be worth closing, that is what closing it costs.

**What ADR 0004 got right stands.** AGPL-3.0-or-later for the engine, the
public repository as the way §13 is satisfied, and `GET /v1/meta/license` as
the way a network user finds the source. Those are unchanged.

**What is now stale in ADR 0004**: the `packages/contract` decision and its
Consequences section describing `packages/contract/LICENSE`, the `"license":
"MIT"` field and a CI assertion on it. None of those exist and none will be
built.

## Alternatives considered

- **Build the MIT package anyway, for later.** Carrying the workspace, the
  build step and the boundary test to solve a problem nobody has yet is cost
  paid now against a benefit that may never arrive — and if it does arrive, it
  arrives as 700 CHF rather than as an architecture.
- **Buy the professional licence now and close everything.** Premature for the
  same reason ADR 0004 gave: nothing about the current plan needs closed
  source. The difference is that the price is now known, so the decision can be
  made on evidence when there is something worth protecting.
