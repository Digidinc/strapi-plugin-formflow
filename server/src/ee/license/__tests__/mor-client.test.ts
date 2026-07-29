/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapTier,
  mapTierFromName,
  toUid,
  FREEMIUS_PRO_PLAN_ID,
  FREEMIUS_BUSINESS_PLAN_ID,
} from '../mor-client';

test('mapTier: plan_id → tier, unknown → free', () => {
  assert.equal(mapTier(FREEMIUS_PRO_PLAN_ID), 'pro');
  assert.equal(mapTier(FREEMIUS_BUSINESS_PLAN_ID), 'business');
  assert.equal(mapTier('999999'), 'free');
  assert.equal(mapTier(null), 'free');
});

test('mapTierFromName: business beats pro, else free', () => {
  assert.equal(mapTierFromName('Business Annual'), 'business');
  assert.equal(mapTierFromName('Pro'), 'pro');
  assert.equal(mapTierFromName('Starter'), 'free');
  assert.equal(mapTierFromName(undefined), 'free');
});

test('toUid strips hyphens to 32 chars', () => {
  assert.equal(toUid('7f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b').length, 32);
  assert.match(toUid('7f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b'), /^[0-9a-f]{32}$/);
});
