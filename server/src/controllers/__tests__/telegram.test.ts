import assert from 'node:assert/strict';
import test from 'node:test';

import adminRoutes from '../../routes/admin';
import publicRoutes from '../../routes/content-api';
import { RBAC_ACTIONS } from '../../register';
import telegramController from '../telegram';
import formService, { validateTelegramFormSettings } from '../../services/form';

const routes = adminRoutes.routes as Array<any>;

test('Telegram admin routes use explicit settings and form-update RBAC actions', () => {
  const expected: Record<string, string> = {
    'GET /settings/telegram/connections': 'plugin::formflow.settings.read',
    'POST /settings/telegram/connections': 'plugin::formflow.settings.update',
    'PATCH /settings/telegram/connections/:id': 'plugin::formflow.settings.update',
    'DELETE /settings/telegram/connections/:id': 'plugin::formflow.settings.update',
    'POST /settings/telegram/connections/validate': 'plugin::formflow.settings.update',
    'POST /forms/:formId/telegram/test': 'plugin::formflow.form.update',
  };
  for (const [key, action] of Object.entries(expected)) {
    const [method, path] = key.split(' ');
    const route = routes.find((item) => item.method === method && item.path === path);
    assert.ok(route, `missing ${key}`);
    assert.deepEqual(route.config.policies, ['admin::isAuthenticatedAdmin', {
      name: 'admin::hasPermissions', config: { actions: [action] },
    }]);
  }
  assert.ok(RBAC_ACTIONS.some((item) => item.uid === 'settings.read'));
  assert.ok(RBAC_ACTIONS.some((item) => item.uid === 'settings.update'));
});

test('public routes expose no Telegram API', () => {
  assert.equal(JSON.stringify(publicRoutes).includes('telegram'), false);
});

const context = (body: unknown = {}, params: Record<string, string> = {}) => ({
  request: { body }, params, status: 200,
  throw(status: number, error: unknown): never { throw Object.assign(error as object, { status }); },
  notFound(message: string) { this.status = 404; return { error: { message } }; },
});

test('unentitled connection mutation returns standard 402 without invoking service', async () => {
  let called = false;
  const controller = telegramController({ strapi: { plugin: () => ({ service: (name: string) =>
    name === 'license' ? { can: () => false, resolution: () => 'resolved' } : { createConnection: () => { called = true; } },
  }), log: { error() {} } } as any });
  const ctx = context({ name: 'Bot', credential: { type: 'environment', variableName: 'BOT_TOKEN' } });
  const result = await controller.create(ctx as any);
  assert.equal(ctx.status, 402);
  assert.equal((result as any).error.status, 402);
  assert.equal((result as any).error.name, 'PaymentRequired');
  assert.equal((result as any).error.details.feature, 'integrations');
  assert.equal(called, false);
});

test('controller rejects unknown properties before calling connection service', async () => {
  let called = false;
  const controller = telegramController({ strapi: { plugin: () => ({ service: (name: string) =>
    name === 'license' ? { can: () => true } : { createConnection: () => { called = true; } },
  }), log: { error() {} } } as any });
  const ctx = context({ name: 'Bot', credential: { type: 'environment', variableName: 'BOT_TOKEN' }, token: 'leak' });
  const result = await controller.create(ctx as any);
  assert.equal(ctx.status, 400);
  assert.equal((result as any).error.name, 'ValidationError');
  assert.equal(called, false);
});

test('form Telegram validation rejects stale connections and permits disabling preserved config', async () => {
  const strapi = { plugin: () => ({ service: (name: string) => name === 'license'
    ? { can: () => true, resolution: () => 'resolved' }
    : { listConnections: async () => [{ id: 'known', active: true }] } }) } as any;
  const template = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hi' }] }] } };
  const invalid = await validateTelegramFormSettings(strapi, [], { telegram: {
    enabled: true, connectionId: 'missing', destination: '@channel', template,
  } });
  assert.equal(invalid?.status, 400);
  assert.match(invalid?.message ?? '', /connection/i);
  const disabled = await validateTelegramFormSettings(strapi, [], { telegram: {
    enabled: false, connectionId: 'missing', destination: 'bad destination', template: { broken: true },
  } });
  assert.equal(disabled, null);
});

test('updating fields revalidates an already-enabled saved Telegram template', async () => {
  let updated = false;
  const template = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'old', fallback: '-' }] }] } };
  const strapi = {
    documents: () => ({
      findOne: async () => ({ fields: [{ id: 'old', type: 'text', name: 'old', label: 'Old' }], settings: { telegram: { enabled: true, connectionId: 'known', destination: '@channel', template } } }),
      update: async () => { updated = true; },
    }),
    plugin: () => ({ service: (name: string) => name === 'license' ? { can: () => true } : { listConnections: async () => [{ id: 'known', active: true }] } }),
  } as any;
  await assert.rejects(() => formService({ strapi }).update('form', { fields: [{ id: 'new', type: 'text', name: 'new', label: 'New' }] as any }), /template is invalid/i);
  assert.equal(updated, false);
});

test('disabling with only enabled false preserves saved Telegram configuration', async () => {
  let saved: any;
  const telegram = { enabled: true, connectionId: 'known', destination: '@channel', template: { version: 1 } };
  const strapi = {
    documents: () => ({
      findOne: async () => ({ fields: [], settings: { submitButtonText: 'Send', telegram } }),
      update: async (input: any) => { saved = input.data; return input.data; },
    }),
    plugin: () => ({ service: () => ({}) }),
  } as any;
  await formService({ strapi }).update('form', { settings: { telegram: { enabled: false } as any } });
  assert.deepEqual(saved.settings.telegram, { ...telegram, enabled: false });
  assert.equal(saved.settings.submitButtonText, 'Send');
});

test('test message renders safe samples by stable field ID', async () => {
  let sent: any;
  const controller = telegramController({ strapi: { plugin: () => ({ service: (name: string) => ({
    license: { can: () => true },
    form: { findOne: async () => ({ fields: [{ id: 'stable-id', name: 'email', type: 'email', label: 'Email' }] }) },
    telegram: { listConnections: async () => [{ id: 'known', active: true }], sendRichNotification: async (input: any) => { sent = input; return { ok: true }; } },
  } as any)[name] }), log: { error() {} } } as any });
  const template = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'stable-id', fallback: '-' }] }] } };
  const result = await controller.test(context({ connectionId: 'known', destination: '@channel', template }, { formId: 'form' }) as any);
  assert.equal((result as any).data.success, true);
  assert.match(sent.html, /person@example\.com/);
  assert.notEqual(sent.html.trim(), '-');
});

for (const [stage, failingService] of [
  ['form lookup', 'form'], ['connection storage', 'telegram-list'], ['delivery', 'telegram-send'],
] as const) {
  test(`test endpoint sanitizes ${stage} failures`, async () => {
    const secret = '123456:RAW_BOT_TOKEN private submission data';
    const controller = telegramController({ strapi: { plugin: () => ({ service: (name: string) => ({
      license: { can: () => true },
      form: { findOne: async () => { if (failingService === 'form') throw new Error(secret); return { fields: [] }; } },
      telegram: {
        listConnections: async () => { if (failingService === 'telegram-list') throw new Error(secret); return [{ id: 'known', active: true }]; },
        sendRichNotification: async () => { if (failingService === 'telegram-send') throw new Error(secret); return { ok: true }; },
      },
    } as any)[name] }), log: { error() {} } } as any });
    const template = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Test' }] }] } };
    const ctx = context({ connectionId: 'known', destination: '@channel', template }, { formId: 'form' });
    const result = await controller.test(ctx as any);
    assert.equal(ctx.status, 500);
    assert.equal((result as any).error.name, 'ApplicationError');
    assert.doesNotMatch(JSON.stringify(result), /RAW_BOT_TOKEN|submission data|123456/);
  });
}

test('test endpoint sanitizes unexpected render failures', async () => {
  const field = { type: 'text', label: 'Secret field', get id(): string { throw new Error('RAW_RENDER_DATA'); } };
  const controller = telegramController({ strapi: { plugin: () => ({ service: (name: string) => ({
    license: { can: () => true }, form: { findOne: async () => ({ fields: [field] }) },
    telegram: { listConnections: async () => [{ id: 'known', active: true }] },
  } as any)[name] }), log: { error() {} } } as any });
  const template = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Test' }] }] } };
  const ctx = context({ connectionId: 'known', destination: '@channel', template }, { formId: 'form' });
  const result = await controller.test(ctx as any);
  assert.equal(ctx.status, 500);
  assert.equal((result as any).error.name, 'ApplicationError');
  assert.doesNotMatch(JSON.stringify(result), /RAW_RENDER_DATA|Secret field/);
});
