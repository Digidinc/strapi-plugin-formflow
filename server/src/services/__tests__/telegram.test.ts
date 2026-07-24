import assert from 'node:assert/strict';
import test from 'node:test';

import telegramService, { countTelegramConnectionReferences, logTelegramLoadFailure } from '../telegram';

test('counts form settings that reference a stable Telegram connection ID', async () => {
  const seen: unknown[] = [];
  const strapi = { documents: (uid: string) => {
    assert.equal(uid, 'plugin::formflow.form');
    return { findMany: async (query: unknown) => {
      seen.push(query);
      return [
        { settings: { telegramNotification: { connectionId: 'wanted' } } },
        { settings: { telegramNotification: { connectionId: 'other' } } },
        { settings: { telegramNotification: { connectionId: 'wanted' } } },
      ];
    } };
  } } as any;
  assert.equal(await countTelegramConnectionReferences(strapi, 'wanted'), 2);
  assert.deepEqual(seen, [{ fields: ['settings'], status: 'draft', limit: -1 }]);
});

test('production wrapper wires the Strapi-backed reference counter into safe results', async () => {
  const stored = { version: 1, connections: [{
    id: 'stable-id', name: 'Bot', token: 'bot-token',
    bot: { id: '1', displayName: 'Bot' }, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }] };
  const strapi = {
    plugin: () => ({ service: () => ({ limit: () => 1 }) }),
    store: () => ({ get: async () => stored, set: async () => undefined }),
    config: { get: () => undefined },
    documents: () => ({ findMany: async () => [{ settings: { telegramNotification: { connectionId: 'stable-id' } } }] }),
  } as any;
  const service = telegramService({ strapi });
  const listed = await service.listConnections() as Array<{ referenceCount: number }>;
  assert.equal(listed[0].referenceCount, 1);
});

test('MIT boundary contains asynchronous EE dispatch rejection and returns immediately', async () => {
  const errors: unknown[][] = [];
  const strapi = {
    plugin: () => ({ service: () => ({ limit: () => 1 }) }),
    store: () => ({ get: async () => { throw new Error('SECRET store failure'); }, set: async () => undefined }),
    config: { get: () => undefined }, documents: () => ({ findMany: async () => [] }),
    log: { error: (...args: unknown[]) => errors.push(args) },
  } as any;
  const service = telegramService({ strapi });
  assert.equal(service.dispatchForSubmission({ settings: { telegramNotification: { enabled: true } } }, {}), undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(errors.length > 0);
  assert.doesNotMatch(JSON.stringify(errors), /SECRET|store failure/);
});

test('EE load failures emit only a fixed sanitized initialization diagnostic', () => {
  const errors: unknown[][] = [];
  logTelegramLoadFailure({ error: (...args: unknown[]) => errors.push(args) } as any,
    new Error('SECRET_TOKEN /private/plugin/path raw module cause'));
  assert.deepEqual(errors, [['Telegram integration failed to initialize.']]);
  assert.doesNotMatch(JSON.stringify(errors), /SECRET_TOKEN|private|plugin\/path|raw module cause/i);
});
