import type { Core } from '@strapi/strapi';

import { LICENSE_CRON_NAME, TELEMETRY_CRON_NAME } from './bootstrap';
import { stopRateLimitCleanup } from './policies/rate-limit';

const destroy = async ({ strapi }: { strapi: Core.Strapi }) => {
  // Clear the rate-limit cleanup timer started in bootstrap.
  stopRateLimitCleanup();

  // Stop the premium-job lifecycle before the pending initial license resolution
  // can reconcile again. The service owns retention and scheduled-export cleanup.
  try {
    await strapi.plugin('formflow').service('premium-jobs').removeAll();
  } catch (error) {
    strapi.log.error('[FormFlow] Failed to remove premium jobs:', error);
  }

  // Remove the license refresh cron and clear any in-flight refresh timer.
  try {
    if (strapi.cron && typeof strapi.cron.remove === 'function') {
      strapi.cron.remove(LICENSE_CRON_NAME);
    }
  } catch (error) {
    strapi.log.error('[FormFlow] Failed to remove the license refresh cron:', error);
  }

  // Remove the telemetry heartbeat cron.
  try {
    if (strapi.cron && typeof strapi.cron.remove === 'function') {
      strapi.cron.remove(TELEMETRY_CRON_NAME);
    }
  } catch (error) {
    strapi.log.error('[FormFlow] Failed to remove the telemetry heartbeat cron:', error);
  }

  try {
    await strapi.plugin('formflow').service('license').destroy();
  } catch (error) {
    strapi.log.error('[FormFlow] License destroy failed:', error);
  }
};

export default destroy;
