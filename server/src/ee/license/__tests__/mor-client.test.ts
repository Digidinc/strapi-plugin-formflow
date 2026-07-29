/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activate,
  mapTier,
  mapTierFromName,
  toUid,
  morFetch,
  parseDate,
  ENDPOINT_BASE,
  FREEMIUS_PRO_PLAN_ID,
  FREEMIUS_BUSINESS_PLAN_ID,
} from '../mor-client';

/** Restore the real fetch after stubbing it, so tests never leak into each other. */
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

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

test('morFetch: error body (HTTP 200) → client-error with code', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'invalid_license_key' } }), {
      status: 200,
    })) as any;
  assert.deepEqual(await morFetch(`${ENDPOINT_BASE}/x`, { method: 'GET' }), {
    kind: 'client-error',
    code: 'invalid_license_key',
  });
});

test('morFetch: HTTP 402 and 5xx and throw → connectivity', async () => {
  for (const status of [402, 500]) {
    globalThis.fetch = (async () => new Response('{}', { status })) as any;
    assert.deepEqual(await morFetch(`${ENDPOINT_BASE}/x`, { method: 'GET' }), {
      kind: 'connectivity',
    });
  }
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as any;
  assert.deepEqual(await morFetch(`${ENDPOINT_BASE}/x`, { method: 'GET' }), {
    kind: 'connectivity',
  });
});

test('morFetch: sends no authorization header', async () => {
  let sentHeaders: Record<string, string> = {};
  globalThis.fetch = (async (_u: any, init: any) => {
    sentHeaders = init.headers;
    return new Response('{}', { status: 200 });
  }) as any;
  await morFetch(`${ENDPOINT_BASE}/x`, { method: 'POST', body: { a: 1 } });
  const keys = Object.keys(sentHeaders).map((k) => k.toLowerCase());
  assert.equal(keys.includes('authorization'), false);
});

test('parseDate treats Y-m-d H:i:s as UTC', () => {
  assert.equal(parseDate('2027-01-02 03:04:05')!.toISOString(), '2027-01-02T03:04:05.000Z');
  assert.equal(parseDate(null), null);
});

test('activate parses install_id + tier from license_plan_name', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ install_id: '555', license_plan_name: 'Business Annual' }), {
      status: 200,
    })) as any;
  assert.deepEqual(await activate({ licenseKey: 'K', instanceName: 'a-b-c' }), {
    instanceId: '555',
    tier: 'business',
    validUntil: null,
  });
});

test('activate sends a hyphen-free uid and the license key', async () => {
  let sent: any;
  globalThis.fetch = (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ install_id: '1', license_plan_name: 'Pro' }), {
      status: 200,
    });
  }) as any;
  await activate({ licenseKey: 'K', instanceName: '7f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b' });
  assert.equal(sent.uid, '7f4a1b2c3d4e5f608a9b0c1d2e3f4a5b');
  assert.equal(sent.license_key, 'K');
});

test('activate recovers install id from license_activated error', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { code: 'license_activated', message: 'already activated on install 777' },
      }),
      { status: 200 }
    )) as any;
  const r = await activate({ licenseKey: 'K', instanceName: 'a-b-c' });
  assert.equal(r?.instanceId, '777');
});

test('activate returns null on an unrecoverable failure', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'invalid_license_key' } }), {
      status: 200,
    })) as any;
  assert.equal(await activate({ licenseKey: 'K', instanceName: 'a-b-c' }), null);
});
