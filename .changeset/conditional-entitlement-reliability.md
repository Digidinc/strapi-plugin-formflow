---
'@formflowjs/strapi-plugin-formflow': minor
---

Clarify Pro-gated Conditional Logic, recover license access without a page reload, make premium form authoring server-authoritative, preserve conditional relationships, and omit hidden fields and files from final submissions. Nested conditional visibility now follows the complete source graph and must ship with the matching graph-aware `@formflowjs/core` patch.

Ambiguous legacy saves that both delete an id-less email notification and edit another id-less premium-bearing notification are now rejected; save those operations separately so notification identity cannot be inferred from premium values.
