---
"@formflowjs/strapi-plugin-formflow": patch
---

Stop announcing the license check in the admin panel. "Checking FormFlow license…" no longer appears on any surface — the check is not something an administrator starts, it blocks nothing, and it settles on its own. Places that would otherwise be left empty while it runs, such as the compliance panels and the approval workflow, show a neutral loader instead of a licensing message.

Moving between FormFlow pages no longer replays license state. Its menu links are separate route mounts, so each navigation previously re-ran the check from scratch: premium controls flickered back to disabled, and a dismissed notice reappeared. Resolved access and the dismissal now both hold for the browser session, while the check still runs in the background and the server continues to gate every premium action.

A "Pro" badge no longer appears beside multi-step and conditional-logic controls while access is still unresolved, where it told paying customers they did not own what they had bought. Retrying an unverifiable license now keeps the warning and its Retry button on screen for the attempt, rather than hiding them the moment it is clicked.
