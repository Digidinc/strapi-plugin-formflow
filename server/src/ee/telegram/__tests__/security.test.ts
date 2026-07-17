/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import formService from '../../../services/form';
import { createTelegramConnectionService } from '../connection';
import { createTelegramDeliveryService } from '../delivery';
import { renderTelegramTemplate } from '../template';

const body = (value: unknown) => ({ getReader() { let done = false; return {
  async read() { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(JSON.stringify(value)) }; },
  async cancel() {},
}; } });

test('credentials never appear in connection responses, errors, or logs', async () => {
  const token = 'test-token-value';
  const stored: any = { version: 1, connections: [] };
  const service = createTelegramConnectionService({
    store: { get: async () => stored, set: async ({ value }) => Object.assign(stored, value) },
    environment: {}, encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    license: { limit: () => 1 }, randomUUID: () => 'connection-id',
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 7, first_name: 'Notifier' } }) }),
  });
  const created = await service.createConnection({ name: 'Notifications', credential: { type: 'stored', token } });
  const snapshot = JSON.stringify({ created, listed: await service.listConnections() });
  assert.doesNotMatch(snapshot, new RegExp(token));
  assert.equal((created.tokenSource as any).token, undefined);

  await assert.rejects(
    createTelegramConnectionService({ ...service.dependencies, fetch: async () => { throw new Error(token); } })
      .validateCredential({ type: 'stored', token }),
    (error: Error) => !error.message.includes(token)
  );
});

test('public schema excludes the complete Telegram configuration', async () => {
  const telegramNotification = { enabled: true, connectionId: 'connection-id', destination: '-100123456', template: { secret: 'server-only' } };
  const service = formService({ strapi: {
    plugin: () => ({ service: () => ({ recordEvent() {} }) }),
  } as any });
  service.findBySlug = async () => ({ documentId: 'form-id', isActive: true, title: 'Form', slug: 'form', fields: [], settings: { telegramNotification } }) as any;
  const schema = await service.getPublicSchema('form');
  assert.equal(JSON.stringify(schema).includes('telegram'), false);
  assert.equal(JSON.stringify(schema).includes('connection-id'), false);
  assert.equal(JSON.stringify(schema).includes('-100123456'), false);
});

test('malicious AST and destination data cannot alter the Bot API URL or method', async () => {
  const malicious = { version: 1, document: { type: 'document', children: [{
    type: 'paragraph', children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: 'x' }] }],
  }] } } as any;
  assert.equal(renderTelegramTemplate(malicious, [], {}).valid, false);

  const calls: any[] = [];
  const delivery = createTelegramDeliveryService({
    resolveCredential: async () => 'fixed-token', logger: { error() {} },
    fetch: async (...args: any[]) => { calls.push(args); return { ok: true, status: 200, body: body({ ok: true }) } as any; },
  });
  const destination = 'chat-id/../../setWebhook?url=https://attacker.invalid';
  await delivery.sendRichNotification({ connectionId: 'connection-id', destination, html: '<b>safe</b>' });
  assert.equal(calls[0][0], 'https://api.telegram.org/botfixed-token/sendRichMessage');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(JSON.parse(calls[0][1].body).chat_id, destination);
});

test('deleting a form leaves global Telegram connections intact', async () => {
  let globalConnectionWrites = 0;
  const deleted: string[] = [];
  const service = formService({ strapi: {
    store: () => ({ set: async () => { globalConnectionWrites += 1; } }),
    documents: (uid: string) => uid.endsWith('submission') ? {
      findMany: async () => [{ documentId: 'submission-id' }], delete: async ({ documentId }: any) => { deleted.push(documentId); },
    } : { delete: async ({ documentId }: any) => { deleted.push(documentId); return { documentId }; } },
  } as any });
  await service.delete('form-id');
  assert.deepEqual(deleted, ['submission-id', 'form-id']);
  assert.equal(globalConnectionWrites, 0);
});

test('a shared bot receives only one outbound rich-message call', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const service = createTelegramDeliveryService({
    resolveCredential: async () => 'fixed-token', logger: { error() {} },
    fetch: async (url, init) => { calls.push({ url, method: init.method }); return { ok: true, status: 200, body: body({ ok: true }) }; },
  });
  await service.sendRichNotification({ connectionId: 'connection-id', destination: '@channelname', html: 'Test' });
  assert.deepEqual(calls, [{ url: 'https://api.telegram.org/botfixed-token/sendRichMessage', method: 'POST' }]);
  assert.doesNotMatch(JSON.stringify(calls), /getUpdates|setWebhook|deleteWebhook|setMyCommands|setChat|setMyName/i);
});
