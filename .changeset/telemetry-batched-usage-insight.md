---
'@formflowjs/strapi-plugin-formflow': minor
---

Extend anonymous telemetry with privacy-safe usage insight, shipped in one batched daily request.

The daily heartbeat now also reports `license_state`, active vs. total form counts, the largest form's field count, a bucketed submission total, the field types in use, the features configured, the database client, the OS platform, and whether the install runs in production or development. Every reported value is drawn from FormFlow's own fixed catalogs (field types, feature keys, enums) — operator- and user-authored text such as form titles, field labels, URLs, email addresses and submitted values is never read, and an unrecognised value is dropped rather than passed through.

Activity is now recorded too: `feature_gate_hit` (which paid feature was blocked, and how often), `plugin_upgraded`, `license_changed`, `form_published` and `export_performed`. None of it is sent as it happens — events accumulate in a local outbox, aggregate by kind with a count, and ship alongside the next daily heartbeat in a single request, so a busy install still costs about one request a day and telemetry never adds latency to a user request.

Payload changes are versioned via `telemetry_schema_version`, and the plugin falls back to the previous single-event shape if the ingestion endpoint does not yet accept batches, so delivery does not depend on deploy order.
