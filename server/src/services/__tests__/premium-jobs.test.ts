import assert from 'node:assert/strict';

import destroyPlugin from '../../destroy';
import premiumJobsService, { RETENTION_CRON_NAME } from '../premium-jobs';

interface CronEntry {
  options: string;
  task(): Promise<void>;
}

const SCHEDULED_EXPORT_CRON_NAME = 'formflow_scheduled_export_form-1';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function createHarness(
  options: { firstFormLookup?: Promise<void>; lookupStarted?: () => void } = {}
) {
  const crons = new Map<string, CronEntry>();
  const addCounts = new Map<string, number>();
  const storedConfigs = new Map<string, unknown>([
    [
      'scheduled-export-form-1',
      {
        formId: 'form-1',
        format: 'csv',
        cronExpression: '0 6 * * *',
        recipientEmails: ['owner@example.com'],
      },
    ],
  ]);

  const license = {
    allowRetention: true,
    allowExports: false,
    can(feature: string) {
      if (feature === 'compliance.retention') return this.allowRetention;
      if (feature === 'export.advanced') return this.allowExports;
      return false;
    },
  };

  let deleteOlderThanCalls = 0;
  let exportCalls = 0;
  let emailCalls = 0;
  let formLookupCount = 0;

  const services = {
    license,
    submission: {
      async deleteOlderThan(_retentionDays: number) {
        deleteOlderThanCalls += 1;
      },
    },
    export: {
      async exportToCSV(_formId: string) {
        exportCalls += 1;
        return '\ufeffid\nsubmission-1';
      },
    },
    form: {
      async findOne(_formId: string) {
        return { slug: 'contact', title: 'Contact' };
      },
    },
  };

  const strapi = {
    config: {
      get(key: string, fallback: unknown) {
        return key === 'plugin::formflow' ? { dataRetentionDays: 30 } : fallback;
      },
    },
    cron: {
      add(entries: Record<string, CronEntry>) {
        for (const [name, entry] of Object.entries(entries)) {
          addCounts.set(name, (addCounts.get(name) ?? 0) + 1);
          crons.set(name, entry);
        }
      },
      remove(name: string) {
        crons.delete(name);
      },
    },
    plugin() {
      return {
        service(name: keyof typeof services) {
          return services[name];
        },
      };
    },
    store() {
      return {
        async get({ key }: { key: string }) {
          return storedConfigs.get(key) ?? null;
        },
      };
    },
    documents() {
      return {
        async findMany() {
          formLookupCount += 1;
          if (formLookupCount === 1 && options.firstFormLookup) {
            options.lookupStarted?.();
            await options.firstFormLookup;
          }
          return [{ documentId: 'form-1' }];
        },
      };
    },
    plugins: {
      email: {
        services: {
          email: {
            async send() {
              emailCalls += 1;
            },
          },
        },
      },
    },
    log: {
      info(..._args: unknown[]) {},
      error(..._args: unknown[]) {},
    },
  };

  return {
    jobs: premiumJobsService({ strapi: strapi as any }),
    license,
    crons,
    addCountFor: (name: string) => addCounts.get(name) ?? 0,
    deleteOlderThanCalls: () => deleteOlderThanCalls,
    exportCalls: () => exportCalls,
    emailCalls: () => emailCalls,
  };
}

void (async () => {
  const harness = createHarness();
  const { jobs, license, crons, addCountFor } = harness;

  await jobs.reconcile();
  assert.equal(crons.has(RETENTION_CRON_NAME), true);

  license.allowRetention = false;
  await crons.get(RETENTION_CRON_NAME)!.task();
  assert.equal(harness.deleteOlderThanCalls(), 0);

  await jobs.reconcile();
  assert.equal(crons.has(RETENTION_CRON_NAME), false);

  await jobs.reconcile();
  await jobs.reconcile();
  assert.equal(addCountFor(RETENTION_CRON_NAME), 1);

  assert.equal(crons.has(SCHEDULED_EXPORT_CRON_NAME), false);
  license.allowExports = true;
  await jobs.reconcile();
  assert.equal(
    crons.has(SCHEDULED_EXPORT_CRON_NAME),
    true,
    'persisted scheduled exports rehydrate after entitlement becomes active'
  );

  license.allowExports = false;
  await crons.get(SCHEDULED_EXPORT_CRON_NAME)!.task();
  assert.equal(harness.exportCalls(), 0, 'scheduled export generation skips after lapse');
  assert.equal(harness.emailCalls(), 0, 'scheduled export delivery skips after lapse');

  await jobs.reconcile();
  assert.equal(crons.has(SCHEDULED_EXPORT_CRON_NAME), false);

  license.allowExports = true;
  await jobs.reconcile();
  await jobs.reconcile();
  assert.equal(crons.has(SCHEDULED_EXPORT_CRON_NAME), true);
  assert.equal(
    [...crons.keys()].filter((name) => name === SCHEDULED_EXPORT_CRON_NAME).length,
    1,
    'repeated reconciliation keeps one stable scheduled-export entry'
  );

  await crons.get(SCHEDULED_EXPORT_CRON_NAME)!.task();
  assert.equal(harness.exportCalls(), 1, 'scheduled export generation runs while entitled');
  assert.equal(harness.emailCalls(), 1, 'scheduled export delivery runs while entitled');

  await jobs.removeAll();
  assert.equal(crons.has(RETENTION_CRON_NAME), false);
  assert.equal(crons.has(SCHEDULED_EXPORT_CRON_NAME), false);

  const retentionAddsAtDestroy = addCountFor(RETENTION_CRON_NAME);
  const exportAddsAtDestroy = addCountFor(SCHEDULED_EXPORT_CRON_NAME);
  await jobs.reconcile();
  assert.equal(
    addCountFor(RETENTION_CRON_NAME),
    retentionAddsAtDestroy,
    'a late whenReady continuation cannot re-register retention after teardown'
  );
  assert.equal(
    addCountFor(SCHEDULED_EXPORT_CRON_NAME),
    exportAddsAtDestroy,
    'a late whenReady continuation cannot re-register exports after teardown'
  );

  const destroyCalls: string[] = [];
  await destroyPlugin({
    strapi: {
      cron: {
        remove(name: string) {
          destroyCalls.push(`cron:${name}`);
        },
      },
      plugin() {
        return {
          service(name: string) {
            if (name === 'premium-jobs') {
              return {
                async removeAll() {
                  destroyCalls.push('premium-jobs.removeAll');
                },
              };
            }
            return {
              destroy() {
                destroyCalls.push('license.destroy');
              },
            };
          },
        };
      },
      store() {
        return {
          async get() {
            return null;
          },
        };
      },
      documents() {
        return {
          async findMany() {
            return [];
          },
        };
      },
      log: { error(..._args: unknown[]) {} },
    } as any,
  });
  assert.ok(
    destroyCalls.includes('premium-jobs.removeAll'),
    'plugin destroy delegates premium job teardown to the lifecycle owner'
  );

  const continueLookup = deferred();
  const lookupStarted = deferred();
  const racing = createHarness({
    firstFormLookup: continueLookup.promise,
    lookupStarted: () => lookupStarted.resolve(),
  });
  racing.license.allowExports = true;
  const inFlightReconcile = racing.jobs.reconcile();
  await lookupStarted.promise;
  let removalSettled = false;
  const concurrentRemoval = racing.jobs.removeAll().then(() => {
    removalSettled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    removalSettled,
    false,
    'teardown waits for an in-flight reconciliation before final cleanup'
  );
  continueLookup.resolve();
  await Promise.all([inFlightReconcile, concurrentRemoval]);
  assert.equal(racing.crons.has(RETENTION_CRON_NAME), false);
  assert.equal(racing.crons.has(SCHEDULED_EXPORT_CRON_NAME), false);

  console.log('All assertions passed: premium jobs follow settled entitlement.');
})();
