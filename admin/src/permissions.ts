import type { Permission } from '@strapi/strapi/admin';

/**
 * RBAC permission groups for the FormFlow plugin.
 *
 * Each entry is a list of admin `Permission` objects (the shape the admin RBAC
 * APIs expect: `addMenuLink({ permissions })`, `<Page.Protect permissions>` and
 * `useRBAC(permissions)`). The server registers the matching action UIDs via
 * `actionProvider.registerMany` (see `server/src/register.ts`), so these action
 * strings must stay in sync with the `plugin::formflow.*` UIDs there.
 *
 * `useRBAC` derives an allowed-action flag from the LAST dot-segment of each
 * action, hyphen-camelCased, e.g.
 *   - `plugin::formflow.form.read`        -> `canRead`
 *   - `plugin::formflow.form.create`      -> `canCreate`
 *   - `plugin::formflow.submission.export`-> `canExport`
 * Because `form.read` and `submission.read` both collapse to `canRead`, only
 * pass the group relevant to the current page to `useRBAC` to avoid collisions.
 */

const buildPermission = (action: string): Permission => ({
  action,
  subject: null,
  id: '',
  actionParameters: {},
  properties: {},
  conditions: [],
});

/**
 * Form-management permissions. `main`/`read` gates access to the plugin (the
 * menu link and the protected app shell).
 */
export const FORM_PERMISSIONS = {
  main: [buildPermission('plugin::formflow.form.read')],
  read: [buildPermission('plugin::formflow.form.read')],
  create: [buildPermission('plugin::formflow.form.create')],
  update: [buildPermission('plugin::formflow.form.update')],
  delete: [buildPermission('plugin::formflow.form.delete')],
} satisfies Record<string, Permission[]>;

/**
 * Submission-management permissions.
 */
export const SUBMISSION_PERMISSIONS = {
  read: [buildPermission('plugin::formflow.submission.read')],
  update: [buildPermission('plugin::formflow.submission.update')],
  delete: [buildPermission('plugin::formflow.submission.delete')],
  export: [buildPermission('plugin::formflow.submission.export')],
} satisfies Record<string, Permission[]>;

export const SETTINGS_PERMISSIONS = {
  read: [buildPermission('plugin::formflow.settings.read')],
  update: [buildPermission('plugin::formflow.settings.update')],
} satisfies Record<string, Permission[]>;

/**
 * Top-level permission groups. `main` gates the menu link and the protected app
 * shell (form read); `form` / `submission` expose the per-action groups for
 * `useRBAC` on the individual pages.
 */
export const PERMISSIONS: {
  main: Permission[];
  form: typeof FORM_PERMISSIONS;
  submission: typeof SUBMISSION_PERMISSIONS;
  settings: typeof SETTINGS_PERMISSIONS;
} = {
  // Menu/app access requires form read (the landing page lists forms).
  main: FORM_PERMISSIONS.main,
  form: FORM_PERMISSIONS,
  submission: SUBMISSION_PERMISSIONS,
  settings: SETTINGS_PERMISSIONS,
};
