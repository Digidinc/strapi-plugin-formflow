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
