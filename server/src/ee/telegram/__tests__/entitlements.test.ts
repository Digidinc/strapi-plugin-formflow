/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';

import { limitForTier, type LimitKey } from '../../feature-map';
import { createLicenseService } from '../../license/service';
import coreLicenseService from '../../../services/license';
import pluginConfig from '../../../config';

assert.equal(limitForTier('free', 'telegramConnections'), 0);
assert.equal(limitForTier('pro', 'telegramConnections'), 1);
assert.equal(limitForTier('business', 'telegramConnections'), 3);
assert.doesNotThrow(() =>
  pluginConfig.validator({ telegram: { encryptionKey: Buffer.alloc(32).toString('base64') } })
);
assert.throws(
  () =>
    pluginConfig.validator({ telegram: { encryptionKey: Buffer.alloc(31).toString('base64') } }),
  /exactly 32 bytes/
);

const strapi = {
  config: { get: () => ({ license: { key: 'pro-key' } }) },
  store: () => ({
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
  }),
  log: { info: () => undefined, warn: () => undefined },
} as any;

void (async () => {
  const service = createLicenseService(strapi, {
    activate: async () => ({ instanceId: 'instance', tier: 'pro', validUntil: null }),
    validate: async () => ({
      valid: true,
      tier: 'pro',
      validUntil: null,
      status: 'active',
    }),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  await service.refresh();
  assert.equal(service.limit('telegramConnections'), 1);
  assert.equal(service.snapshot().limits.telegramConnections, 1);

  const stripped = coreLicenseService({ strapi: {} as any });
  assert.equal(stripped.limit('telegramConnections'), 0);
  assert.equal(stripped.snapshot().limits.telegramConnections, 0);

  // Compile-time identity assertion for the public MIT-safe key and EE key.
  const key: LimitKey = 'telegramConnections';
  const publicKey: import('../../../services/license').LimitKey = key;
  const roundTrip: LimitKey = publicKey;
  assert.equal(roundTrip, 'telegramConnections');
  service.destroy();
  console.log('All assertions passed: Telegram quantity entitlements.');
})();
