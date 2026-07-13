/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';

import {
  featureAccess,
  parseLicenseSnapshot,
  retryDelay,
  type LicenseSnapshot,
} from '../license-state';

const snapshot = (overrides: Partial<LicenseSnapshot>): LicenseSnapshot => ({
  tier: 'free',
  state: 'free',
  resolution: 'resolved',
  graceUntil: null,
  features: {},
  ...overrides,
});

const checkingSnapshot = snapshot({ resolution: 'checking' });
const unavailableSnapshot = snapshot({ resolution: 'unavailable' });
const freeSnapshot = snapshot({ tier: 'free' });
const proSnapshot = snapshot({
  tier: 'pro',
  state: 'active',
  features: { conditionalLogic: true },
});
const businessSnapshot = snapshot({
  tier: 'business',
  state: 'active',
  features: { conditionalLogic: true },
});

assert.equal(featureAccess(null, 'conditionalLogic'), 'checking');
assert.equal(featureAccess(checkingSnapshot, 'conditionalLogic'), 'checking');
assert.equal(featureAccess(unavailableSnapshot, 'conditionalLogic'), 'unavailable');
assert.equal(featureAccess(null, 'fields.file'), 'entitled');
assert.equal(featureAccess(checkingSnapshot, 'fields.file'), 'entitled');
assert.equal(featureAccess(unavailableSnapshot, 'fields.file'), 'entitled');
assert.equal(featureAccess(freeSnapshot, 'conditionalLogic'), 'unentitled');
assert.equal(featureAccess(proSnapshot, 'conditionalLogic'), 'entitled');
assert.equal(featureAccess(businessSnapshot, 'conditionalLogic'), 'entitled');
assert.throws(() => parseLicenseSnapshot({ tier: 'pro' }));
assert.deepEqual([0, 1, 2, 3, 20].map(retryDelay), [250, 500, 1000, 1000, 1000]);

console.log('All assertions passed: admin license access state and retry delays.');
