---
'@formflowjs/strapi-plugin-formflow': minor
---

Recognize the new **Agency** plan, and record the updated price points.

Agency sells the Business feature set with a larger activation quota. It is a **volume SKU, not a new entitlement tier**: quota is enforced server-side on the licence, so the plugin maps an Agency licence to the existing `business` tier and `Tier` stays `'free' | 'pro' | 'business'`. Introducing an `'agency'` tier would have threaded a fourth column through the limit, feature and rank maps to express an entitlement identical to Business.

Both licence paths handle it: `validate()` maps the Agency plan id, and `activate()` matches the plan *name* — checked ahead of `pro`, so a compound name like "Agency Pro" cannot be downgraded. Unknown plan ids and unknown plan names still fail closed to `free`, and a null or empty plan id still resolves to `free` rather than inheriting a plan slot.

Paid plans are now Pro US$149/yr (1 project), Business US$449/yr (3 projects), and Agency US$999/yr (unlimited projects) — all annual, with no lifetime SKU. The free MIT tier is unchanged; the open-core line has not moved. Existing subscriptions renew at the price they were bought at.
