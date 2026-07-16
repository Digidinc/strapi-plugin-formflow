import type { Core } from '@strapi/strapi';

/**
 * Koa context interface for the license controller. Exported to satisfy the
 * TS4082 rule (any type used in an exported function signature must itself be
 * exported). Only `body` is needed — the snapshot is written straight through.
 */
export interface LicenseContext {
  body: unknown;
}

/**
 * Koa context for the analytics action. Exported per the TS4082 rule (any type
 * in an exported function signature must itself be exported). Carries the route
 * param plus the writable `status`/`body` used for the 402 gate response.
 */
export interface AnalyticsContext {
  params: { formId: string };
  status: number;
  body: unknown;
}

const licenseController = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * GET /formflow/license
   * Return the current license snapshot for the admin panel to gate UI
   * controls. Auth-only (no RBAC action): the snapshot is a read-only,
   * non-sensitive state object and never includes the raw license key.
   *
   * Shape: { tier, state, resolution, graceUntil, features } — forwarded
   * verbatim from the license service's `snapshot()`. The service lookup is
   * lazy (inside the handler) so core never statically imports the EE engine.
   */
  state(ctx: LicenseContext) {
    ctx.body = strapi.plugin('formflow').service('license').snapshot();
  },

  /**
   * POST /formflow/license/refresh
   * Revalidate the license, reconcile entitlement-dependent jobs, and return
   * the same non-sensitive snapshot exposed by the read endpoint.
   */
  async refresh(ctx: LicenseContext) {
    const licenseService = strapi.plugin('formflow').service('license');
    const premiumJobs = strapi.plugin('formflow').service('premium-jobs');

    await licenseService.refresh();
    await premiumJobs.reconcile();
    ctx.body = licenseService.snapshot();
  },

  /**
   * GET /formflow/forms/:formId/analytics
   * Return aggregated analytics counts for a form. Pro-gated: returns 402 with an
   * upsell-friendly error body when the license is not entitled to `analytics`.
   * The capture path (recordEvent) stays free — only this read endpoint is gated.
   */
  async analytics(ctx: AnalyticsContext) {
    const { formId } = ctx.params;
    const licenseService = strapi.plugin('formflow').service('license');
    const analyticsService = strapi.plugin('formflow').service('analytics');

    // Gate: return 402 when unentitled
    if (!licenseService.can('analytics')) {
      ctx.status = 402;
      ctx.body = {
        error: {
          status: 402,
          name: 'PaymentRequired',
          message: 'Analytics dashboard requires a Pro license.',
        },
      };
      return;
    }

    const stats = await analyticsService.getStats(formId);
    ctx.body = { data: stats };
  },
});

export default licenseController;
