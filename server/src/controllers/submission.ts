import type { Core } from '@strapi/strapi';

import { APPROVAL_STATUSES, type ApprovalStatus } from '../services/submission';

/**
 * Koa context interface for submission controller methods
 */
export interface SubmissionContext {
  params: { id?: string; formId?: string };
  query: Record<string, string | undefined>;
  request: {
    body: Record<string, unknown>;
  };
  state?: { auth?: { credentials?: { email?: string } } };
  status: number;
  body: unknown;
  notFound: (message?: string) => void;
  badRequest: (message?: string) => void;
  throw: (status: number, message: string) => never;
  set: (header: string, value: string) => void;
}

/**
 * Valid submission statuses for updates
 */
const VALID_STATUSES = ['new', 'read', 'processed', 'archived', 'spam'] as const;

/**
 * Parse sort string into Strapi sort object
 * @param sort - Sort string in format "field:direction"
 * @returns Sort object for Strapi query
 */
const parseSort = (sort: string): Record<string, 'asc' | 'desc'> => {
  const [field, direction] = sort.split(':');
  return { [field || 'createdAt']: (direction as 'asc' | 'desc') || 'desc' };
};

/**
 * Compliance audit log entry shape. Declared locally (structurally identical to
 * the EE `AuditEntry`) so this MIT controller type-checks when the `ee/` tree is
 * stripped — the runtime appender is imported lazily and guarded below.
 */
interface AuditEntry {
  action: 'submission.delete' | 'submission.bulkDelete';
  /** Admin user email or 'unknown'. */
  actor: string;
  /** documentId for single deletes; formId for bulk deletes. */
  target: string;
  /** Number of affected records, for bulk operations. */
  count?: number;
  /** ISO timestamp. */
  timestamp: string;
}

/**
 * Append a compliance audit entry for a destructive admin op, lazily importing
 * the EE compliance engine. Submission deletes are a FREE operation, so in a
 * stripped MIT fork (`ee/compliance` absent) the audit append is silently
 * skipped — the import throws MODULE_NOT_FOUND, which we swallow. Never throws.
 */
const recordAuditEntry = async (strapi: Core.Strapi, entry: AuditEntry): Promise<void> => {
  try {
    const { appendAuditEntry } = await import('../ee/compliance');
    await appendAuditEntry(strapi, entry);
  } catch {
    // Stripped fork → no audit log; the delete itself already succeeded.
  }
};

/**
 * Submission controller for admin panel management
 * Provides CRUD operations for form submissions
 */
const submissionController = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * List submissions for a form with pagination and filtering
   * GET /formflow/forms/:formId/submissions
   *
   * Query params:
   * - page: Page number (default: 1)
   * - pageSize: Items per page (default: 25, max: 100)
   * - status: Filter by status (new, read, processed, archived, spam)
   * - sort: Sort field and direction (default: createdAt:desc)
   */
  async find(ctx: SubmissionContext) {
    const { formId } = ctx.params;

    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    const { page = '1', pageSize = '25', status, sort = 'createdAt:desc' } = ctx.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));

    try {
      const filters: Record<string, unknown> = {};
      if (status && VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
        filters.status = status;
      }

      const submissionService = strapi.plugin('formflow').service('submission');

      const [submissions, total] = await Promise.all([
        submissionService.find(formId, {
          filters,
          sort: parseSort(sort),
          limit: pageSizeNum,
          start: (pageNum - 1) * pageSizeNum,
        }),
        submissionService.count(formId, filters),
      ]);

      return {
        data: submissions,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: pageSizeNum,
            pageCount: Math.ceil(total / pageSizeNum),
            total,
          },
        },
      };
    } catch (error) {
      strapi.log.error('[FormFlow] Error fetching submissions:', error);
      ctx.throw(500, 'Failed to fetch submissions');
    }
  },

  /**
   * Get a single submission by ID
   * GET /formflow/submissions/:id
   *
   * Automatically marks the submission as "read" if it was "new"
   */
  async findOne(ctx: SubmissionContext) {
    const { id } = ctx.params;

    if (!id) {
      return ctx.badRequest('Submission ID is required');
    }

    try {
      const submissionService = strapi.plugin('formflow').service('submission');
      const submission = await submissionService.findOne(id);

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // Auto-mark as read when viewing a new submission. This is a system-driven
      // change (not an admin action), so suppress the submission.updated webhook.
      if (submission.status === 'new') {
        await submissionService.markAsRead(id, { triggerWebhooks: false });
        submission.status = 'read';
      }

      return { data: submission };
    } catch (error) {
      strapi.log.error('[FormFlow] Error fetching submission:', error);
      ctx.throw(500, 'Failed to fetch submission');
    }
  },

  /**
   * Update submission status
   * PUT /formflow/submissions/:id
   *
   * Body: { status: 'new' | 'read' | 'processed' | 'archived' | 'spam' }
   */
  async update(ctx: SubmissionContext) {
    const { id } = ctx.params;
    const { status } = ctx.request.body;

    if (!id) {
      return ctx.badRequest('Submission ID is required');
    }

    if (!status || typeof status !== 'string') {
      return ctx.badRequest('Status is required');
    }

    if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      return ctx.badRequest(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    try {
      const submissionService = strapi.plugin('formflow').service('submission');

      // Verify submission exists
      const existing = await submissionService.findOne(id);
      if (!existing) {
        return ctx.notFound('Submission not found');
      }

      const submission = await submissionService.update(id, { status });

      return { data: submission };
    } catch (error) {
      strapi.log.error('[FormFlow] Error updating submission:', error);
      ctx.throw(500, 'Failed to update submission');
    }
  },

  /**
   * Transition a submission's approval status (Business feature)
   * PUT /formflow/submissions/:id/approve
   *
   * Body: { approvalStatus: 'pending' | 'approved' | 'rejected', approvalNote?: string }
   *
   * Gated behind `can('approval')`: returns HTTP 402 + upsell when the license is
   * not entitled (returns without throwing). This is separate from `update()`,
   * which manages the inbox `status` field.
   */
  async approve(ctx: SubmissionContext) {
    const { id } = ctx.params;
    const { approvalStatus, approvalNote } = ctx.request.body as {
      approvalStatus?: unknown;
      approvalNote?: unknown;
    };

    if (!id) {
      return ctx.badRequest('Submission ID is required');
    }

    if (
      !approvalStatus ||
      typeof approvalStatus !== 'string' ||
      !APPROVAL_STATUSES.includes(approvalStatus as ApprovalStatus)
    ) {
      return ctx.badRequest(`approvalStatus must be one of: ${APPROVAL_STATUSES.join(', ')}`);
    }

    // Business entitlement gate. Lazy lookup keeps core MIT code free of static
    // EE imports. Returns 402 without throwing when unentitled.
    const license = strapi.plugin('formflow').service('license');
    if (!license.can('approval')) {
      ctx.status = 402;
      ctx.body = {
        error: {
          status: 402,
          name: 'PaymentRequiredError',
          message: 'Business license required for approval workflows',
          details: { feature: 'approval', requiredTier: 'business' },
        },
      };
      return;
    }

    try {
      const submissionService = strapi.plugin('formflow').service('submission');

      const existing = await submissionService.findOne(id);
      if (!existing) {
        return ctx.notFound('Submission not found');
      }

      const updated = await submissionService.approveSubmission(
        id,
        approvalStatus as ApprovalStatus,
        typeof approvalNote === 'string' ? approvalNote : undefined
      );

      return { data: updated };
    } catch (error) {
      strapi.log.error('[FormFlow] Error updating approval status:', error);
      ctx.throw(500, 'Failed to update approval status');
    }
  },

  /**
   * Delete a single submission
   * DELETE /formflow/submissions/:id
   */
  async delete(ctx: SubmissionContext) {
    const { id } = ctx.params;

    if (!id) {
      return ctx.badRequest('Submission ID is required');
    }

    try {
      const submissionService = strapi.plugin('formflow').service('submission');

      // Verify submission exists
      const existing = await submissionService.findOne(id);
      if (!existing) {
        return ctx.notFound('Submission not found');
      }

      await submissionService.delete(id);

      await recordAuditEntry(strapi, {
        action: 'submission.delete',
        actor: ctx.state?.auth?.credentials?.email ?? 'unknown',
        target: id,
        timestamp: new Date().toISOString(),
      });

      return { data: { success: true } };
    } catch (error) {
      strapi.log.error('[FormFlow] Error deleting submission:', error);
      ctx.throw(500, 'Failed to delete submission');
    }
  },

  /**
   * Delete multiple submissions for a form
   * POST /formflow/forms/:formId/submissions/bulk-delete
   *
   * Body: { ids: string[] }
   *
   * Uses POST rather than DELETE because Koa/Strapi does not parse a request
   * body on DELETE requests, so the { ids } payload would be undefined here.
   */
  async deleteMany(ctx: SubmissionContext) {
    const { formId } = ctx.params;
    const { ids } = ctx.request.body;

    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ctx.badRequest('No submission IDs provided');
    }

    // Validate all IDs are strings
    if (!ids.every((id) => typeof id === 'string')) {
      return ctx.badRequest('Invalid submission IDs');
    }

    try {
      const deleted = await strapi
        .plugin('formflow')
        .service('submission')
        .deleteMany(formId, ids as string[]);

      await recordAuditEntry(strapi, {
        action: 'submission.bulkDelete',
        actor: ctx.state?.auth?.credentials?.email ?? 'unknown',
        target: formId,
        count: deleted.length,
        timestamp: new Date().toISOString(),
      });

      return {
        data: {
          success: true,
          deleted: deleted.length,
        },
      };
    } catch (error) {
      strapi.log.error('[FormFlow] Error deleting submissions:', error);
      ctx.throw(500, 'Failed to delete submissions');
    }
  },

  /**
   * Get submission statistics for a form
   * GET /formflow/forms/:formId/submissions/stats
   */
  async stats(ctx: SubmissionContext) {
    const { formId } = ctx.params;

    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    try {
      const stats = await strapi.plugin('formflow').service('submission').getStats(formId);

      return { data: stats };
    } catch (error) {
      strapi.log.error('[FormFlow] Error fetching submission stats:', error);
      ctx.throw(500, 'Failed to fetch submission statistics');
    }
  },

  /**
   * Export submissions as CSV
   * GET /formflow/forms/:formId/submissions/export
   *
   * Query params:
   * - status: Filter by status
   * - includeIp: Include IP address column (true/false)
   * - includeUserAgent: Include user agent column (true/false)
   * - includeMetadata: Include full metadata object (JSON export only, true/false)
   * - format: Export format (csv/json, default: csv)
   */
  async export(ctx: SubmissionContext) {
    const { formId } = ctx.params;
    const {
      status,
      includeIp = 'false',
      includeUserAgent = 'false',
      includeMetadata = 'false',
      format = 'csv',
    } = ctx.query;

    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    try {
      const filters: Record<string, unknown> = {};
      if (status && VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
        filters.status = status;
      }

      const exportService = strapi.plugin('formflow').service('export');
      const formService = strapi.plugin('formflow').service('form');

      // Get form for filename
      const form = await formService.findOne(formId);
      if (!form) {
        return ctx.notFound('Form not found');
      }

      const dateStr = new Date().toISOString().split('T')[0];
      const baseFilename = `${form.slug || 'submissions'}-${dateStr}`;

      // Advanced formats (Excel/PDF) are a Pro feature. CSV/JSON below stay free.
      // The 402 returns without throwing; the EE engine is loaded lazily so core
      // MIT code carries no static EE import.
      if (format === 'xlsx' || format === 'pdf') {
        const licenseService = strapi.plugin('formflow').service('license');
        if (!licenseService.can('export.advanced')) {
          ctx.status = 402;
          ctx.body = {
            error: 'Payment Required',
            message: 'Advanced export (Excel/PDF) requires a Pro license.',
            upsell: 'https://formflow.digid.ca/#pricing',
          };
          return;
        }

        const { exportToXLSX, exportToPDF } = await import('../ee/export/index');
        const exportOpts = {
          filters,
          includeIp: includeIp === 'true',
          includeUserAgent: includeUserAgent === 'true',
        };

        if (format === 'xlsx') {
          const buffer = await exportToXLSX(strapi, formId, exportOpts);
          ctx.set(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          );
          ctx.set('Content-Disposition', `attachment; filename="${baseFilename}.xlsx"`);
          ctx.body = buffer;
        } else {
          const buffer = await exportToPDF(strapi, formId, exportOpts);
          ctx.set('Content-Type', 'application/pdf');
          ctx.set('Content-Disposition', `attachment; filename="${baseFilename}.pdf"`);
          ctx.body = buffer;
        }
        return;
      }

      if (format === 'json') {
        const json = await exportService.exportToJSON(formId, {
          filters,
          includeIp: includeIp === 'true',
          includeUserAgent: includeUserAgent === 'true',
          includeMetadata: includeMetadata === 'true',
        });

        ctx.set('Content-Type', 'application/json; charset=utf-8');
        ctx.set('Content-Disposition', `attachment; filename="${baseFilename}.json"`);
        ctx.body = json;
      } else {
        const csv = await exportService.exportToCSV(formId, {
          filters,
          includeIp: includeIp === 'true',
          includeUserAgent: includeUserAgent === 'true',
        });

        ctx.set('Content-Type', 'text/csv; charset=utf-8');
        ctx.set('Content-Disposition', `attachment; filename="${baseFilename}.csv"`);
        ctx.body = csv;
      }
    } catch (error) {
      strapi.log.error('[FormFlow] Error exporting submissions:', error);
      ctx.throw(500, 'Failed to export submissions');
    }
  },

  /**
   * Send a test webhook to verify a configuration (Pro feature)
   * POST /formflow/forms/:formId/webhooks/test
   *
   * Body: WebhookConfig (url required; method, headers, events, etc. optional)
   *
   * Gated behind `can('webhooks')`: returns HTTP 402 + upsell when the license
   * is not entitled, without invoking the webhook engine. The :formId is part of
   * the path for RBAC scoping/client consistency; sendTest posts to the config's
   * own `url`, so formId is not forwarded to the engine.
   */
  async testWebhook(ctx: SubmissionContext) {
    const { url } = ctx.request.body;

    if (!url || typeof url !== 'string') {
      return ctx.badRequest('Webhook URL is required');
    }

    // Lazy lookup keeps core MIT code free of static EE imports (circular-import
    // prevention; see premium-plan.md §9).
    const licenseService = strapi.plugin('formflow').service('license');

    if (!licenseService.can('webhooks')) {
      ctx.status = 402;
      ctx.body = {
        error: {
          status: 402,
          name: 'PaymentRequiredError',
          message: 'Webhooks require a FormFlow Pro license.',
          details: { feature: 'webhooks', requiredTier: 'pro' },
        },
      };
      return;
    }

    try {
      const webhookService = strapi.plugin('formflow').service('webhook');
      const result = await webhookService.sendTest(ctx.request.body);

      ctx.body = { data: result };
    } catch (error) {
      strapi.log.error('[FormFlow] Error sending test webhook:', error);
      ctx.throw(500, 'Failed to send test webhook');
    }
  },

  /**
   * Read the active scheduled-export config for a form (Pro feature).
   * GET /formflow/forms/:formId/submissions/schedule-export
   *
   * Returns `{ data: ScheduledExportConfig | null }`. Reading is not gated — the
   * UI needs to render the current state regardless of entitlement (e.g. to show
   * a previously-saved schedule after a license lapse).
   */
  async getScheduledExport(ctx: SubmissionContext) {
    const { formId } = ctx.params;
    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    try {
      const store = strapi.store({ type: 'plugin', name: 'formflow' });
      const config = await store.get({ key: `scheduled-export-${formId}` });
      ctx.body = { data: config ?? null };
    } catch (error) {
      strapi.log.error('[FormFlow] Error reading scheduled export:', error);
      ctx.throw(500, 'Failed to read scheduled export');
    }
  },

  /**
   * Create/replace the scheduled-export config for a form (Pro feature).
   * POST /formflow/forms/:formId/submissions/schedule-export
   *
   * Body: { format: 'xlsx'|'pdf'|'csv', cronExpression: string, recipientEmails: string[] }
   *
   * Gated behind `can('export.advanced')`: returns 402 + upsell when unentitled.
   * Persists the config to `strapi.store` and registers the cron entry via the
   * EE engine (dynamic import keeps core MIT code free of static EE imports).
   */
  async createScheduledExport(ctx: SubmissionContext) {
    const { formId } = ctx.params;
    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    const licenseService = strapi.plugin('formflow').service('license');
    if (!licenseService.can('export.advanced')) {
      ctx.status = 402;
      ctx.body = {
        error: 'Payment Required',
        message: 'Scheduled export requires a Pro license.',
        upsell: 'https://formflow.digid.ca/#pricing',
      };
      return;
    }

    const body = ctx.request.body as {
      format?: 'xlsx' | 'pdf' | 'csv';
      cronExpression?: string;
      recipientEmails?: string[];
    };

    const format = body.format;
    const cronExpression = body.cronExpression;
    const recipientEmails = Array.isArray(body.recipientEmails)
      ? body.recipientEmails.map((email) => String(email).trim()).filter(Boolean)
      : [];

    if (format !== 'xlsx' && format !== 'pdf' && format !== 'csv') {
      return ctx.badRequest('A valid format (xlsx, pdf, or csv) is required');
    }
    if (!cronExpression || typeof cronExpression !== 'string') {
      return ctx.badRequest('A cron expression is required');
    }
    if (recipientEmails.length === 0) {
      return ctx.badRequest('At least one recipient email is required');
    }

    try {
      const config = { formId, format, cronExpression, recipientEmails };

      const { registerScheduledExport } = await import('../ee/export/index');
      await registerScheduledExport(strapi, config);

      const store = strapi.store({ type: 'plugin', name: 'formflow' });
      await store.set({ key: `scheduled-export-${formId}`, value: config });

      ctx.body = { data: config };
    } catch (error) {
      strapi.log.error('[FormFlow] Error creating scheduled export:', error);
      ctx.throw(500, 'Failed to create scheduled export');
    }
  },

  /**
   * Remove the scheduled-export config for a form (Pro feature).
   * DELETE /formflow/forms/:formId/submissions/schedule-export
   *
   * Clears the cron entry (via the EE engine) and the persisted config. This
   * monotonic cleanup remains available after an entitlement lapse.
   */
  async removeScheduledExport(ctx: SubmissionContext) {
    const { formId } = ctx.params;
    if (!formId) {
      return ctx.badRequest('Form ID is required');
    }

    try {
      const { removeScheduledExport } = await import('../ee/export/index');
      await removeScheduledExport(strapi, formId);

      const store = strapi.store({ type: 'plugin', name: 'formflow' });
      await store.delete({ key: `scheduled-export-${formId}` });

      ctx.body = { data: { removed: true } };
    } catch (error) {
      strapi.log.error('[FormFlow] Error removing scheduled export:', error);
      ctx.throw(500, 'Failed to remove scheduled export');
    }
  },
});

export default submissionController;
