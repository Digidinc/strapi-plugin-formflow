/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';

import {
  accessPresentation,
  featureAccess,
  licenseNoticeIdentity,
  parseLicenseSnapshot,
  premiumMutationPolicy,
  reconcileDismissedNotice,
  resolveFeatureAccess,
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
assert.deepEqual(accessPresentation('checking'), {
  disabled: true,
  showUpgrade: false,
  showRetry: false,
  reason: 'checking',
});
assert.equal(accessPresentation('unentitled').showUpgrade, true);
assert.equal(accessPresentation('unavailable').showRetry, true);
assert.equal(accessPresentation('entitled').disabled, false);

assert.deepEqual(premiumMutationPolicy('entitled'), { canEdit: true, canRemove: true });
assert.deepEqual(premiumMutationPolicy('unentitled'), { canEdit: false, canRemove: true });
assert.deepEqual(premiumMutationPolicy('checking'), { canEdit: false, canRemove: false });
assert.deepEqual(premiumMutationPolicy('unavailable'), { canEdit: false, canRemove: false });

assert.equal(resolveFeatureAccess('entitled'), 'entitled');
assert.equal(resolveFeatureAccess('unentitled'), 'unentitled');
assert.equal(resolveFeatureAccess('checking', undefined, true), 'checking');
assert.equal(resolveFeatureAccess('unavailable', undefined, false), 'unavailable');
assert.equal(resolveFeatureAccess('entitled', undefined, false), 'unentitled');
assert.equal(resolveFeatureAccess('unentitled', undefined, true), 'entitled');
assert.equal(resolveFeatureAccess('checking', 'entitled', false), 'entitled');

const checkingNotice = licenseNoticeIdentity('checking', 'free', null);
const unavailableNotice = licenseNoticeIdentity('unavailable', 'free', null);
const firstGraceNotice = licenseNoticeIdentity('resolved', 'grace', '2026-07-13T12:00:00Z');
const nextGraceNotice = licenseNoticeIdentity('resolved', 'grace', '2026-07-14T12:00:00Z');

assert.equal(checkingNotice, 'checking');
assert.equal(unavailableNotice, 'unavailable');
assert.notEqual(firstGraceNotice, nextGraceNotice);
assert.equal(licenseNoticeIdentity('resolved', 'active', null), null);
assert.equal(reconcileDismissedNotice(checkingNotice, checkingNotice), checkingNotice);
assert.equal(reconcileDismissedNotice(checkingNotice, unavailableNotice), null);
assert.equal(reconcileDismissedNotice(firstGraceNotice, nextGraceNotice), null);
assert.equal(reconcileDismissedNotice(unavailableNotice, null), null);

assert.throws(() => parseLicenseSnapshot({ tier: 'pro' }));
assert.deepEqual([0, 1, 2, 3, 20].map(retryDelay), [250, 500, 1000, 1000, 1000]);

console.log('All assertions passed: admin license access state and retry delays.');
