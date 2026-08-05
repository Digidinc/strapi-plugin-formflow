# ADR-0002: Annual-only pricing — no lifetime plan

- **Status:** Accepted (2026-07-29); partially amended by [ADR-0003](0003-pricing-tiers-and-agency-sku.md) (2026-08-05)
- **Deciders:** FormFlow maintainers
- **Related:** [ADR-0001](0001-merchant-of-record-freemius.md), [ADR-0003](0003-pricing-tiers-and-agency-sku.md)

> **Amendment.** ADR-0003 adds a third paid plan, **Agency** — a volume SKU carrying
> the Business feature set with a larger activation quota. The plan count below, and
> the "exactly two entries" / "exactly two plan names" consequence, are superseded by
> ADR-0003. Everything else here — **annual-only, no lifetime SKU**, and the handling
> of a paid plan with an absent `expiration` — remains in force.

## Context

Freemius supports a lifetime billing cycle natively, so a one-time-payment SKU was
technically available alongside recurring plans. This ADR records which billing
model FormFlow actually sells, because the adapter's plan model encodes it.

## Decision

Sell **annual recurring only**. Exactly two plans, **Pro** and **Business**, each
annual. **No lifetime SKU.**

## Rationale

A lifetime license is a perpetual obligation — updates, compatibility with each new
Strapi major, and support — funded by a single one-time payment. Annual recurring
revenue aligns income with the ongoing cost of keeping the plugin working, which a
one-time payment does not.

## Consequences

- The adapter's `plan_id → tier` map has exactly two entries, and
  `mapTierFromName` recognizes exactly two plan names. Anything else fails closed
  to `'free'`.
- A valid paid license always carries a populated `expiration`; renewals extend it.
  Because Freemius uses `null` for lifetime licenses, the adapter withholds premium
  entitlement from a recognized paid plan that has no expiration, rather than granting
  an unsold lifetime entitlement. It treats that as indeterminate rather than as a
  revocation: the response is otherwise the server affirming the license, and an
  absent or empty `expiration` must not hard-expire every paying customer at once.
  The grace window still closes the hole, since it cannot outlive 14 days.
- The product model stays simple: no one-time vs recurring split in the adapter.
