/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramDeliveryService } from '../delivery';

const response = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  body: {
    getReader() {
      let done = false;
      return { async read() { if (done) return { done: true, value: undefined }; done = true; return { done: false, value: new TextEncoder().encode(body) }; }, async cancel() {} };
    },
  },
});

const make = (fetchImpl: any, sendRichMessage?: any, timeoutMs = 10_000) => {
  const logs: unknown[][] = [];
  return {
    logs,
    service: createTelegramDeliveryService({
      resolveCredential: async () => 'SECRET_TOKEN',
      fetch: fetchImpl,
      sendRichMessage,
      logger: { error: (...args: unknown[]) => logs.push(args) },
      timeoutMs,
    }),
  };
};

test('sends the bounded rich-message request and returns success', async () => {
  let call: any;
  const { service } = make(async (...args: any[]) => { call = args; return response(200, '{"ok":true,"result":{"message_id":42}}'); });
  assert.deepEqual(await service.sendRichNotification({ connectionId: 'c1', destination: 'chat', html: '<b>Hi</b>' }), { ok: true, messageId: 42 });
  assert.match(call[0], /^https:\/\/api\.telegram\.org\/botSECRET_TOKEN\/sendRichMessage$/);
  assert.deepEqual(JSON.parse(call[1].body), { chat_id: 'chat', message: { html: '<b>Hi</b>' } });
  assert.equal(call[1].method, 'POST');
});

test('classifies Telegram errors and exposes only safe retry metadata', async () => {
  const cases: Array<[number, object, string, number?]> = [
    [401, { error_code: 401, description: 'Unauthorized SECRET_TOKEN' }, 'authentication'],
    [400, { error_code: 400, description: 'Bad Request: chat not found' }, 'destination'],
    [403, { error_code: 403, description: 'Forbidden: bot cannot post messages' }, 'permission'],
    [429, { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } }, 'rate_limit', 17],
    [503, { error_code: 503, description: 'upstream' }, 'telegram_server'],
  ];
  for (const [status, body, failure, retryAfter] of cases) {
    const { service, logs } = make(async () => response(status, JSON.stringify(body)));
    const result = await service.sendRichNotification({ connectionId: 'c1', destination: 'chat', html: 'Hi' });
    assert.deepEqual(result, { ok: false, failure, errorCode: status, ...(retryAfter ? { retryAfter } : {}) });
    assert.doesNotMatch(JSON.stringify(logs), /SECRET_TOKEN|chat not found|cannot post|api\.telegram\.org/i);
  }
});

test('classifies malformed and oversized responses without retaining raw bodies', async () => {
  for (const body of ['not-json SECRET_TOKEN', `{"ok":false,"description":"${'x'.repeat(70_000)}"}`]) {
    const { service, logs } = make(async () => response(400, body));
    assert.deepEqual(await service.sendRichNotification({ connectionId: 'c', destination: 'd', html: 'h' }), { ok: false, failure: 'unknown', errorCode: 400 });
    assert.doesNotMatch(JSON.stringify(logs), /SECRET_TOKEN|xxxx/);
  }
});

test('classifies timeout and network failures and does not retry', async () => {
  let calls = 0;
  const timed = make((_url: string, init: any) => new Promise((_resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted SECRET_TOKEN'), { name: 'AbortError' })));
  }), undefined, 5);
  assert.deepEqual(await timed.service.sendRichNotification({ connectionId: 'c', destination: 'd', html: 'h' }), { ok: false, failure: 'timeout' });
  assert.equal(calls, 1);
  const network = make(async () => { calls += 1; throw new Error('network SECRET_TOKEN'); });
  assert.deepEqual(await network.service.sendRichNotification({ connectionId: 'c', destination: 'd', html: 'h' }), { ok: false, failure: 'network' });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify([...timed.logs, ...network.logs]), /SECRET_TOKEN/);
});

test('classifies a production Bot API unsupported-method response as configuration', async () => {
  const { service } = make(async () => response(404, JSON.stringify({
    ok: false, error_code: 404, description: 'Not Found: method sendRichMessage not found',
  })));
  assert.deepEqual(await service.sendRichNotification({ connectionId: 'c', destination: 'd', html: 'h' }), { ok: false, failure: 'configuration', errorCode: 404 });
});

test('classifies credential resolution failures as configuration without leaking details', async () => {
  const logs: unknown[][] = [];
  const service = createTelegramDeliveryService({
    resolveCredential: async () => { throw new Error('BOT_TOKEN missing SECRET_TOKEN'); },
    fetch: async () => response(200, '{}'),
    logger: { error: (...args: unknown[]) => logs.push(args) },
  });
  assert.deepEqual(await service.sendRichNotification({ connectionId: 'missing', destination: 'd', html: 'h' }), { ok: false, failure: 'configuration' });
  assert.doesNotMatch(JSON.stringify(logs), /BOT_TOKEN|SECRET_TOKEN|missing/);
});

test('bounds credential resolution within the operation timeout', async () => {
  const service = createTelegramDeliveryService({
    resolveCredential: async () => new Promise<string>(() => {}),
    fetch: async () => response(200, '{}'),
    logger: { error() {} }, timeoutMs: 5,
  });
  const result = await Promise.race([
    service.sendRichNotification({ connectionId: 'c', destination: 'd', html: 'h' }),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
  assert.deepEqual(result, { ok: false, failure: 'timeout' });
});
