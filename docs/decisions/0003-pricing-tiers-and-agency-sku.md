# ADR-0003: Price points and the Agency volume SKU

- **Status:** Accepted (2026-08-05)
- **Deciders:** FormFlow maintainers
- **Related:** [ADR-0001](0001-merchant-of-record-freemius.md), [ADR-0002](0002-annual-only-no-lifetime.md)
- **Amends:** ADR-0002 — which recorded *exactly two* paid plans. There are now three.

## Context

FormFlow launched at Pro $79/yr and Business $299/yr, both one project, annual.
Those numbers sit on the WordPress form-plugin band (Gravity Forms $59/$159/$259,
WPForms Agency $299.50) — a market with millions of price-sensitive sites and
volume we will never see.

FormFlow sells into Strapi, where the CMS vendor itself charges $540/yr for CMS
Growth, $1,800/yr for the SSO add-on alone, and $420–$5,400/yr per Cloud project.
Against those anchors a $79/yr plugin is ~7% of one Cloud Pro project, and — in an
ecosystem where the v4→v5 migration killed many plugins — it reads as a side
project rather than a maintained product. Small market plus low price is not a
business; low volume is precisely the condition that demands higher ACV.

The packaging had a second, larger problem: the tier ladder was purely
**feature**-based, leaving the **volume** dimension unpriced. An agency running 20
Strapi client sites needed 20 Pro licences, so in practice it ran the free tier on
all 20 and we earned nothing. Agencies are the natural buyer of a Strapi plugin.

## Decision

Three paid plans, all annual, all sold via Freemius:

| Plan | Price | Activations | Entitlement tier |
|---|---|---|---|
| Pro | US$149/yr | 1 project | `pro` |
| Business | US$449/yr | 3 projects | `business` |
| **Agency** | **US$999/yr** | **unlimited** | `business` |

The free MIT tier is unchanged — the open-core line stays exactly where it was.

**Agency is a volume SKU, not an entitlement tier.** It sells the Business feature
set with a larger activation quota. Quota is enforced by Freemius server-side, on
the licence; the plugin neither counts nor enforces activations.

## Rationale

- **Pro at $149** is $12.42/mo — still about a third of Strapi Cloud's *cheapest*
  tier, and less than an hour of contractor time against features that take weeks
  to build. It stays an obviously-yes purchase while no longer signalling "hobby".
- **Business at $449** targets a procurement buyer. GDPR retention, per-subject
  export/delete, audit log and approvals are bought by someone with a legal review
  and a vendor questionnaire; that buyer is *suspicious* of $299. Three activations
  match how that buyer actually runs (prod + staging + one more). It also makes
  a support promise survivable — at $299/yr a single support call erased the year.
- **Agency at $999** is the missing SKU. One number, not a range: a business
  approving a line item does not break at $999 and survive at $899, and a second
  agency SKU would only add a decision the buyer has to make and a plan we have to
  support. The ~6.7× multiple over Pro is what justifies "unlimited" on its own.
- **Annual-only stands** (ADR-0002). At these ACVs monthly billing buys churn and
  support load for nothing.
- **Support is "priority email support", listed on Business only** (Agency inherits
  it, as it inherits everything in Business). The bounded wording is the point: an
  open-ended "priority support" is unfunded at either price, since one deep
  debugging thread costs the same whoever opens it. Note the exposure is *worse* on
  Agency, not better — support load scales with installs, so revenue per install is
  ~$150 on Business (3 installs) versus ~$40 on Agency if a licence covers ~25 client
  sites. That is why the promise was narrowed rather than moved up a tier.

## Consequences

- ADR-0002's consequence "the adapter's `plan_id → tier` map has exactly two
  entries, and `mapTierFromName` recognizes exactly two plan names" is **superseded**:
  the map has three entries and the name matcher recognizes three names. Everything
  else in ADR-0002 — annual-only, no lifetime SKU, the `expiration`-absent handling,
  failing closed to `'free'` — is untouched and still binding.
- `Tier` in `server/src/ee/feature-map.ts` stays `'free' | 'pro' | 'business'`. Adding
  an `'agency'` tier would have forced a fourth column through `TIER_LIMITS`,
  `FEATURE_TIER` and `TIER_RANK` to express an entitlement identical to `business`.
  The volume difference lives in Freemius, which is the only component that can
  enforce it.
- `mapTierFromName` matches `agency` **before** `pro`, so a plan named e.g.
  "Agency Pro" cannot be downgraded to the `pro` tier.
- Unknown plan ids and unknown plan names still fail closed to `'free'`.
- **Checkout links must pin `licenses`** for any plan whose activation count is not 1
  (`0` = unlimited). The Freemius checkout defaults to a single licence, so a bare
  Agency link makes it search for a 1-activation price that does not exist and return
  an **empty page** — a silently dead buy button, not an error. Verified live:
  Pro `?licenses=1`, Business `?licenses=3`, Agency `?licenses=0`.
- Freemius plan ids: Pro `59829`, Business `59830`, Agency `60487`. Agency inherits
  via the plan's built-in "Include all Business features" checkbox, so features do
  not need to be mirrored by hand.
- Existing customers are grandfathered at their purchased price; Freemius renews a
  subscription at the price it was bought at unless we explicitly migrate it.
- The 14-day money-back guarantee is what makes the higher ask safe, and stays.

## Not decided here

- A free trial of Pro. The free tier is complete enough that a buyer never
  *experiences* a paid feature, so a trial is likely worth more than any price
  change recorded above. Freemius supports it natively. Deferred to its own change.
