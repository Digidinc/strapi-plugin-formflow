# FormFlow documentation index

Durable knowledge for FormFlow, organized by reader need. Volatile mechanics live
in code, types, and tests; this index points to the decisions and designs behind
them.

## Start here
- [`../CLAUDE.md`](../CLAUDE.md) — canonical contract: commands, conventions, build rules.
- [`../architecture.md`](../architecture.md) — data models, routes, and implementation plans.

## Decisions (ADRs)
- [ADR-0001 — Merchant of Record: Freemius](decisions/0001-merchant-of-record-freemius.md)
- [ADR-0002 — Annual-only pricing, no lifetime](decisions/0002-annual-only-no-lifetime.md)

## Subsystems
- [Telegram integration](telegram.md)

## Licensing / MoR (map)
The EE license engine lives in `server/src/ee/license/`:
- `service.ts` — provider-agnostic entitlement state machine (activate → validate →
  cache → 14-day grace → hard-expire). Do not change per-provider.
- `mor-client.ts` — the MoR adapter (Freemius). The **only** place HTTP details live.
  Invariant: ships no seller secret (guarded by `scripts/check-license-no-secret.mjs`).
- `../feature-map.ts` — feature → tier table (`free` / `pro` / `business`).
