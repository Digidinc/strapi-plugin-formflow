---
"@formflowjs/strapi-plugin-formflow": patch
---

Harden the license engine: grant the validated entitlement in memory before persisting the cache, so a transient store failure can no longer leave a validly-licensed install on the free tier until the next daily refresh; unref the daily refresh timer so one-off CLI runs that skip the destroy hook don't keep the process alive; document that `expires_at` is deliberately not enforced client-side (Lemon Squeezy's `status` is the single source of truth, avoiding false expiry during subscription dunning windows).
