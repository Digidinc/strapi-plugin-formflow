import type { Core } from '@strapi/strapi';

const PLUGIN_CONFIG_ID = 'plugin::formflow';

export const RETENTION_CRON_NAME = 'formflowDataRetention';

export interface PremiumJobsService {
  reconcile(): Promise<void>;
  removeAll(): Promise<void>;
}

interface ScheduledExportConfig {
  formId: string;
  format: 'xlsx' | 'pdf' | 'csv';
  cronExpression: string;
  recipientEmails: string[];
}

const premiumJobsService = ({ strapi }: { strapi: Core.Strapi }): PremiumJobsService => {
  const scheduledExportFormIds = new Set<string>();
  let hadAdvancedExportEntitlement = false;
  let stopped = false;
  let reconcileInFlight: Promise<void> | null = null;

  const removeCron = (name: string): void => {
    if (strapi.cron && typeof strapi.cron.remove === 'function') {
      strapi.cron.remove(name);
    }
  };

  const forEachScheduledExport = async (
    callback: (config: ScheduledExportConfig) => Promise<void>
  ): Promise<void> => {
    const store = strapi.store({ type: 'plugin', name: 'formflow' });
    const forms = await strapi
      .documents('plugin::formflow.form')
      .findMany({ fields: ['documentId'] });

    for (const form of forms) {
      try {
        const config = (await store.get({
          key: `scheduled-export-${form.documentId}`,
        })) as ScheduledExportConfig | null;

        if (config) {
          await callback(config);
        }
      } catch (error) {
        strapi.log.error(
          `[FormFlow] Failed to reconcile scheduled export for form "${form.documentId}":`,
          error
        );
      }
    }
  };

  const removeTrackedScheduledExports = async (): Promise<void> => {
    if (scheduledExportFormIds.size === 0) {
      return;
    }

    const { removeScheduledExport } = await import('../ee/export/index');
    for (const formId of scheduledExportFormIds) {
      try {
        await removeScheduledExport(strapi, formId);
        scheduledExportFormIds.delete(formId);
      } catch (error) {
        strapi.log.error(
          `[FormFlow] Failed to remove scheduled export for form "${formId}":`,
          error
        );
      }
    }
  };

  const removePersistedScheduledExports = async (): Promise<void> => {
    const { removeScheduledExport } = await import('../ee/export/index');
    await forEachScheduledExport((config) => removeScheduledExport(strapi, config.formId));
  };

  const reconcileRetention = async (): Promise<void> => {
    removeCron(RETENTION_CRON_NAME);

    const license = strapi.plugin('formflow').service('license');
    if (!license.can('compliance.retention')) {
      return;
    }

    const config = strapi.config.get(PLUGIN_CONFIG_ID, {}) as {
      dataRetentionDays?: number;
    };
    const retentionDays = Number(config?.dataRetentionDays) || 0;

    if (retentionDays <= 0 || !strapi.cron || typeof strapi.cron.add !== 'function') {
      return;
    }

    strapi.cron.add({
      [RETENTION_CRON_NAME]: {
        options: '0 0 * * *',
        async task() {
          const currentLicense = strapi.plugin('formflow').service('license');
          if (!currentLicense.can('compliance.retention')) {
            strapi.log.info('[FormFlow] Retention skipped: Business entitlement unavailable.');
            return;
          }

          try {
            await strapi.plugin('formflow').service('submission').deleteOlderThan(retentionDays);
          } catch (error) {
            strapi.log.error('[FormFlow] Data retention purge failed:', error);
          }
        },
      },
    });

    strapi.log.info(
      `[FormFlow] Data retention enabled: submissions older than ${retentionDays} day(s) are purged daily.`
    );
  };

  const reconcileScheduledExports = async (): Promise<void> => {
    const license = strapi.plugin('formflow').service('license');
    if (!license.can('export.advanced')) {
      await removeTrackedScheduledExports();
      if (hadAdvancedExportEntitlement) {
        await removePersistedScheduledExports();
        hadAdvancedExportEntitlement = false;
      }
      return;
    }

    hadAdvancedExportEntitlement = true;
    if (!strapi.cron || typeof strapi.cron.add !== 'function') {
      return;
    }

    const { registerScheduledExport } = await import('../ee/export/index');
    let count = 0;
    await forEachScheduledExport(async (config) => {
      await registerScheduledExport(strapi, config);
      scheduledExportFormIds.add(config.formId);
      count += 1;
    });

    if (count > 0) {
      strapi.log.info(
        `[FormFlow] Re-registered ${count} scheduled export(s) after license reconciliation.`
      );
    }
  };

  const performReconcile = async (): Promise<void> => {
    try {
      await reconcileRetention();
    } catch (error) {
      strapi.log.error('[FormFlow] Failed to reconcile data retention:', error);
    }

    try {
      await reconcileScheduledExports();
    } catch (error) {
      strapi.log.error('[FormFlow] Failed to reconcile scheduled exports:', error);
    }
  };

  return {
    reconcile(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (reconcileInFlight) return reconcileInFlight;

      const request = performReconcile().finally(() => {
        if (reconcileInFlight === request) reconcileInFlight = null;
      });
      reconcileInFlight = request;
      return request;
    },

    async removeAll(): Promise<void> {
      stopped = true;
      await reconcileInFlight;

      try {
        removeCron(RETENTION_CRON_NAME);
      } catch (error) {
        strapi.log.error('[FormFlow] Failed to remove data retention:', error);
      }

      try {
        await removeTrackedScheduledExports();
        await removePersistedScheduledExports();
        hadAdvancedExportEntitlement = false;
      } catch (error) {
        strapi.log.error('[FormFlow] Failed to remove scheduled exports:', error);
      }
    },
  };
};

export default premiumJobsService;
