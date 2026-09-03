/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as licenseStateModule from '../license-state';

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
  limits: { telegramConnections: 1 },
  ...overrides,
});

const checkingSnapshot = snapshot({ resolution: 'checking' });
const unavailableSnapshot = snapshot({ resolution: 'unavailable' });
const freeSnapshot = snapshot({ tier: 'free' });
const proSnapshot = snapshot({
  tier: 'pro',
  state: 'active',
  features: { conditionalLogic: true },
  limits: { telegramConnections: 2 },
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

const unavailableNotice = licenseNoticeIdentity('unavailable', 'free', null);
const firstGraceNotice = licenseNoticeIdentity('resolved', 'grace', '2026-07-13T12:00:00Z');
const nextGraceNotice = licenseNoticeIdentity('resolved', 'grace', '2026-07-14T12:00:00Z');

// A background re-check is silent: it blocks nothing and settles on its own, so
// it must not raise a notice on any page it happens to run on.
assert.equal(licenseNoticeIdentity('checking', 'free', null), null);
assert.equal(licenseNoticeIdentity('checking', 'active', null), null);
assert.equal(licenseNoticeIdentity('checking', 'grace', '2026-07-13T12:00:00Z'), null);
// Degraded and time-limited access still have to be told.
assert.equal(unavailableNotice, 'unavailable');
assert.notEqual(firstGraceNotice, nextGraceNotice);
assert.equal(licenseNoticeIdentity('resolved', 'active', null), null);
assert.equal(reconcileDismissedNotice(unavailableNotice, unavailableNotice), unavailableNotice);
assert.equal(reconcileDismissedNotice(firstGraceNotice, nextGraceNotice), null);
assert.equal(reconcileDismissedNotice(unavailableNotice, null), null);

assert.throws(() => parseLicenseSnapshot({ tier: 'pro' }));
assert.equal(
  parseLicenseSnapshot({
    tier: 'business',
    state: 'active',
    resolution: 'resolved',
    graceUntil: null,
    features: { integrations: true },
    limits: { telegramConnections: 4 },
  }).limits.telegramConnections,
  4
);
for (const telegramConnections of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', 'forever']) {
  assert.throws(() => parseLicenseSnapshot({
    tier: 'business', state: 'active', resolution: 'resolved', graceUntil: null,
    features: { integrations: true }, limits: { telegramConnections },
  }), `must reject invalid telegram connection limit ${String(telegramConnections)}`);
}
assert.equal(parseLicenseSnapshot({
  tier: 'business', state: 'active', resolution: 'resolved', graceUntil: null,
  features: {}, limits: { telegramConnections: 'unlimited' },
}).limits.telegramConnections, 'unlimited');
assert.deepEqual([0, 1, 2, 3, 20].map(retryDelay), [250, 500, 1000, 1000, 1000]);

const refreshStartResolution = (
  licenseStateModule as typeof licenseStateModule & {
    refreshStartResolution?: (
      resolution: LicenseSnapshot['resolution']
    ) => LicenseSnapshot['resolution'];
  }
).refreshStartResolution;
assert.equal(
  typeof refreshStartResolution,
  'function',
  'license state must define how access behaves while a refresh starts'
);
assert.equal(
  refreshStartResolution?.('resolved'),
  'resolved',
  'a transient refresh must preserve the last resolved access'
);
assert.equal(refreshStartResolution?.('checking'), 'checking');
assert.equal(
  refreshStartResolution?.('unavailable'),
  'checking',
  'retrying an unavailable state must expose active verification'
);

const refreshFailureResolution = (
  licenseStateModule as typeof licenseStateModule & {
    refreshFailureResolution?: (
      resolution: LicenseSnapshot['resolution']
    ) => LicenseSnapshot['resolution'];
  }
).refreshFailureResolution;
assert.equal(
  typeof refreshFailureResolution,
  'function',
  'license state must define how access behaves when a refresh fails'
);
assert.equal(
  refreshFailureResolution?.('resolved'),
  'resolved',
  'a failed replacement refresh must preserve last-known resolved access'
);
assert.equal(refreshFailureResolution?.('checking'), 'unavailable');
assert.equal(refreshFailureResolution?.('unavailable'), 'unavailable');

const providerSource = readFileSync(
  resolve(process.cwd(), 'admin/src/ee/providers/LicenseProvider.tsx'),
  'utf8'
);
assert.match(providerSource, /const\s*\{\s*get\s*,\s*post\s*\}\s*=\s*useFetchClient\(\)/);
assert.match(
  providerSource,
  /setResolution\(\s*\(current\)\s*=>\s*refreshStartResolution\(current\)\s*\)/,
  'refresh start must preserve a resolved access state'
);
assert.match(
  providerSource,
  /setResolution\(\s*\(current\)\s*=>\s*refreshFailureResolution\(current\)\s*\)/,
  'refresh failure must preserve a previously resolved access state'
);
assert.match(
  providerSource,
  /mode\s*===\s*['"]remote['"][\s\S]*?post<unknown>\(`\/\$\{PLUGIN_ID\}\/license\/refresh`\)/,
  'manual and 402 recovery must actively refresh the server license'
);
assert.match(
  providerSource,
  /firstSnapshot\.resolution\s*===\s*['"]checking['"][\s\S]*?fetchUntilSettled\(firstSnapshot\)/,
  'a manual refresh may GET-poll only when the POST result is still checking'
);
assert.match(
  providerSource,
  /void\s+runRequest\(['"]snapshot['"]\)/,
  'initial mount must read the current snapshot without forcing remote validation'
);
assert.match(
  providerSource,
  /runRequest\(['"]remote['"]\)/,
  'context refresh must use the authenticated remote-refresh endpoint'
);

// Each menu link is a sibling route mount, so navigating between FormFlow pages
// remounts the provider. Without a session-scoped seed the remount would drop
// back to `checking` every time, flashing the notice and disabling premium
// controls on each navigation.
assert.match(
  providerSource,
  /let\s+lastSettledSnapshot:\s*LicenseSnapshot\s*\|\s*null\s*=\s*null/,
  'the provider must keep the last settled snapshot for the browser session'
);
assert.match(
  providerSource,
  /useState<LicenseSnapshot \| null>\(lastSettledSnapshot\)/,
  'a remount must seed from the last settled snapshot rather than refetching blind'
);
assert.match(
  providerSource,
  /useState<LicenseResolution>\(\s*lastSettledSnapshot\?\.resolution \?\? ['"]checking['"]\s*\)/,
  'a remount must not regress resolved access to checking'
);
assert.match(
  providerSource,
  /\.then\(\(next\) => \{\s*lastSettledSnapshot = next;/,
  'only a snapshot the server settled on may seed a later mount'
);
assert.doesNotMatch(
  providerSource,
  /localStorage|sessionStorage/,
  'the seed is memory-only — entitlement must never be restored from browser storage'
);

console.log('All assertions passed: admin license access state and retry delays.');
