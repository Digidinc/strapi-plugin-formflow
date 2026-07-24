/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramConnectionService } from '../connection';

const token = '123456:super-secret-token';

function fixture(limit: number | 'unlimited' = 'unlimited') {
  let persisted: unknown = null;
  const store = {
    get: async () => persisted,
    set: async ({ value }: { value: unknown }) => { persisted = structuredClone(value); },
  };
  const calls: string[] = [];
  const service = createTelegramConnectionService({
    store,
    license: { limit: () => limit },
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    randomUUID: (() => {
      let id = 0;
      return () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
    })(),
    referenceCount: async (id) => id.endsWith('1') ? 2 : 0,
    fetch: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { id: 42, first_name: 'FormFlow', username: 'formflow_bot' },
        }),
      } as any;
    },
  });
  return { service, calls, persisted: () => persisted };
}

test('stores and resolves distinct connection tokens without exposing them in safe responses', async () => {
  const fx = fixture('unlimited');
  const firstToken = '111111:first-plaintext-token';
  const secondToken = '222222:second-plaintext-token';
  const first = await fx.service.createConnection({
    name: 'First',
    credential: { type: 'stored', token: firstToken },
  });
  const second = await fx.service.createConnection({
    name: 'Second',
    credential: { type: 'stored', token: secondToken },
  });

  assert.equal(await fx.service.resolveCredential(first.id), firstToken);
  assert.equal(await fx.service.resolveCredential(second.id), secondToken);
  assert.match(JSON.stringify(fx.persisted()), /first-plaintext-token/);
  assert.match(JSON.stringify(fx.persisted()), /second-plaintext-token/);
  assert.doesNotMatch(JSON.stringify({ first, second, listed: await fx.service.listConnections() }), /plaintext-token/);
});

test('creates stable safe connections, enforces limits, and reports references', async () => {
  const { service } = fixture(1);
  const created = await service.createConnection({
    name: 'Primary',
    credential: { type: 'stored', token },
  });
  assert.equal(created.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(created.referenceCount, 2);
  assert.equal(created.active, true);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'tokenSource'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'credentialConfigured'), false);
  assert.doesNotMatch(JSON.stringify(created), /super-secret-token/);
  await assert.rejects(
    service.createConnection({
      name: 'Second',
      credential: { type: 'stored', token: '222222:second-token' },
    }),
    /connection limit/i
  );
});

test('preserves downgraded records and deterministically keeps the oldest active', async () => {
  const fx = fixture('unlimited');
  const first = await fx.service.createConnection({
    name: 'First',
    credential: { type: 'stored', token: '111111:first-token' },
  });
  const second = await fx.service.createConnection({
    name: 'Second',
    credential: { type: 'stored', token: '222222:second-token' },
  });
  const downgraded = createTelegramConnectionService({
    ...fx.service.dependencies,
    license: { limit: () => 1 },
  });
  const listed = await downgraded.listConnections();
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((item) => [item.id, item.active]),
    [[first.id, true], [second.id, false]]
  );
});

test('validates stored tokens without exposing resolved values', async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.validateCredential({ type: 'stored', token: '' }),
    /credential validation failed/i
  );
  const metadata = await service.validateCredential({ type: 'stored', token });
  assert.deepEqual(metadata, {
    id: '42',
    displayName: 'FormFlow',
    username: 'formflow_bot',
  });
  assert.ok(calls[0].includes(token));
  assert.doesNotMatch(JSON.stringify(metadata), /secret|123456/i);
});

test('fails closed on malformed plugin-store data without overwriting it', async () => {
  let setCalls = 0;
  const corrupt = { version: 1, connections: 'not-an-array' };
  const service = createTelegramConnectionService({
    ...fixture().service.dependencies,
    store: {
      get: async () => corrupt,
      set: async () => { setCalls += 1; },
    },
  });
  await assert.rejects(
    service.listConnections(),
    /stored Telegram connection data is invalid/i
  );
  await assert.rejects(
    service.createConnection({
      name: 'Must not overwrite',
      credential: { type: 'stored', token },
    }),
    /stored Telegram connection data is invalid/i
  );
  assert.equal(setCalls, 0);
});

test('rejects malformed records and unreleased encrypted record shapes without overwriting the store', async () => {
  const valid = {
    id: 'stable',
    name: 'Bot',
    token,
    bot: { id: '42', displayName: 'Bot' },
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
  const malformed = [
    {},
    { ...valid, token: '' },
    { ...valid, token: undefined, tokenSource: { type: 'stored', secret: { ciphertext: 'legacy' } } },
    { ...valid, bot: { ...valid.bot, username: 123 } },
  ];

  for (const record of malformed) {
    let setCalls = 0;
    const service = createTelegramConnectionService({
      ...fixture().service.dependencies,
      store: {
        get: async () => ({ version: 1, connections: [record] }),
        set: async () => { setCalls += 1; },
      },
    });
    await assert.rejects(
      service.listConnections(),
      /stored Telegram connection data is invalid/i
    );
    await assert.rejects(
      service.deleteConnection('stable'),
      /stored Telegram connection data is invalid/i
    );
    assert.equal(setCalls, 0);
  }
});

test('uses explicit keep and replace actions without changing a token after failed validation', async () => {
  const fx = fixture();
  const created = await fx.service.createConnection({
    name: 'Original',
    credential: { type: 'stored', token },
  });
  const before = JSON.stringify(fx.persisted());

  await fx.service.updateConnection(created.id, {
    name: 'Renamed',
    credential: { type: 'keep' },
  });
  const kept = JSON.stringify(fx.persisted());
  assert.match(kept, /Renamed/);
  assert.equal(
    JSON.parse(kept).connections[0].token,
    JSON.parse(before).connections[0].token
  );

  fx.service.dependencies.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: false }),
  }) as any;
  const staged = JSON.stringify(fx.persisted());
  await assert.rejects(
    fx.service.updateConnection(created.id, {
      credential: { type: 'replace', token: '999:failed-rotation-secret' },
    }),
    /credential validation failed/i
  );
  assert.equal(JSON.stringify(fx.persisted()), staged);
  assert.doesNotMatch(
    JSON.stringify(await fx.service.listConnections()),
    /failed-rotation|super-secret/
  );
});

test('deletes by stable ID and returns the reference count without credentials', async () => {
  const fx = fixture();
  const created = await fx.service.createConnection({
    name: 'Delete',
    credential: { type: 'stored', token },
  });
  const result = await fx.service.deleteConnection(created.id);
  assert.deepEqual(result, { id: created.id, referenceCount: 2 });
  assert.deepEqual(await fx.service.listConnections(), []);
});
