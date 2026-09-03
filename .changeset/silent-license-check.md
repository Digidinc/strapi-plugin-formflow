---
"@formflowjs/strapi-plugin-formflow": patch
---

Stop announcing the background license check in the admin panel. "Checking FormFlow license…" no longer renders on any surface — the check is not something an administrator starts, it blocks nothing, and it settles on its own. The notices that do need saying are unchanged: unverifiable access still raises the warning with its Retry action, and grace-period access still shows its deadline.

The license provider now also keeps the last settled snapshot for the browser session. FormFlow's menu links are sibling route mounts, so moving between its pages remounts the provider; without the seed, resolved access dropped back to `checking` on every navigation and briefly disabled premium controls.
