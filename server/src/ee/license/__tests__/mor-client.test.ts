/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activate,
  validate,
  deactivate,
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
const INSTANCE_NAME = '7f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b';
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
  assert.equal(toUid(INSTANCE_NAME)!.length, 32);
  assert.match(toUid(INSTANCE_NAME)!, /^[0-9a-f]{32}$/);
  assert.equal(toUid('not-a-uuid'), null);
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

test('morFetch: 5xx and throw → connectivity; HTTP 402 → client error', async () => {
  for (const status of [500]) {
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

  globalThis.fetch = (async () => new Response('{}', { status: 402 })) as any;
  assert.deepEqual(await morFetch(`${ENDPOINT_BASE}/x`, { method: 'GET' }), {
    kind: 'client-error',
    code: 'http_402',
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

test('morFetch: never logs a validation URL containing the license key', async () => {
  const realWarn = console.warn;
  const realError = console.error;
  const messages: string[] = [];
  const secret = 'customer-license-key';

  try {
    console.warn = (...args: unknown[]) => messages.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(' '));

    const url = `${ENDPOINT_BASE}/x?license_key=${secret}`;
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as any;
    await morFetch(url, { method: 'GET' });

    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as any;
    await morFetch(url, { method: 'GET' });

    assert.equal(messages.some((message) => message.includes(secret)), false);
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
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
  assert.deepEqual(await activate({ licenseKey: 'K', instanceName: INSTANCE_NAME }), {
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
  await activate({ licenseKey: 'K', instanceName: INSTANCE_NAME });
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
  const r = await activate({ licenseKey: 'K', instanceName: INSTANCE_NAME });
  assert.equal(r?.instanceId, '777');
});

test('activate returns null on an unrecoverable failure', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'invalid_license_key' } }), {
      status: 200,
    })) as any;
  assert.equal(await activate({ licenseKey: 'K', instanceName: INSTANCE_NAME }), null);
});

test('validate active → valid + tier from plan_id', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        plan_id: FREEMIUS_BUSINESS_PLAN_ID,
        expiration: '2027-01-01 00:00:00',
        is_cancelled: false,
      }),
      { status: 200 }
    )) as any;
  assert.deepEqual(await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME }), {
    valid: true,
    tier: 'business',
    validUntil: parseDate('2027-01-01 00:00:00'),
    status: 'active',
  });
});

test('validate sends the 32-char uid and license key as query params', async () => {
  let calledUrl = '';
  globalThis.fetch = (async (u: any) => {
    calledUrl = String(u);
    return new Response(JSON.stringify({ plan_id: FREEMIUS_PRO_PLAN_ID }), { status: 200 });
  }) as any;
  await validate({
    licenseKey: 'K',
    instanceId: '555',
    instanceName: INSTANCE_NAME,
  });
  const url = new URL(calledUrl);
  assert.equal(url.searchParams.get('uid'), '7f4a1b2c3d4e5f608a9b0c1d2e3f4a5b');
  assert.equal(url.searchParams.get('license_key'), 'K');
  assert.match(url.pathname, /\/installs\/555\/license\.json$/);
});

test('validate cancelled → hard-expire', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        plan_id: FREEMIUS_PRO_PLAN_ID,
        expiration: '2027-01-01 00:00:00',
        is_cancelled: true,
      }),
      { status: 200 }
    )) as any;
  const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.valid, false);
});

test('validate past expiration → expired (UTC boundary)', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ plan_id: FREEMIUS_PRO_PLAN_ID, expiration: '2020-01-01 00:00:00' }),
      { status: 200 }
    )) as any;
  const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME });
  assert.equal(r.status, 'expired');
  assert.equal(r.valid, false);
});

test('validate maps definitive error codes to non-error statuses', async () => {
  const cases: Array<[string, string]> = [
    ['invalid_license_key', 'invalid'],
    ['license_expired', 'expired'],
    ['license_utilized', 'utilized'],
    ['something_unknown', 'invalid'],
  ];
  for (const [code, expected] of cases) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code } }), { status: 200 })) as any;
    const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME });
    assert.equal(r.status, expected, `code ${code}`);
    assert.equal(r.valid, false);
    assert.notEqual(r.status, 'error'); // must hard-expire, never enter grace
  }
});

test('validate with NO install id → status error (grace, not rejection)', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as any;
  const r = await validate({ licenseKey: 'K', instanceName: INSTANCE_NAME });
  assert.deepEqual(r, { valid: false, tier: 'free', validUntil: null, status: 'error' });
  assert.equal(called, false); // never builds /installs/undefined/...
});

test('validate connectivity → status error', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as any;
  const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME });
  assert.equal(r.status, 'error');
});

test('deactivate posts uid+install_id+key and never throws', async () => {
  let sent: any;
  globalThis.fetch = (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  }) as any;
  await assert.doesNotReject(
    deactivate({
      licenseKey: 'K',
      instanceId: '555',
      instanceName: INSTANCE_NAME,
    })
  );
  assert.equal(sent.install_id, '555');
  assert.equal(sent.license_key, 'K');
  // Must be the SAME 32-char uid activate/validate send, or Freemius rejects it.
  assert.equal(sent.uid, '7f4a1b2c3d4e5f608a9b0c1d2e3f4a5b');
  assert.equal(sent.uid.length, 32);
});

test('deactivate swallows a connectivity failure', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as any;
  await assert.doesNotReject(
    deactivate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME })
  );
});

test('validate unknown plan_id fails closed to free', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ plan_id: '999999', expiration: '2027-01-01 00:00:00' }), {
      status: 200,
    })) as any;
  const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: INSTANCE_NAME });
  assert.equal(r.valid, true);
  assert.equal(r.tier, 'free');
});

test('validate rejects a paid plan without an annual expiration', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ plan_id: FREEMIUS_PRO_PLAN_ID, expiration: null }), {
      status: 200,
    })) as any;

  const r = await validate({
    licenseKey: 'K',
    instanceId: '555',
    instanceName: INSTANCE_NAME,
  });
  assert.deepEqual(r, { valid: false, tier: 'free', validUntil: null, status: 'invalid' });
});

test('validate with an invalid instance name enters grace without making a request', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as any;

  const r = await validate({ licenseKey: 'K', instanceId: '555', instanceName: 'not-a-uuid' });
  assert.deepEqual(r, { valid: false, tier: 'free', validUntil: null, status: 'error' });
  assert.equal(called, false);
});
