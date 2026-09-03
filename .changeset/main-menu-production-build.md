---
"@formflowjs/strapi-plugin-formflow": patch
---

Fix the FormFlow main menu link crashing in production admin builds with `Cannot destructure property 'App' of '(intermediate value)' as it is undefined`. The loader now returns `import('./pages/App').then(({ App }) => ({ default: App }))`, matching the Settings and Compliance links, so Rollup no longer rewrites the call site into a shim that drops the chunk namespace.
