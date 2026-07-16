import assert from 'node:assert/strict';
import test from 'node:test';

import telegramService, { countTelegramConnectionReferences } from '../telegram';

test('counts form settings that reference a stable Telegram connection ID', async () => {
  const seen: unknown[] = [];
  const strapi = { documents: (uid: string) => {
    assert.equal(uid, 'plugin::formflow.form');
    return { findMany: async (query: unknown) => {
      seen.push(query);
      return [
        { settings: { telegram: { connectionId: 'wanted' } } },
        { settings: { telegram: { connectionId: 'other' } } },
        { settings: { telegram: { connectionId: 'wanted' } } },
      ];
    } };
  } } as any;
  assert.equal(await countTelegramConnectionReferences(strapi, 'wanted'), 2);
  assert.deepEqual(seen, [{ fields: ['settings'], status: 'draft', limit: -1 }]);
});

test('production wrapper wires the Strapi-backed reference counter into safe results', async () => {
  const stored = { version: 1, connections: [{
    id: 'stable-id', name: 'Bot', tokenSource: { type: 'environment', variableName: 'BOT_TOKEN' },
    bot: { id: '1', displayName: 'Bot' }, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }] };
  const strapi = {
    plugin: () => ({ service: () => ({ limit: () => 1 }) }),
    store: () => ({ get: async () => stored, set: async () => undefined }),
    config: { get: () => undefined },
    documents: () => ({ findMany: async () => [{ settings: { telegram: { connectionId: 'stable-id' } } }] }),
  } as any;
  const service = telegramService({ strapi });
  const listed = await service.listConnections() as Array<{ referenceCount: number }>;
  assert.equal(listed[0].referenceCount, 1);
});

test('MIT boundary contains asynchronous EE dispatch rejection and returns immediately', async () => {
  const errors: unknown[][] = [];
  const strapi = {
    plugin: () => ({ service: () => ({ limit: () => 1, can: () => true }) }),
    store: () => ({ get: async () => { throw new Error('SECRET store failure'); }, set: async () => undefined }),
    config: { get: () => undefined }, documents: () => ({ findMany: async () => [] }),
    log: { error: (...args: unknown[]) => errors.push(args) },
  } as any;
  const service = telegramService({ strapi });
  assert.equal(service.dispatchForSubmission({ settings: { telegram: { enabled: true } } }, {}), undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(errors.length > 0);
  assert.doesNotMatch(JSON.stringify(errors), /SECRET|store failure/);
});
