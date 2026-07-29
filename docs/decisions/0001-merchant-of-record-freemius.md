# ADR-0001: Merchant of Record — Freemius

- **Status:** Accepted (2026-07-29)
- **Deciders:** FormFlow maintainers
- **Related:** [ADR-0002](0002-annual-only-no-lifetime.md)

## Context

FormFlow is sold open-core: a public npm package gated at runtime by a license key
validated against a Merchant of Record (MoR) that also runs checkout, tax, and
payouts. The plugin runs on the **customer's** self-hosted Strapi, so the published
package must contain **no seller secret** — any credential we ship is a credential
we have given away. That constraint, not pricing or convenience, drives the choice
of provider.

## Decision

Use **Freemius** as the MoR and licensing backend. The license adapter
(`server/src/ee/license/mor-client.ts`) targets Freemius outright; there is no
dual-provider switch.

## Rationale

- **No seller secret ships.** Freemius's customer-portal license endpoints
  (`activate` / `validate` / `deactivate`) are unauthenticated — verified against
  the published OpenAPI. Auth is only the public `product_id`, the customer's
  `license_key`, and a client-generated `uid`.
- **Server-derived tiering.** Responses carry `plan_id` (and `license_plan_name`),
  so the tier maps directly from the server response and is never client-supplied.
- **Fits a self-hosted plugin.** First-class annual billing; `is_free_localhost`
  grants free dev/staging activations, which suits a plugin that customers run
  across local, staging, and production.
- **Hand-rolled `fetch`, no vendor SDK.** The official Freemius JS/TS SDK is
  backend-only (it requires the secret key), so using it would violate the
  no-secret invariant. The adapter calls the REST API directly instead.

## Consequences

- `mor-client.ts` is the sole place license HTTP lives. `service.ts` stays
  provider-agnostic — the entitlement state machine is unchanged apart from
  threading the instance `uid` into `validate`.
- The package ships three public build constants (`product_id` and two `plan_id`s).
  These are identifiers that appear in every checkout URL — not credentials.
- The no-secret invariant is enforced mechanically by
  `scripts/check-license-no-secret.mjs`, which fails the build if the adapter sets
  an authorization header, assigns a secret/token, or reads a `*SECRET*` env var.

## Alternatives considered

Other merchant-of-record providers were evaluated against the same criteria
(unauthenticated client-side validation, server-derived tiering, native annual
billing, and true MoR tax handling). Freemius was selected on the technical fit
described above. The comparative evaluation is kept outside this repository.
