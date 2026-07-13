/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import coreLicenseService from '../../../services/license';
import { createLicenseService, type LicenseDependencies, type LicenseService } from '../service';

const NOW = new Date('2026-02-01T00:00:00.000Z');
const VALID_PRO = {
  valid: true,
  tier: 'pro' as const,
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

function inMemoryStrapi(licenseKey = '', seed: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(seed));

  const strapi = {
    config: {
      get(key: string, fallback: unknown) {
        if (key === 'plugin::formflow') {
          return licenseKey ? { license: { key: licenseKey } } : {};
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
    assert.equal(stale.snapshot().features.conditionalLogic, false);
    const staleRefresh = stale.refresh();
    assert.equal(stale.snapshot().resolution, 'checking');
    await staleRefresh;
    assert.equal(stale.snapshot().resolution, 'unavailable');
    assert.equal(stale.snapshot().tier, 'free');
    assert.equal(stale.snapshot().state, 'expired');
    assert.equal(stale.can('conditionalLogic'), false);

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

    const wrapped = coreLicenseService({ strapi: inMemoryStrapi() });
    await wrapped.init();
    const wrappedFirst = wrapped.refresh();
    const wrappedSecond = wrapped.refresh();
    assert.strictEqual(wrappedFirst, wrappedSecond);
    await wrappedFirst;
    wrapped.destroy();

    console.log('All assertions passed: license lifecycle resolution and refresh de-duplication.');
  } finally {
    for (const service of services) service.destroy();
  }
})();
