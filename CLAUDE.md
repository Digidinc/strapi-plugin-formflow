# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FormFlow is a Strapi v5 plugin for creating dynamic, configurable forms through the admin panel. It follows a headless CMS architecture where forms are managed in Strapi and consumed via REST API by any frontend.

**Key Reference**: See `architecture.md` for detailed implementation plans, data models, and API designs.

## Commands

```bash
# Build the plugin
npm run build

# Development with file watching
npm run watch

# Watch with linking (for local Strapi project development)
npm run watch:link

# Verify plugin structure
npm run verify

# TypeScript type checking
npm run test:ts:front    # Admin panel (frontend)
npm run test:ts:back     # Server (backend)
```

## Architecture

This is a Strapi v5 plugin built with `@strapi/sdk-plugin`. It has two distinct parts:

### Server (`server/src/`)
Backend plugin code running in Node.js:
- **content-types/**: Define `Form` and `FormSubmission` collection types (schema.json files)
- **controllers/**: Request handlers (form CRUD, submission handling, public API)
- **services/**: Business logic (form, submission, validation, export services)
- **routes/**: Two route types:
  - `admin/`: Protected routes for admin panel (`/formflow/*`)
  - `content-api/`: Public routes for frontend (`/api/formflow/forms/*`)
- **policies/**: Route guards (is-form-active, rate-limit)
- **middlewares/**: Request processing (spam-check)

### Admin (`admin/src/`)
React frontend for Strapi admin panel:
- **pages/**: Route components (FormsListPage, FormEditPage, SubmissionsListPage)
- **components/**: Reusable UI (FormBuilder, FieldEditor, SubmissionViewer)
- **hooks/**: Data fetching hooks (useForms, useForm, useSubmissions)
- **translations/**: i18n JSON files

## Key Patterns

### Strapi Document Service (v5)
Use `strapi.documents()` for database operations:
```typescript
// Find
await strapi.documents('plugin::formflow.form').findMany({ filters: { slug } });

// Create
await strapi.documents('plugin::formflow.form').create({ data: {...} });

// Update
await strapi.documents('plugin::formflow.form').update({ documentId, data: {...} });
```

### Admin API Calls
Use `useFetchClient` from `@strapi/strapi/admin` for authenticated requests:
```typescript
import { useFetchClient } from '@strapi/strapi/admin';
const { get, post, put, del } = useFetchClient();
```

### UI Components
Use `@strapi/design-system` v2 components (Field, Modal, Tabs, Table, Card, Button, etc.).

### TypeScript Export Rule
**IMPORTANT**: When creating services, controllers, or policies, any interface or type used in the exported module's function signatures MUST be exported. The Strapi plugin build process (`strapi-plugin build`) generates type definitions and will fail with `TS4082: Default export of the module has or is using private name` if interfaces are not exported.

```typescript
// WRONG - will fail build
interface MyContext { ... }  // private
const myController = () => ({
  async handler(ctx: MyContext) { ... }
});
export default myController;

// CORRECT - interfaces used in exports must be exported
export interface MyContext { ... }  // exported
const myController = () => ({
  async handler(ctx: MyContext) { ... }
});
export default myController;
```

## Content Types

Plugin defines two collection types hidden from Content Manager:
- `plugin::formflow.form`: Form definitions with JSON fields for `fields` and `settings`
- `plugin::formflow.form-submission`: Submission data with relation to form

## Route Structure

| Type | Base Path | Auth | Purpose |
|------|-----------|------|---------|
| Admin | `/formflow/` | Admin session | Form/submission management |
| Content API | `/api/formflow/forms/` | Public (configurable) | Schema retrieval, form submission |

## Local E2E Test Harness

A full real end-to-end setup lives in **sibling** directories (not part of this repo). It runs the real
plugin in a real Strapi against the real React SDK, plus local receivers for webhooks/integrations and email.
Drive the browser with the chrome-devtools MCP and interact as a real user.

### Components & ports
- **Strapi host:** `../my-strapi-project` — plugin linked via **yalc**; http://localhost:1337 (admin `/admin`).
- **Astro + React SDK demo:** `../formflow-astro-e2e` — headless renderer; http://localhost:4321
  (`?slug=<form>` + optional `&locale=xx` / `&resume=<token>`). SDK symlinked in.
- **Webhook/integration receiver:** `../formflow-astro-e2e/_hook-receiver.cjs` — :9099, appends to
  `_hook-received.log`. Point webhook URLs **and** Slack/Zapier integration URLs at `http://localhost:9099/...`.
- **SMTP catcher (email):** `../formflow-astro-e2e/_smtp-catcher.cjs` — :2525, appends to `_email-received.log`.

### The 3 (four) shells — run each in the background
```bash
# 1) Strapi (dev + watch admin); reads FORMFLOW_LICENSE_KEY from ../my-strapi-project/.env
cd ../my-strapi-project && npm run develop -- --watch-admin      # :1337
# 2) Astro SDK demo
cd ../formflow-astro-e2e && npm run dev                          # :4321
# 3) webhook/integration receiver + 4) SMTP email catcher
node ../formflow-astro-e2e/_hook-receiver.cjs                    # :9099
node ../formflow-astro-e2e/_smtp-catcher.cjs                     # :2525
```
Tip: launch long-running servers via the harness background mode (they survive across turns); the plain
`setsid … &` variants get reaped. `/tmp` is periodically wiped here — keep worktrees/helpers under `~/Projects`.

### One-time / refresh setup
- **Link the plugin under test:** build it from the branch's worktree (e.g. `../strapi-forms-e2e*`:
  `npm run build`), then `npx yalc publish --push` (copies `dist` into `../my-strapi-project/node_modules`).
  - **Stale-bundle gotcha:** after a yalc push, Strapi/Vite keep serving the OLD admin bundle. Stop Strapi,
    `rm -rf .strapi node_modules/.strapi node_modules/.cache node_modules/.vite build dist`, then restart.
- **Link the SDK under test:** build it (`pnpm build` in the SDK worktree, e.g. `../formflow-sdk-e2e*`), then
  symlink into the demo: `ln -s <sdk>/packages/core .../node_modules/@formflowjs/core` (and `react`).
  Astro `vite.resolve.dedupe: ['react','react-dom']` keeps a single React across the symlink.
- **License tier:** set/comment `FORMFLOW_LICENSE_KEY` in `../my-strapi-project/.env` (empty = free);
  restart Strapi to change tiers. Business inherits Pro. A key change re-activates against Lemon Squeezy.
- **Reset DB / free-tier clean slate:** stop Strapi, `cp .tmp/data.db .tmp/data.db.bak && rm -f .tmp/data.db*`,
  restart → fresh DB; recreate the admin at `/admin`. Test admin creds used: `admin@test.local` / `Testpass123!`.
- **Email delivery:** install `@strapi/provider-email-nodemailer` + `nodemailer` in `../my-strapi-project`;
  add an `email` block in `config/plugins.ts` → nodemailer → `host:'localhost', port:2525, secure:false, ignoreTLS:true`.
- **Plugin config options** (`config/plugins.ts` under `formflow.config`): `anonymizeIp`, `dataRetentionDays`,
  `recaptcha` (see README Configuration).

### Handy references
- **Admin API token:** `POST /admin/login {email,password}` → `data.token`; send as `Authorization: Bearer`.
  Admin form endpoints use the form **documentId** (not slug); public API uses the slug.
- **Captcha test keys (Cloudflare Turnstile):** always-pass site `1x00000000000000000000AA` /
  secret `1x0000000000000000000000000000000AA`; always-fail secret `2x0000000000000000000000000000000AA`.
  Server reads the token from body `turnstileToken` (reCAPTCHA: `g-recaptcha-response`).
- **Save & resume:** `POST /api/formflow/forms/:slug/partial` → `resumeToken`; `GET …/partial/:token`.
  Drafts (`status='draft'`) retain hidden values; final submits validate + drop hidden fields.