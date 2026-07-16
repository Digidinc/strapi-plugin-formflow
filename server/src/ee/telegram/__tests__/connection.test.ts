/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramConnectionService } from '../connection';
import { decryptSecret, encryptSecret } from '../crypto';

const key = Buffer.alloc(32, 7).toString('base64');
const token = '123456:super-secret-token';

function fixture(limit: number | 'unlimited' = 'unlimited') {
  let persisted: unknown = null;
  const store = {
    get: async () => persisted,
    set: async ({ value }: { value: unknown }) => { persisted = structuredClone(value); },
  };
  const calls: string[] = [];
  const service = createTelegramConnectionService({
    store, environment: { TELEGRAM_BOT: token }, encryptionKey: key,
    license: { limit: () => limit }, now: () => new Date('2026-07-17T00:00:00.000Z'),
    randomUUID: (() => { let id = 0; return () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    referenceCount: async (id) => id.endsWith('1') ? 2 : 0,
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ ok: true, result: { id: 42, first_name: 'FormFlow', username: 'formflow_bot' } }) } as any;
    },
  });
  return { service, calls, persisted: () => persisted };
}

test('encrypts with fresh AES-GCM nonces and rejects authenticated tampering', () => {
  const first = encryptSecret(token, key);
  const second = encryptSecret(token, key);
  assert.equal(first.version, 1);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(decryptSecret(first, key), token);
  const tampered = { ...first, ciphertext: Buffer.from('tampered').toString('base64') };
  assert.throws(() => decryptSecret(tampered, key), /could not be authenticated/i);
  assert.doesNotMatch(JSON.stringify(first), /super-secret-token/);
});

test('creates stable safe connections, enforces limits, and reports references', async () => {
  const { service, persisted } = fixture(1);
  const created = await service.createConnection({ name: 'Primary', credential: { type: 'stored', token } });
  assert.equal(created.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(created.referenceCount, 2);
  assert.equal(created.active, true);
  assert.equal(created.credentialConfigured, true);
  assert.deepEqual(created.tokenSource, { type: 'stored' });
  assert.doesNotMatch(JSON.stringify(created), /secret|123456/i);
  assert.doesNotMatch(JSON.stringify(persisted()), /super-secret-token/);
  await assert.rejects(
    service.createConnection({ name: 'Second', credential: { type: 'environment', variableName: 'TELEGRAM_BOT' } }),
    /connection limit/i
  );
});

test('preserves downgraded records and deterministically keeps the oldest active', async () => {
  const fx = fixture('unlimited');
  const first = await fx.service.createConnection({ name: 'First', credential: { type: 'environment', variableName: 'TELEGRAM_BOT' } });
  const second = await fx.service.createConnection({ name: 'Second', credential: { type: 'environment', variableName: 'TELEGRAM_BOT' } });
  const downgraded = createTelegramConnectionService({ ...fx.service.dependencies, license: { limit: () => 1 } });
  const listed = await downgraded.listConnections();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => [item.id, item.active]), [[first.id, true], [second.id, false]]);
});

test('validates environment names and availability without exposing resolved values', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.validateCredential({ type: 'environment', variableName: 'bad-name' }), /environment variable name/i);
  await assert.rejects(service.validateCredential({ type: 'environment', variableName: 'MISSING' }), /not configured/i);
  const metadata = await service.validateCredential({ type: 'environment', variableName: 'TELEGRAM_BOT' });
  assert.deepEqual(metadata, { id: '42', displayName: 'FormFlow', username: 'formflow_bot' });
  assert.ok(calls[0].includes(token));
  assert.doesNotMatch(JSON.stringify(metadata), /secret|123456/i);
});

test('requires an encryption key for storage but permits environment references', async () => {
  const fx = fixture();
  const service = createTelegramConnectionService({ ...fx.service.dependencies, encryptionKey: undefined });
  await assert.rejects(service.createConnection({ name: 'Stored', credential: { type: 'stored', token } }), /FORMFLOW_ENCRYPTION_KEY/);
  await service.createConnection({ name: 'Environment', credential: { type: 'environment', variableName: 'TELEGRAM_BOT' } });
});

test('uses explicit keep, replace, and environment actions and preserves ciphertext on failed rotation', async () => {
  const fx = fixture();
  const created = await fx.service.createConnection({ name: 'Original', credential: { type: 'stored', token } });
  const before = JSON.stringify(fx.persisted());
  await fx.service.updateConnection(created.id, { name: 'Renamed', credential: { type: 'keep' } });
  const kept = JSON.stringify(fx.persisted());
  assert.match(kept, /Renamed/);
  assert.equal(JSON.parse(kept).connections[0].tokenSource.secret.ciphertext, JSON.parse(before).connections[0].tokenSource.secret.ciphertext);

  fx.service.dependencies.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) }) as any;
  const staged = JSON.stringify(fx.persisted());
  await assert.rejects(fx.service.updateConnection(created.id, { credential: { type: 'replace', token: '999:failed-rotation-secret' } }), /credential validation failed/i);
  assert.equal(JSON.stringify(fx.persisted()), staged);
  assert.doesNotMatch(JSON.stringify(await fx.service.listConnections()), /failed-rotation|super-secret/);

  fx.service.dependencies.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 7, first_name: 'Env' } }) }) as any;
  const switched = await fx.service.updateConnection(created.id, { credential: { type: 'switch-to-environment', variableName: 'TELEGRAM_BOT' } });
  assert.deepEqual(switched.tokenSource, { type: 'environment', variableName: 'TELEGRAM_BOT' });
  assert.equal(await fx.service.resolveCredential(created.id), token);
});

test('deletes by stable ID and returns the reference count without credentials', async () => {
  const fx = fixture();
  const created = await fx.service.createConnection({ name: 'Delete', credential: { type: 'environment', variableName: 'TELEGRAM_BOT' } });
  const result = await fx.service.deleteConnection(created.id);
  assert.deepEqual(result, { id: created.id, referenceCount: 2 });
  assert.deepEqual(await fx.service.listConnections(), []);
});
