/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import licenseController from '../../../controllers/license';
import adminRoutes from '../../../routes/admin';
import coreLicenseService from '../../../services/license';
import { activate as activateMorLicense, validate as validateMorLicense } from '../mor-client';
import { createLicenseService, type LicenseDependencies, type LicenseService } from '../service';

const NOW = new Date('2026-02-01T00:00:00.000Z');
const VALID_PRO = {
  valid: true,
  tier: 'pro' as const,
  validUntil: new Date('2026-12-31T00:00:00.000Z'),
  status: 'active',
};
const VALID_BUSINESS = {
  valid: true,
  tier: 'business' as const,
  validUntil: new Date('2026-12-31T00:00:00.000Z'),
  status: 'active',
};
const UNREACHABLE = {
  valid: false,
  tier: 'free' as const,
  validUntil: null,
  status: 'error',
};
const DEFINITIVELY_INVALID = {
  valid: false,
  tier: 'free' as const,
  validUntil: null,
  status: 'expired',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function dependencies(overrides: Partial<LicenseDependencies> = {}): LicenseDependencies {
  return {
    activate: async () => ({
      instanceId: 'instance-1',
      tier: 'pro',
      validUntil: VALID_PRO.validUntil,
    }),
    validate: async () => VALID_PRO,
    now: () => new Date(NOW),
    ...overrides,
  };
}

function inMemoryStrapi(
  licenseKey: string | (() => string) = '',
  seed: Record<string, unknown> = {}
) {
  const values = new Map<string, unknown>(Object.entries(seed));

  const strapi = {
    config: {
      get(key: string, fallback: unknown) {
        if (key === 'plugin::formflow') {
          const currentLicenseKey = typeof licenseKey === 'function' ? licenseKey() : licenseKey;
          return currentLicenseKey ? { license: { key: currentLicenseKey } } : {};
        }
        return fallback;
      },
    },
    store() {
      return {
        async get({ key }: { key: string }) {
          return values.has(key) ? values.get(key) : null;
        },
        async set({ key, value }: { key: string; value: unknown }) {
          values.set(key, value);
        },
        async delete({ key }: { key: string }) {
          values.delete(key);
        },
      };
    },
    log: {
      info(..._args: unknown[]) {},
      warn(..._args: unknown[]) {},
    },
  };

  return strapi as any;
}

void (async () => {
  const services: LicenseService[] = [];
  const create = (licenseKey = '', deps = dependencies(), seed = {}) => {
    const service = createLicenseService(inMemoryStrapi(licenseKey, seed), deps);
    services.push(service);
    return service;
  };

  try {
    const noKey = create();
    assert.equal(noKey.snapshot().resolution, 'resolved');
    assert.equal(noKey.snapshot().tier, 'free');

    const freshValidation = deferred<typeof VALID_PRO>();
    const freshKey = 'raw-fresh-license-key';
    const fresh = create(freshKey, dependencies({ validate: () => freshValidation.promise }));
    await fresh.init();
    assert.equal(fresh.snapshot().resolution, 'checking');
    freshValidation.resolve(VALID_PRO);
    await fresh.whenReady();
    assert.equal(fresh.snapshot().resolution, 'resolved');
    assert.equal(fresh.snapshot().tier, 'pro');
    assert.equal(fresh.snapshot().limits.telegramConnections, 1);
    assert.equal(fresh.limit('telegramConnections'), 1);
    assert.equal(fresh.can('conditionalLogic'), true);
    assert.equal(JSON.stringify(fresh.snapshot()).includes(freshKey), false);

    const unavailable = create(
      'raw-unavailable-license-key',
      dependencies({ validate: async () => UNREACHABLE })
    );
    await unavailable.init();
    await unavailable.whenReady();
    assert.equal(unavailable.snapshot().resolution, 'unavailable');
    assert.equal(unavailable.can('conditionalLogic'), false);

    const cachedKey = 'raw-cached-license-key';
    const cachedValidation = deferred<typeof UNREACHABLE>();
    const cached = create(cachedKey, dependencies({ validate: () => cachedValidation.promise }), {
      'license-key-hash': createHash('sha256').update(cachedKey).digest('hex'),
      'license-cache': {
        tier: 'pro',
        status: 'active',
        validUntil: '2026-01-15T00:00:00.000Z',
        lastValidatedAt: '2026-01-01T00:00:00.000Z',
        graceUntil: '2026-02-15T00:00:00.000Z',
      },
    });
    await cached.init();
    assert.equal(cached.snapshot().resolution, 'resolved');
    assert.equal(cached.snapshot().state, 'grace');
    assert.equal(cached.can('conditionalLogic'), true);
    cachedValidation.resolve(UNREACHABLE);
    await cached.whenReady();
    assert.equal(cached.snapshot().resolution, 'resolved');
    assert.equal(cached.snapshot().state, 'grace');
    assert.equal(cached.can('conditionalLogic'), true);

    const expiredKey = 'raw-expired-cache-license-key';
    const expiredValidation = deferred<typeof VALID_PRO>();
    const expired = create(
      expiredKey,
      dependencies({ validate: () => expiredValidation.promise }),
      {
        'license-key-hash': createHash('sha256').update(expiredKey).digest('hex'),
        'license-cache': {
          tier: 'pro',
          status: 'active',
          validUntil: '2026-01-15T00:00:00.000Z',
          lastValidatedAt: '2026-01-01T00:00:00.000Z',
          graceUntil: '2026-01-31T00:00:00.000Z',
        },
      }
    );
    await expired.init();
    assert.equal(expired.snapshot().resolution, 'checking');
    assert.equal(expired.snapshot().tier, 'free');
    assert.equal(expired.snapshot().state, 'expired');
    assert.equal(expired.can('conditionalLogic'), false);
    expiredValidation.resolve(VALID_PRO);
    await expired.whenReady();
    assert.equal(expired.snapshot().resolution, 'resolved');
    assert.equal(expired.snapshot().tier, 'pro');
    assert.equal(expired.snapshot().state, 'active');

    const invalid = create(
      'raw-invalid-license-key',
      dependencies({ validate: async () => DEFINITIVELY_INVALID })
    );
    await invalid.init();
    await invalid.whenReady();
    assert.equal(invalid.snapshot().resolution, 'resolved');
    assert.equal(invalid.snapshot().tier, 'free');
    assert.equal(invalid.snapshot().state, 'expired');

    const retryValidation = deferred<typeof VALID_PRO>();
    let retryCalls = 0;
    const retrying = create(
      'raw-retry-license-key',
      dependencies({
        validate: () => {
          retryCalls += 1;
          return retryCalls === 1 ? Promise.resolve(UNREACHABLE) : retryValidation.promise;
        },
      })
    );
    await retrying.init();
    await retrying.whenReady();
    assert.equal(retrying.snapshot().resolution, 'unavailable');
    const retry = retrying.refresh();
    assert.equal(retrying.snapshot().resolution, 'checking');
    retryValidation.resolve(VALID_PRO);
    await retry;
    assert.equal(retrying.snapshot().resolution, 'resolved');
    assert.equal(retrying.snapshot().tier, 'pro');

    let staleNow = new Date(NOW);
    let staleValidationCalls = 0;
    const staleKey = 'raw-stale-cache-license-key';
    const stale = create(
      staleKey,
      dependencies({
        now: () => new Date(staleNow),
        validate: async () => {
          staleValidationCalls += 1;
          if (staleValidationCalls === 1) return UNREACHABLE;
          throw new Error('injected validation failure');
        },
      }),
      {
        'license-key-hash': createHash('sha256').update(staleKey).digest('hex'),
        'license-cache': {
          tier: 'pro',
          status: 'active',
          validUntil: '2026-01-15T00:00:00.000Z',
          lastValidatedAt: '2026-01-01T00:00:00.000Z',
          graceUntil: '2026-02-15T00:00:00.000Z',
        },
      }
    );
    await stale.init();
    await stale.whenReady();
    assert.equal(stale.snapshot().state, 'grace');
    assert.equal(stale.can('conditionalLogic'), true);

    staleNow = new Date('2026-02-16T00:00:00.000Z');
    assert.equal(stale.can('conditionalLogic'), false);
    const elapsedGraceSnapshot = stale.snapshot();
    assert.equal(elapsedGraceSnapshot.features.conditionalLogic, false);
    assert.equal(
      elapsedGraceSnapshot.resolution,
      'unavailable',
      'elapsed connectivity grace is unverified, not confirmed unentitled'
    );
    assert.equal(elapsedGraceSnapshot.tier, 'free');
    assert.equal(elapsedGraceSnapshot.state, 'expired');
    assert.equal(stale.resolution(), 'unavailable');
    assert.equal(stale.tier(), 'free');
    assert.equal(stale.state(), 'expired');
    const staleRefresh = stale.refresh();
    assert.equal(stale.snapshot().resolution, 'checking');
    await staleRefresh;
    assert.equal(stale.snapshot().resolution, 'unavailable');
    assert.equal(stale.snapshot().tier, 'free');
    assert.equal(stale.snapshot().state, 'expired');
    assert.equal(stale.can('conditionalLogic'), false);

    let removableKey = 'raw-removable-license-key';
    let removalNow = new Date(NOW);
    const removable = createLicenseService(
      inMemoryStrapi(() => removableKey, {
        'license-key-hash': createHash('sha256').update(removableKey).digest('hex'),
        'license-cache': {
          tier: 'pro',
          status: 'active',
          validUntil: '2026-01-15T00:00:00.000Z',
          lastValidatedAt: '2026-01-01T00:00:00.000Z',
          graceUntil: '2026-02-15T00:00:00.000Z',
        },
      }),
      dependencies({ now: () => new Date(removalNow), validate: async () => UNREACHABLE })
    );
    services.push(removable);
    await removable.init();
    await removable.whenReady();
    assert.equal(removable.snapshot().tier, 'pro');
    removableKey = '';
    await removable.refresh();
    removalNow = new Date('2026-02-16T00:00:00.000Z');
    assert.equal(removable.snapshot().resolution, 'resolved');
    assert.equal(removable.snapshot().tier, 'free');
    assert.equal(removable.snapshot().state, 'free');

    const dedupedValidation = deferred<typeof VALID_PRO>();
    const deduped = create(
      'raw-deduped-license-key',
      dependencies({ validate: () => dedupedValidation.promise })
    );
    const first = deduped.refresh();
    const second = deduped.refresh();
    assert.strictEqual(first, second);
    dedupedValidation.resolve(VALID_PRO);
    await first;

    let activationCalls = 0;
    const activationRecovery = create(
      'raw-activation-recovery-key',
      dependencies({
        activate: async () => {
          activationCalls += 1;
          return activationCalls === 1
            ? null
            : {
                instanceId: 'recovered-instance',
                tier: 'business',
                validUntil: VALID_BUSINESS.validUntil,
              };
        },
        validate: async () => VALID_BUSINESS,
      })
    );
    await activationRecovery.init();
    await activationRecovery.whenReady();
    assert.equal(activationRecovery.snapshot().tier, 'business');
    assert.equal(activationRecovery.snapshot().state, 'active');
    assert.equal(activationRecovery.snapshot().resolution, 'resolved');
    assert.equal(activationCalls, 1);
    await activationRecovery.refresh();
    assert.equal(activationCalls, 2, 'activation retries while no instance id is stored');
    await activationRecovery.refresh();
    assert.equal(activationCalls, 2, 'a stored instance id short-circuits later activation');

    let inactiveActivationCalls = 0;
    let inactiveValidationCalls = 0;
    const inactiveRecovery = create(
      'raw-inactive-recovery-key',
      dependencies({
        activate: async () => {
          inactiveActivationCalls += 1;
          return inactiveActivationCalls === 1
            ? null
            : {
                instanceId: 'inactive-recovered-instance',
                tier: 'business',
                validUntil: VALID_BUSINESS.validUntil,
              };
        },
        validate: async () => {
          inactiveValidationCalls += 1;
          return inactiveValidationCalls === 1
            ? {
                valid: false,
                tier: 'free',
                validUntil: null,
                status: 'inactive',
              }
            : VALID_BUSINESS;
        },
      })
    );
    await inactiveRecovery.init();
    await inactiveRecovery.whenReady();
    assert.equal(inactiveRecovery.snapshot().tier, 'free');
    assert.equal(inactiveRecovery.snapshot().state, 'expired');
    await inactiveRecovery.init();
    await inactiveRecovery.whenReady();
    assert.equal(inactiveActivationCalls, 2);
    assert.equal(inactiveRecovery.snapshot().tier, 'business');
    assert.equal(inactiveRecovery.snapshot().state, 'active');
    assert.equal(inactiveRecovery.snapshot().resolution, 'resolved');

    const wrapped = coreLicenseService({ strapi: inMemoryStrapi() });
    await wrapped.init();
    const wrappedFirst = wrapped.refresh();
    const wrappedSecond = wrapped.refresh();
    assert.strictEqual(wrappedFirst, wrappedSecond);
    await wrappedFirst;
    wrapped.destroy();

    const refreshRoute = adminRoutes.routes.find(
      (route) => route.method === 'POST' && route.path === '/license/refresh'
    );
    assert.ok(refreshRoute, 'admin routes must expose POST /license/refresh');
    assert.equal(refreshRoute.handler, 'license.refresh');
    assert.deepEqual(refreshRoute.config.policies, ['admin::isAuthenticatedAdmin']);

    const callOrder: string[] = [];
    const refreshedSnapshot = {
      tier: 'pro',
      state: 'active',
      resolution: 'resolved',
      graceUntil: '2026-02-15T00:00:00.000Z',
      features: { conditionalLogic: true },
    };
    const controllerServices = {
      license: {
        async refresh() {
          callOrder.push('refresh');
        },
        snapshot() {
          callOrder.push('snapshot');
          return refreshedSnapshot;
        },
      },
      'premium-jobs': {
        async reconcile() {
          callOrder.push('reconcile');
        },
      },
    };
    const refreshController = licenseController({
      strapi: {
        plugin() {
          return {
            service(name: keyof typeof controllerServices) {
              return controllerServices[name];
            },
          };
        },
      } as any,
    }) as ReturnType<typeof licenseController> & {
      refresh?: (ctx: { body: unknown }) => Promise<void>;
    };
    assert.equal(typeof refreshController.refresh, 'function');
    const refreshContext = { body: null as unknown };
    await refreshController.refresh?.(refreshContext);
    assert.deepEqual(callOrder, ['refresh', 'reconcile', 'snapshot']);
    assert.strictEqual(refreshContext.body, refreshedSnapshot);

    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    try {
      console.warn = () => {};
      for (const status of [408, 429]) {
        globalThis.fetch = async () => ({ ok: false, status }) as Response;
        const transientResult = await validateMorLicense({ licenseKey: 'rate-limited-key' });
        assert.equal(
          transientResult.status,
          'error',
          `HTTP ${status} is transient and must preserve cached entitlement grace`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }

    const originalMorSetTimeout = globalThis.setTimeout;
    const originalMorError = console.error;
    try {
      console.error = () => {};
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalMorSetTimeout(
          callback,
          delay === 5000 ? 5 : 50,
          ...args
        )) as typeof globalThis.setTimeout;

      const delayedFetch =
        (json: Record<string, unknown>) =>
        async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise<Response>((resolve, reject) => {
            const responseTimer = originalMorSetTimeout(
              () => resolve({ ok: true, status: 200, json: async () => json } as Response),
              10
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(responseTimer);
                reject(new DOMException('The operation was aborted', 'AbortError'));
              },
              { once: true }
            );
          });

      globalThis.fetch = delayedFetch({
        activated: true,
        instance: { id: 'slow-activation-instance' },
        meta: { variant_name: 'Business annual' },
        license_key: { expires_at: '2026-12-31T00:00:00.000Z' },
      });
      const slowActivation = await activateMorLicense({
        licenseKey: 'slow-activation-key',
        instanceName: 'slow-activation-instance-name',
      });
      assert.equal(
        slowActivation?.instanceId,
        'slow-activation-instance',
        'activation must allow a response beyond the normal validation timeout'
      );

      globalThis.fetch = delayedFetch({
        valid: true,
        meta: { variant_name: 'Business annual' },
        license_key: { status: 'active', expires_at: '2026-12-31T00:00:00.000Z' },
      });
      const slowValidation = await validateMorLicense({ licenseKey: 'slow-validation-key' });
      assert.equal(
        slowValidation.status,
        'error',
        'validation must retain the normal five-second timeout'
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalMorSetTimeout;
      console.error = originalMorError;
    }

    const originalSetTimeout = globalThis.setTimeout;
    const originalError = console.error;
    let bodyTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      console.error = () => {};
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        _delay?: number,
        ...args: unknown[]
      ) => originalSetTimeout(callback, 5, ...args)) as typeof globalThis.setTimeout;
      globalThis.fetch = async (_input, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new Error('body read aborted')),
                { once: true }
              );
            }),
        }) as Response;

      const stalledBodyResult = await Promise.race([
        validateMorLicense({ licenseKey: 'stalled-body-key' }),
        new Promise<never>((_resolve, reject) => {
          bodyTimeoutId = originalSetTimeout(
            () => reject(new Error('license response body was not aborted')),
            100
          );
        }),
      ]);
      assert.equal(stalledBodyResult.status, 'error');
    } finally {
      if (bodyTimeoutId !== undefined) clearTimeout(bodyTimeoutId);
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      console.error = originalError;
    }

    console.log('All assertions passed: license lifecycle resolution and refresh de-duplication.');
  } finally {
    for (const service of services) service.destroy();
  }
})();
