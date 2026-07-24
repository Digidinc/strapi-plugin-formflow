/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import submissionService, { type SubmittableForm } from '../../../services/submission';
import { createTelegramService } from '../index';

const form: SubmittableForm = {
  documentId: 'form-1', slug: 'contact', title: 'Contact', isActive: true,
  fields: [], updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { telegramNotification: { enabled: true, connectionId: 'connection-1' as any, destination: 'chat-1', template: { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] }] } } } },
};

const setup = (dispatch: () => void) => {
  let creates = 0;
  let emails = 0;
  let webhooks = 0;
  let integrations = 0;
  const submission = { documentId: 'submission-1', form: { documentId: 'form-1' }, data: {}, metadata: {}, status: 'new', createdAt: 'now', updatedAt: 'now' };
  const strapi: any = {
    log: { error() {}, warn() {}, info() {} }, config: { get: () => ({}) },
    documents: () => ({
      async create() { creates += 1; return submission; }, async update() { return submission; },
    }),
    plugin(name: string) { return { service(service: string) {
      if (name === 'upload') return { upload: async () => [] };
      if (service === 'form') return { findBySlug: async () => form, incrementSubmissionCount: async () => {} };
      if (service === 'validation') return { validate: () => ({ errors: {} }), validateFiles: () => ({ errors: {} }), sanitize: (_f: unknown, d: unknown) => d };
      if (service === 'license') return { can: (feature: string) => ['saveResume', 'webhooks', 'email.advanced', 'integrations'].includes(feature) };
      if (service === 'analytics') return { recordEvent() {} };
      if (service === 'telegram') return { dispatchForSubmission: dispatch };
      if (service === 'email') return { sendSubmissionNotification: async () => { emails += 1; } };
      if (service === 'webhook') return { triggerAll: async () => { webhooks += 1; } };
      if (service === 'integration') return { dispatch: () => { integrations += 1; } };
      throw new Error(`unexpected ${name}:${service}`);
    } }; },
  };
  return { service: submissionService({ strapi }), counts: () => ({ creates, emails, webhooks, integrations }) };
};

test('dispatches Telegram exactly once after final persistence and preserves public success', async () => {
  let dispatches = 0;
  let integrationRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { integrationRequests += 1; return { ok: true } as Response; }) as typeof fetch;
  (form.settings as any).integrations = [{ type: 'zapier', enabled: true, webhookUrl: 'https://example.com/zapier' }];
  const { service, counts } = setup(() => { dispatches += 1; throw new Error('telegram failed'); });
  const result = await service.submit('contact', {}, { ipAddress: '127.0.0.1', submittedAt: 'now' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(result.submission.documentId, 'submission-1');
  assert.equal(counts().creates, 1);
  assert.equal(dispatches, 1);
  assert.equal(integrationRequests, 1);
  delete (form.settings as any).integrations;
  globalThis.fetch = previousFetch;
});

test('does not dispatch Telegram from draft saves or status updates', async () => {
  let dispatches = 0;
  const { service } = setup(() => { dispatches += 1; });
  await service.savePartial('contact', {}, { ipAddress: '127.0.0.1', submittedAt: 'now' });
  await service.update('submission-1', { status: 'read' });
  assert.equal(dispatches, 0);
});

test('disabled Telegram settings do not prevent independent existing hooks', async () => {
  let dispatches = 0;
  const original = form.settings;
  form.settings = {
    telegramNotification: { ...(original!.telegramNotification as any), enabled: false },
    emailNotifications: [{ enabled: true, to: ['admin@example.com'] }],
    webhooks: [{ enabled: true, url: 'https://example.com/hook' }],
  };
  const { service, counts } = setup(() => { dispatches += 1; });
  await service.submit('contact', {}, { ipAddress: '127.0.0.1', submittedAt: 'now' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatches, 0);
  assert.equal(counts().emails, 1);
  assert.equal(counts().webhooks, 1);
  form.settings = original;
});

test('free-tier dispatch depends on active connection quantity, not paid integrations', async () => {
  let requests = 0;
  const stored = { version: 1, connections: ['active', 'inactive'].map((id) => ({
    id, name: id, token: `${id}-token`,
    bot: { id, displayName: id }, createdAt: 'now', updatedAt: 'now',
  })) };
  const service = createTelegramService({
    store: { get: async () => stored, set: async () => undefined },
    license: { limit: () => 1 },
    fetch: async () => { requests += 1; return { ok: true, status: 200, json: async () => ({ ok: true }), body: responseBody('{"ok":true}') } as any; },
    logger: { error() {} },
  });
  const dispatch = (connectionId: string) => service.dispatchForSubmission({
    fields: [], settings: { telegramNotification: { ...form.settings!.telegramNotification!, connectionId: connectionId as any, enabled: true } as any },
  }, { data: {} });
  dispatch('inactive');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 0);
  dispatch('active');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 1);
});

test('production dispatch remaps persisted field names to stable template field IDs', async () => {
  let requestBody: any;
  const stored = { version: 1, connections: [{
    id: 'connection-1', name: 'Bot', token: 'token',
    bot: { id: 'bot-1', displayName: 'Bot' }, createdAt: 'now', updatedAt: 'now',
  }] };
  const service = createTelegramService({
    store: { get: async () => stored, set: async () => undefined },
    license: { limit: () => 1 },
    fetch: async (_url, init) => {
      requestBody = JSON.parse((init as any).body);
      return { ok: true, status: 200, json: async () => ({ ok: true }), body: responseBody('{"ok":true}') } as any;
    },
    logger: { error() {} },
  });
  service.dispatchForSubmission({
    fields: [{ id: 'stable-email-id', name: 'email', type: 'email', label: 'Email' }],
    settings: { telegramNotification: {
      enabled: true, connectionId: 'connection-1' as any, destination: 'chat-1',
      template: { version: 1, document: { type: 'document', children: [{
        type: 'paragraph', children: [
          { type: 'text', text: 'Email: ' },
          { type: 'formField', fieldId: 'stable-email-id', fallback: '-' },
        ],
      }] } },
    } },
  }, { data: { email: 'actual@example.com' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(requestBody.rich_message.html, /actual@example\.com/);
  assert.doesNotMatch(requestBody.rich_message.html, /Email: -/);
});

const responseBody = (body: string) => ({ getReader() { let done = false; return {
  async read() { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(body) }; },
  async cancel() {},
}; } });
