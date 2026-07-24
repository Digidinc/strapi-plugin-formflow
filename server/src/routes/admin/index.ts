/**
 * Helper to build the standard admin policy chain: require an authenticated
 * admin session, then check the user's ability for the given RBAC action(s).
 *
 * The action UIDs map 1:1 to the actions registered in `register.ts`
 * (`plugin::formflow.*`) and the admin constants in
 * `admin/src/permissions.ts`. Super-admins always pass `admin::hasPermissions`.
 */
const protectedBy = (actions: string[]) => [
  'admin::isAuthenticatedAdmin',
  {
    name: 'admin::hasPermissions',
    config: { actions },
  },
];

export default {
  type: 'admin',
  routes: [
    {
      method: 'GET', path: '/settings/telegram/connections', handler: 'telegram.list',
      config: { policies: protectedBy(['plugin::formflow.settings.read']) },
    },
    {
      method: 'POST', path: '/settings/telegram/connections', handler: 'telegram.create',
      config: { policies: protectedBy(['plugin::formflow.settings.update']) },
    },
    {
      method: 'PATCH', path: '/settings/telegram/connections/:id', handler: 'telegram.update',
      config: { policies: protectedBy(['plugin::formflow.settings.update']) },
    },
    {
      method: 'DELETE', path: '/settings/telegram/connections/:id', handler: 'telegram.delete',
      config: { policies: protectedBy(['plugin::formflow.settings.update']) },
    },
    {
      method: 'POST', path: '/settings/telegram/connections/validate', handler: 'telegram.validate',
      config: { policies: protectedBy(['plugin::formflow.settings.update']) },
    },
    {
      method: 'POST', path: '/forms/:formId/telegram/test', handler: 'telegram.test',
      config: { policies: protectedBy(['plugin::formflow.form.update']) },
    },
    // Form CRUD operations
    {
      method: 'GET',
      path: '/forms',
      handler: 'form.find',
      config: {
        policies: protectedBy(['plugin::formflow.form.read']),
      },
    },
    {
      method: 'GET',
      path: '/forms/count',
      handler: 'form.count',
      config: {
        policies: protectedBy(['plugin::formflow.form.read']),
      },
    },
    {
      method: 'GET',
      path: '/forms/:id',
      handler: 'form.findOne',
      config: {
        policies: protectedBy(['plugin::formflow.form.read']),
      },
    },
    {
      method: 'POST',
      path: '/forms',
      handler: 'form.create',
      config: {
        policies: protectedBy(['plugin::formflow.form.create']),
      },
    },
    {
      method: 'PUT',
      path: '/forms/:id',
      handler: 'form.update',
      config: {
        policies: protectedBy(['plugin::formflow.form.update']),
      },
    },
    {
      method: 'DELETE',
      path: '/forms/:id',
      handler: 'form.delete',
      config: {
        policies: protectedBy(['plugin::formflow.form.delete']),
      },
    },
    {
      // Duplicating creates a new form, so it requires the create permission.
      method: 'POST',
      path: '/forms/:id/duplicate',
      handler: 'form.duplicate',
      config: {
        policies: protectedBy(['plugin::formflow.form.create']),
      },
    },
    // Field types for form builder — needed by anyone who can read/build forms.
    {
      method: 'GET',
      path: '/field-types',
      handler: 'form.getFieldTypes',
      config: {
        policies: protectedBy(['plugin::formflow.form.read']),
      },
    },

    // Submission management
    {
      method: 'GET',
      path: '/forms/:formId/submissions',
      handler: 'submission.find',
      config: {
        policies: protectedBy(['plugin::formflow.submission.read']),
      },
    },
    {
      method: 'GET',
      path: '/forms/:formId/submissions/stats',
      handler: 'submission.stats',
      config: {
        policies: protectedBy(['plugin::formflow.submission.read']),
      },
    },
    {
      method: 'GET',
      path: '/forms/:formId/submissions/export',
      handler: 'submission.export',
      config: {
        policies: protectedBy(['plugin::formflow.submission.export']),
      },
    },
    {
      // Bulk delete uses POST (not DELETE) because Koa/Strapi does not parse a
      // request body on DELETE, so the { ids } payload would never reach the
      // controller. Contract: POST /formflow/forms/:formId/submissions/bulk-delete
      // with body { ids: string[] } -> { data: { success, deleted } }.
      method: 'POST',
      path: '/forms/:formId/submissions/bulk-delete',
      handler: 'submission.deleteMany',
      config: {
        policies: protectedBy(['plugin::formflow.submission.delete']),
      },
    },
    {
      method: 'GET',
      path: '/submissions/:id',
      handler: 'submission.findOne',
      config: {
        policies: protectedBy(['plugin::formflow.submission.read']),
      },
    },
    {
      method: 'PUT',
      path: '/submissions/:id',
      handler: 'submission.update',
      config: {
        policies: protectedBy(['plugin::formflow.submission.update']),
      },
    },
    {
      // Approval workflow transition (Business feature; gated 402 in the
      // controller). Reuses submission.update — actioning an approval implies
      // the right to update the submission.
      method: 'PUT',
      path: '/submissions/:id/approve',
      handler: 'submission.approve',
      config: {
        policies: protectedBy(['plugin::formflow.submission.update']),
      },
    },
    {
      method: 'DELETE',
      path: '/submissions/:id',
      handler: 'submission.delete',
      config: {
        policies: protectedBy(['plugin::formflow.submission.delete']),
      },
    },
    {
      // Test-send a webhook config (Pro feature; gated 402 in the controller).
      // Reuses form.update permission: configuring a form's webhooks implies the
      // right to test them. formId scopes RBAC and matches the admin client path.
      method: 'POST',
      path: '/forms/:formId/webhooks/test',
      handler: 'submission.testWebhook',
      config: {
        policies: protectedBy(['plugin::formflow.form.update']),
      },
    },

    // Scheduled export CRUD (Pro feature; gated 402 in the controller). Reuses
    // the submission.export permission — scheduling an export implies the right
    // to export. GET reads the saved schedule (not gated); POST/DELETE manage it.
    {
      method: 'GET',
      path: '/forms/:formId/submissions/schedule-export',
      handler: 'submission.getScheduledExport',
      config: {
        policies: protectedBy(['plugin::formflow.submission.export']),
      },
    },
    {
      method: 'POST',
      path: '/forms/:formId/submissions/schedule-export',
      handler: 'submission.createScheduledExport',
      config: {
        policies: protectedBy(['plugin::formflow.submission.export']),
      },
    },
    {
      method: 'DELETE',
      path: '/forms/:formId/submissions/schedule-export',
      handler: 'submission.removeScheduledExport',
      config: {
        policies: protectedBy(['plugin::formflow.submission.export']),
      },
    },

    // License status — auth-only, no RBAC action (read-only, non-sensitive snapshot)
    {
      method: 'GET',
      path: '/license',
      handler: 'license.state',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/license/refresh',
      handler: 'license.refresh',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },

    // Form analytics dashboard (Pro feature; gated 402 in the controller).
    // Reuses form.read — viewing a form's analytics implies the right to read it.
    {
      method: 'GET',
      path: '/forms/:formId/analytics',
      handler: 'license.analytics',
      config: {
        policies: protectedBy(['plugin::formflow.form.read']),
      },
    },

    // GDPR/compliance operations (Business feature; gated 402 in the controller).
    // Auth-only, no RBAC action — these are super-admin level compliance ops.
    {
      method: 'GET',
      path: '/compliance/subject',
      handler: 'compliance.findSubject',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'DELETE',
      path: '/compliance/subject',
      handler: 'compliance.deleteSubject',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/compliance/audit',
      handler: 'compliance.getAuditLog',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
  ],
};
