/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import submissionService, { type SubmittableForm } from '../../../services/submission';

const form: SubmittableForm = {
  documentId: 'form-1', slug: 'contact', title: 'Contact', isActive: true,
  fields: [], updatedAt: '2026-01-01T00:00:00.000Z',
  settings: { telegram: { enabled: true, connectionId: 'connection-1' as any, destination: 'chat-1', template: { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] }] } } } },
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
      if (service === 'license') return { can: (feature: string) => ['saveResume', 'webhooks', 'email.advanced'].includes(feature) };
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
  const { service, counts } = setup(() => { dispatches += 1; throw new Error('telegram failed'); });
  const result = await service.submit('contact', {}, { ipAddress: '127.0.0.1', submittedAt: 'now' });
  assert.equal(result.submission.documentId, 'submission-1');
  assert.equal(counts().creates, 1);
  assert.equal(dispatches, 1);
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
    telegram: { ...(original!.telegram as any), enabled: false },
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
