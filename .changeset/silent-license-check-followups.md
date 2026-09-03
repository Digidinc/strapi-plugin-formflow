---
"@formflowjs/strapi-plugin-formflow": patch
---

Follow-up corrections to the silent license check.

Gating: `LockedSection` in `replace` mode now withholds premium children while a check is unresolved instead of dimming them behind `aria-disabled`, which left them operable. A seeded provider mount whose own request fails now falls back to `unavailable` rather than presenting an entitlement it never confirmed. Retrying an unverifiable license keeps the warning and its Retry button on screen instead of unmounting them mid-click.

Presentation: a "Pro" badge no longer appears next to disabled controls while access is merely unresolved, which told paying customers they did not own what they had bought. Dismissing the grace or unavailable notice now lasts the browser session instead of returning on the next sidebar click. Surfaces that would have rendered an empty titled card during a check — the compliance panels, the analytics page and the approval panel — show a neutral loader. Tooltip, accessible-label and post-click copy are now worded for their own contexts.
