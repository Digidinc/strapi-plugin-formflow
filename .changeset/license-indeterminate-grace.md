---
'@formflowjs/strapi-plugin-formflow': patch
---

Never revoke premium features because of a response that says nothing about the licence.

Two paths could switch off a paying install over something that was not a verdict on its key:

- An unrecognized rejection code from the licence API defaulted to a hard expiry. The API returns HTTP 402 for argument and seller-account errors, and can add new codes at any time, so a single upstream change could have disabled every install on its next daily check. Only the documented rejection codes revoke now; anything else counts as indeterminate and serves the cached entitlement inside the existing 14-day grace window.
- A paid plan returned without an expiration date was hard-expired. It now withholds premium entitlement through the same grace path, so an absent or empty date cannot disable every install at once. Lifetime-shaped licences still never grant premium.

Also fixes two logs that used to mislead. Running out of activation slots now reports `license_utilized` and how to free one, instead of reporting a network failure; and a corrupted instance identity is named rather than reported as unreachable.

The README now leads with what FormFlow does and why to install it, with the plan breakdown moved further down. Every premium feature is still listed, in a single table.
