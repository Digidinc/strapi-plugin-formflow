import type { Core } from '@strapi/strapi';

import { startRateLimitCleanup } from './policies/rate-limit';

export { RETENTION_CRON_NAME } from './services/premium-jobs';

/**
 * Named cron task that re-validates the license against the MoR daily. The name
 * is reused in destroy.ts to remove the job on plugin teardown.
 */
export const LICENSE_CRON_NAME = 'formflowLicenseRefresh';

/**
 * Named cron task that sends the daily anonymous telemetry heartbeat. The name
 * is reused in destroy.ts to remove the job on plugin teardown.
 */
export const TELEMETRY_CRON_NAME = 'formflowTelemetryHeartbeat';

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  // Start the rate-limit store cleanup timer. Its lifecycle is tied to the
  // Strapi instance and is cleared in the destroy hook.
  startRateLimitCleanup();

  // License: initialize the license service (validate key against MoR, restore
  // persisted grace cache). Non-blocking — plugin must always load even if the
  // MoR endpoint is unreachable or the key is absent.
  const license = strapi.plugin('formflow').service('license');
  const premiumJobs = strapi.plugin('formflow').service('premium-jobs');

  try {
    await license.init();
  } catch (error) {
    strapi.log.error('[FormFlow] License init failed:', error);
  }

  // Apply any usable cached entitlement immediately. The first remote
  // resolution stays asynchronous so a fresh key can never block plugin boot;
  // when it settles, reconcile again to add or remove premium jobs.
  try {
    await premiumJobs.reconcile();
  } catch (error) {
    strapi.log.error('[FormFlow] Initial premium job reconciliation failed:', error);
  }
  license
    .whenReady()
    .then(() => premiumJobs.reconcile())
    .catch((error: unknown) => {
      strapi.log.error('[FormFlow] Premium job reconciliation failed:', error);
    });

  // Telemetry: anonymous, opt-out usage ping (install event + throttled
  // heartbeat). Deliberately NOT awaited so a slow/unreachable endpoint can
  // never delay boot — init() handles its own errors and respects every
  // opt-out signal (see services/telemetry.ts).
  strapi
    .plugin('formflow')
    .service('telemetry')
    .init()
    .catch((error: unknown) => {
      strapi.log.debug('[FormFlow] Telemetry init failed (non-fatal):', error);
    });

  // License: register a daily re-validation cron so the cached state is refreshed
  // even for long-running Strapi instances, then reconcile dependent jobs.
  // Runtimes without Strapi cron explicitly opt into the service-owned fallback.
  try {
    if (strapi.cron && typeof strapi.cron.add === 'function') {
      strapi.cron.add({
        [LICENSE_CRON_NAME]: {
          // 01:00 daily (offset from midnight to avoid retention cron collision).
          options: '0 1 * * *',
          async task() {
            try {
              await license.refresh();
              await premiumJobs.reconcile();
            } catch (error) {
              strapi.log.error('[FormFlow] License refresh cron failed:', error);
            }
          },
        },
      });
    } else {
      license.startFallbackScheduler(() => premiumJobs.reconcile());
    }
  } catch (error) {
    strapi.log.error('[FormFlow] Failed to register the license refresh cron:', error);
  }

  // Telemetry: daily anonymous heartbeat so long-running instances keep
  // registering as active installs. Mirrors the license/retention cron pattern;
  // 02:00 is offset from the other jobs (00:00 retention, 01:00 license). The
  // heartbeat service no-ops on any opt-out and never throws.
  try {
    if (strapi.cron && typeof strapi.cron.add === 'function') {
      strapi.cron.add({
        [TELEMETRY_CRON_NAME]: {
          options: '0 2 * * *',
          async task() {
            try {
              await strapi.plugin('formflow').service('telemetry').heartbeat();
            } catch (error) {
              strapi.log.debug('[FormFlow] Telemetry heartbeat cron failed (non-fatal):', error);
            }
          },
        },
      });
    }
  } catch (error) {
    strapi.log.debug('[FormFlow] Failed to register the telemetry heartbeat cron:', error);
  }
};

export default bootstrap;
