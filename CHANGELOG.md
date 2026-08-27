# @formflowjs/strapi-plugin-formflow

## 1.4.0

### Minor Changes

- 732086e: Recognize the new **Agency** plan, and record the updated price points.

  Agency sells the Business feature set with a larger activation quota. It is a **volume SKU, not a new entitlement tier**: quota is enforced server-side on the licence, so the plugin maps an Agency licence to the existing `business` tier and `Tier` stays `'free' | 'pro' | 'business'`. Introducing an `'agency'` tier would have threaded a fourth column through the limit, feature and rank maps to express an entitlement identical to Business.

  Both licence paths handle it: `validate()` maps the Agency plan id, and `activate()` matches the plan _name_ — checked ahead of `pro`, so a compound name like "Agency Pro" cannot be downgraded. Unknown plan ids and unknown plan names still fail closed to `free`, and a null or empty plan id still resolves to `free` rather than inheriting a plan slot.

  Paid plans are now Pro US$149/yr (1 project), Business US$449/yr (3 projects), and Agency US$999/yr (unlimited projects) — all annual, with no lifetime SKU. The free MIT tier is unchanged; the open-core line has not moved. Existing subscriptions renew at the price they were bought at.

## 1.3.1

### Patch Changes

- 61045f1: Never revoke premium features because of a response that says nothing about the licence.

  Two paths could switch off a paying install over something that was not a verdict on its key:
  - An unrecognized rejection code from the licence API defaulted to a hard expiry. The API returns HTTP 402 for argument and seller-account errors, and can add new codes at any time, so a single upstream change could have disabled every install on its next daily check. Only the documented rejection codes revoke now; anything else counts as indeterminate and serves the cached entitlement inside the existing 14-day grace window.
  - A paid plan returned without an expiration date was hard-expired. It now withholds premium entitlement through the same grace path, so an absent or empty date cannot disable every install at once. Lifetime-shaped licences still never grant premium.

  Also fixes two logs that used to mislead. Running out of activation slots now reports `license_utilized` and how to free one, instead of reporting a network failure; and a corrupted instance identity is named rather than reported as unreachable.

  The README now leads with what FormFlow does and why to install it, with the plan breakdown moved further down. Every premium feature is still listed, in a single table.

## 1.3.0

### Minor Changes

- a64e0fc: Migrate commercial licensing to Freemius, keep annual-only plans, and align the published ownership and Digid Inc. contact details.

## 1.2.1

### Patch Changes

- 8953772: Point upgrade/upsell links and repository metadata to the new Digidinc org after the GitHub org migration. The runtime 402 upgrade URLs, the admin upsell `PURCHASE_URL`, the README, and `package.json` now use `github.com/Digidinc/…` and `formflow.digid.ca`; the retired GitHub Pages URL previously left these upgrade links dead.

## 1.2.0

### Minor Changes

- b0775c7: Add Telegram notifications on every tier, with one connection on Free, two on Pro, and four on Business. Configure a customer-owned bot connection in FormFlow Settings, then enable a per-form rich-message template that posts to a Telegram chat, group, or channel after each final submission. Delivery is outbound-only and fire-and-forget: FormFlow never installs a webhook, reads updates, or delays the public submission response.

## 1.1.1

### Patch Changes

- 848a808: Allow additional time for the initial Lemon Squeezy activation request while retaining the shorter validation timeout.
- 25c173e: Add a public, license-independent endpoint for headless renderers to record a form start without affecting form interaction.

## 1.1.0

### Minor Changes

- 40e0a2e: Clarify Pro-gated Conditional Logic, recover license access without a page reload, make premium form authoring server-authoritative, preserve conditional relationships, and omit hidden fields and files from final submissions. Nested conditional visibility now follows the complete source graph and must ship with the matching graph-aware `@formflowjs/core` patch.

  Ambiguous legacy saves that both delete an id-less email notification and edit another id-less premium-bearing notification are now rejected; save those operations separately so notification identity cannot be inferred from premium values.

## 1.0.8

### Patch Changes

- 6b8134e: Harden the license engine: grant the validated entitlement in memory before persisting the cache, so a transient store failure can no longer leave a validly-licensed install on the free tier until the next daily refresh; unref the daily refresh timer so one-off CLI runs that skip the destroy hook don't keep the process alive; document that `expires_at` is deliberately not enforced client-side (Lemon Squeezy's `status` is the single source of truth, avoiding false expiry during subscription dunning windows).

## 1.0.7

### Patch Changes

- 95e6844: Add anonymous, opt-out usage telemetry so we can gauge active installs and prioritize work. A one-time install event plus a daily heartbeat report non-identifying data only (plugin/Strapi/Node versions, license tier, form count, an approximate country, and a hashed install id) — never form content, submissions, or secrets. Telemetry honors Strapi's own opt-out (`STRAPI_TELEMETRY_DISABLED`, removed project `uuid`) and a dedicated `FORMFLOW_TELEMETRY_DISABLED` env var, and never blocks startup.

## 1.0.6

### Patch Changes

- c5f3c1b: Align open-core licensing metadata with Strapi's convention. Declare `"license": "SEE LICENSE IN LICENSE"` in `package.json` (instead of `"MIT"`, which understated the dual-licensed `ee/` code), matching how `@strapi/*` packages do it, and replace the README's auto MIT badge with an honest "Open Core (MIT + EE)" badge. No change to the actual terms — the free core stays MIT and `ee/` stays under `LICENSE-EE` per the root `LICENSE` carve-out.

## 1.0.5

### Patch Changes

- c7ceb8e: Correct the website and pricing links to the current FormFlow site (`https://formflow.digid.ca/#pricing`). Updates the server 402 upgrade responses, the admin upsell UI (the shared `PURCHASE_URL`), and the README links.

## 1.0.4

### Patch Changes

- 37d8d68: Point all upgrade/upsell links to the public website pricing page (`https://formflow.digid.ca/#pricing`) instead of the placeholder `formflow.dev`. This updates the server 402 upgrade responses (form create/update, advanced export and other gated submission endpoints) and the admin upsell UI (the shared `PURCHASE_URL` used by `UpsellCard`, gated buttons, and the Pro field-type prompt). Also adds Website and Pricing links to the README.

## 1.0.3

### Patch Changes

- 408e073: Set the copyright holder and licensing contact in LICENSE, LICENSE-EE, and the package.json author field. The current commercial contact is Digid Inc. <info@digid.ca>.

## 1.0.2

### Patch Changes

- af8dc32: Widen peerDependencies so the plugin installs on any Strapi v5 (`>=5.0.0`) instead of only `5.33+`. Loosen `@strapi/design-system`, `@strapi/icons`, `react`, `react-dom`, `react-router-dom`, and `styled-components` ranges to accept what any Strapi v5 host ships, and drop the build-only `@strapi/sdk-plugin` from peers (it is never imported at runtime). Fixes `npm install` ERESOLVE errors on Strapi 5.0–5.32.

## 1.0.1

### Patch Changes

- 8f71e10: Harden licensing
