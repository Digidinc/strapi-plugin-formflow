<p align="center">
  <img src="assets/logo.jpg" alt="FormFlow" width="120" height="120" />
</p>

# FormFlow

**The dynamic, headless form builder for Strapi v5.**

[![npm version](https://img.shields.io/npm/v/@formflowjs/strapi-plugin-formflow.svg)](https://www.npmjs.com/package/@formflowjs/strapi-plugin-formflow)
[![npm downloads](https://img.shields.io/npm/dm/@formflowjs/strapi-plugin-formflow.svg)](https://www.npmjs.com/package/@formflowjs/strapi-plugin-formflow)
[![License: Open Core](<https://img.shields.io/badge/license-Open%20Core%20(MIT%20%2B%20EE)-4945FF.svg>)](./LICENSE)
[![Strapi v5](https://img.shields.io/badge/Strapi-v5-4945FF.svg)](https://strapi.io)

FormFlow lets you build configurable forms visually in the Strapi admin panel and consume them over a clean REST API from **any** frontend. Forms, fields, validation, spam protection, notifications, and submissions all live in Strapi — your frontend just fetches the schema and posts the values. Truly headless: bring your own framework, your own styling, your own UX.

---

## Features

### Form builder & field types

A drag-and-drop form builder with a rich field registry:

- **Basic inputs** — text, textarea, email, number, phone, url, password
- **Choice** — select (dropdown), radio, checkbox, boolean (yes/no toggle)
- **Date & time** — date, time, datetime
- **Advanced** — file upload, hidden, signature, rating / NPS, address + map, rich text, calculated, payment, consent
- **Layout elements** — heading, paragraph, divider
- Per-field options: label, placeholder, description, default value, required flag, half/full width, and custom HTML attributes
- Live field preview and duplicate-form support

### Validation & logic

- Per-field validation rules with custom error messages
- Conditional visibility based on another field's value (**Pro**; also included in **Business**)
- Multi-step / wizard forms with per-step grouping and validation

### Submissions

- Submission inbox with list and detail views
- Status management (new, read, processed, archived, spam) and bulk actions
- Export to **CSV, JSON, Excel (XLSX), and PDF**, with optional scheduled exports
- Approval workflow (pending / approved / rejected) for forms that require manual review
- Submission count tracking per form

### Anti-spam

- Honeypot field (configurable field name)
- Google reCAPTCHA **v2 and v3** (with score threshold)
- Cloudflare **Turnstile**
- **hCaptcha**
- IP blocklist
- Per-form rate limiting

### Notifications & integrations

- Email notifications on submission (configurable recipients, subject, reply-to, and templates)
- Customer-owned Telegram rich-message notifications (**Free: 1 connection, Pro: 2, Business: 4**) with tokens managed from the Strapi admin; outbound-only, with no deployment or webhook required ([setup guide](docs/telegram.md))
- Outgoing webhooks (POST/PUT, custom headers, `submission.created` / `submission.updated` events)
- Pre-built integrations: **Slack, Google Sheets, Mailchimp, HubSpot, Notion, Zapier, and Make**

### Internationalization

- Per-form locale content overrides (localized labels, placeholders, descriptions, option labels, and success messages) served through the public API by locale

### Save & resume

- Persist partial submissions and return a resume token so users can continue a long form later

### Analytics

- Per-form metrics: views, starts, completions, and drop-off

### Compliance

- Consent capture field
- Configurable data retention
- IP anonymization
- Per-subject data export and deletion with an audit log

### Access control

- Role-based access control (RBAC) integrated with Strapi's Settings → Roles → Plugins, with granular actions for reading, creating, updating, deleting, and exporting forms and submissions

### Headless content API + official SDKs

- Public, configurable REST API under `/api/formflow` for fetching schemas and submitting values
- Sanitized public schema (server-only secrets such as the reCAPTCHA secret key are never exposed)
- Official headless frontend renderers for React and Vue (see below)

---

## Installation

```bash
# npm
npm install @formflowjs/strapi-plugin-formflow

# yarn
yarn add @formflowjs/strapi-plugin-formflow
```

Enable the plugin in `config/plugins.ts` (or `config/plugins.js`):

```ts
export default {
  formflow: {
    enabled: true,
  },
};
```

> **Requires Strapi v5.** FormFlow creates its own content types automatically on startup — no manual migration is needed.

Rebuild the admin panel so the FormFlow UI is bundled in:

```bash
npm run build
npm run develop
```

> **Testing a locally linked build:** after `yalc push`, stop the consuming Strapi app, remove its generated `.strapi/`, `node_modules/.strapi/`, `.cache/`, `.vite/`, `build/`, and `dist/` directories, then rebuild and restart. Otherwise Strapi or Vite may continue serving a stale admin bundle.

---

## Quick start

1. **Create a form.** In the Strapi admin, open **FormFlow** from the main left sidebar (the FormFlow icon), create a form, add fields in the builder, configure validation and settings, and activate it. Note the form's **slug**.

2. **Fetch the schema** from your frontend:

   ```bash
   curl https://your-strapi.example.com/api/formflow/forms/contact
   ```

   Returns the sanitized schema — `title`, `description`, `slug`, `fields`, and public `settings`.

3. **Submit values.** The request body is a flat map of field names to values:

   ```bash
   curl -X POST https://your-strapi.example.com/api/formflow/forms/contact/submit \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Ada Lovelace",
       "email": "ada@example.com",
       "message": "Hello from FormFlow!"
     }'
   ```

   On success you receive `{ "data": { "success": true, "message": "...", "redirectUrl": null } }`. Validation failures return HTTP `400` with a per-field error map.

> For `file` fields, send the request as `multipart/form-data` instead of JSON.

---

## Frontend SDKs

You don't have to wire up fetch calls and rendering by hand. The official **headless** SDKs fetch the schema, render the fields, run validation, and submit for you — framework-agnostic and **bring-your-own-styling** (no CSS shipped, works with Next.js, Astro, Vite, Nuxt, and more). They're built on the shared `@formflowjs/core` engine.

```bash
# React
npm i @formflowjs/react

# Vue
npm i @formflowjs/vue
```

Repository and docs: **https://github.com/Digidinc/formflow-sdk**

---

## Content API

All public endpoints are mounted under `/api/formflow` and are unauthenticated by default (configurable via Strapi route policies).

| Method | Path                                             | Description                                                    |
| ------ | ------------------------------------------------ | -------------------------------------------------------------- |
| `GET`  | `/api/formflow`                                  | Plugin index / health check                                    |
| `GET`  | `/api/formflow/forms/:slug`                      | Get a form's sanitized public schema (optionally per `locale`) |
| `POST` | `/api/formflow/forms/:slug/submit`               | Submit values for the form                                     |
| `POST` | `/api/formflow/forms/:slug/partial`              | Save a partial submission and receive a resume token           |
| `GET`  | `/api/formflow/forms/:slug/partial/:resumeToken` | Resume a saved partial submission by token                     |
| `POST` | `/api/formflow/forms/:slug/analytics/start`      | Record a form-start analytics event (the headless SDKs call this) |

---

## Configuration

FormFlow works out of the box with no configuration. Optional plugin options can be set in `config/plugins.js` (or `.ts`) under the `formflow` key:

```js
// config/plugins.js
module.exports = () => ({
  formflow: {
    enabled: true,
    config: {
      // Mask submitter IP addresses before storage (IPv4 last octet zeroed,
      // IPv6 truncated to the /64 prefix), in both the stored `ipAddress`
      // column and `metadata.ipAddress`. Requires a Business license to take
      // effect. Default: false (raw IP stored).
      anonymizeIp: false,

      // When > 0, a daily cron deletes submissions older than this many days.
      // Requires a Business license to take effect. Default: 0 (disabled;
      // submissions are kept indefinitely and no cron is registered).
      dataRetentionDays: 0,

      // Optional instance-wide reCAPTCHA defaults. Per-form spam settings take
      // precedence; secrets here are server-only and never returned publicly.
      recaptcha: {
        enabled: false,
        siteKey: '',
        secretKey: '',
        version: 'v3', // 'v2' | 'v3'
        threshold: 0.5, // v3 score threshold
      },
    },
  },
});
```

| Option              | Type      | Default | Description                                                                     |
| ------------------- | --------- | ------- | ------------------------------------------------------------------------------- |
| `anonymizeIp`       | `boolean` | `false` | Mask submitter IPs before storage. Requires a **Business** license.             |
| `dataRetentionDays` | `number`  | `0`     | Daily-purge submissions older than N days; `0` disables. Requires **Business**. |
| `recaptcha`         | `object`  | —       | Instance-wide reCAPTCHA defaults (per-form settings take precedence).           |

The license key is provided via the **`FORMFLOW_LICENSE_KEY`** environment variable (server-only; never returned in public responses). Without it, FormFlow runs as the fully-functional free tier.

Both privacy options are OFF by default, so existing installs are unaffected until an administrator opts in **and** holds the required license entitlement.

### Troubleshooting your license

**Your license activates each installation against an activation slot.** Your plan includes a fixed number of slots, and each distinct installation consumes one. Most problems below come from a slot still being held by an installation you no longer use.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Premium features stay off and the logs show a license-quota message | Every activation slot is in use — often by an old installation | Deactivate the stale site from your account dashboard, then restart Strapi |
| Features were working, then stopped after a database reset or restore | A reset clears the stored installation identity, so the plugin registers as a **new** installation while the old one still holds the slot | Deactivate the old site from your account dashboard, then restart Strapi |
| Features stopped after changing `FORMFLOW_LICENSE_KEY` and changing it back | Each key change re-registers the installation; the previous registration keeps its slot | Deactivate the old site from your account dashboard, then restart Strapi |
| Features stopped after moving to a new server or container | The new host registers as a separate installation | Deactivate the old site from your account dashboard, then restart Strapi |
| Everything works locally but not in production | The license key is missing from the production environment | Confirm `FORMFLOW_LICENSE_KEY` is set in the production `.env` and restart |

**Avoiding it:** the plugin stores a stable installation identity in the Strapi database, so ordinary restarts, redeploys, and code updates reuse the same slot and never consume a new one. Only a database reset, a license-key change, or a move to a different host creates a new registration. If you routinely rebuild environments (ephemeral CI, preview deployments), contact support to raise your activation quota.

**If your license lapses:** a revoked, cancelled, or expired key removes premium features at the next license check — within 24 hours, or immediately if an administrator refreshes the license from the FormFlow settings page. The 14-day grace period covers **network outages only**: if the license service is unreachable, premium features keep working from the cached entitlement. **Your forms, submissions, and data are never affected** — only premium features are gated, and the free tier stays fully functional.

---

## Links

- **Website:** https://digidinc.github.io/formflow
- **Pricing & plans:** https://digidinc.github.io/formflow/#pricing
- **Commercial support:** info@digid.ca
- **Repository & issues:** https://github.com/Digidinc/strapi-plugin-formflow
- **Frontend SDKs:** https://github.com/Digidinc/formflow-sdk (`@formflowjs/react`, `@formflowjs/vue`)

## Telemetry

FormFlow sends **anonymous, opt-out** usage telemetry so we can see how many installs are active and prioritize what to build. We never collect personal data, form content, submissions, or environment secrets.

Each install sends a one-time install event plus a daily heartbeat containing only:

- An anonymous install id (a SHA-256 hash of your Strapi project UUID — not reversible to your project)
- Plugin version, Strapi version, and Node.js version
- License tier (`free` / `pro` / `business`) and total number of forms
- Approximate country (derived at the edge, never your IP)

**Opt out** at any time by setting:

```bash
FORMFLOW_TELEMETRY_DISABLED=true
```

Telemetry is also disabled automatically if you've disabled Strapi's own telemetry (via `STRAPI_TELEMETRY_DISABLED`, `npx strapi telemetry:disable`, or removing the project `uuid`).

## License

FormFlow is **open-core**:

FormFlow is developed and maintained by **Bardiya Rahimi** and commercially
published by **Digid Inc.**, which is authorized to distribute and commercially
license the software.

- The free core — every file **except** those under an `ee/` directory — is licensed under the [MIT License](./LICENSE).
- The premium **Enterprise Edition** code (under `server/src/ee/` and `admin/src/ee/`, powering the Pro and Business features) is source-available under the [FormFlow EE License](./LICENSE-EE). You may view and evaluate it, but **production use requires a valid license key**.

Pro/Business features are gated at runtime by a license key (`FORMFLOW_LICENSE_KEY`). Without one, FormFlow runs as the fully-functional free tier — your forms and submissions always work.
