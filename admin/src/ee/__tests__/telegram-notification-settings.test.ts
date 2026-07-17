import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { buildTelegramTestPayload, createDefaultTelegramDocument, telegramNotificationState } from '../telegram/template-document';

const template = createDefaultTelegramDocument([]);
const settings = { enabled: true, connectionId: 'connection-1', destination: '@alerts', template };

test('test payload uses current unsaved configuration without wrapper or saved values', () => {
  assert.deepEqual(buildTelegramTestPayload(settings), { connectionId: 'connection-1', destination: '@alerts', template });
});

test('missing, inactive, and credential-less connections block sending while preserving configuration', () => {
  assert.equal(telegramNotificationState(settings, []).state, 'missing');
  assert.equal(telegramNotificationState(settings, [{ id: 'connection-1', active: false, credentialConfigured: true }]).state, 'inactive');
  assert.equal(telegramNotificationState(settings, [{ id: 'connection-1', active: true, credentialConfigured: false }]).state, 'disconnected');
  assert.deepEqual({ ...settings, enabled: false }, { enabled: false, connectionId: 'connection-1', destination: '@alerts', template });
});

test('form edit notifications tab round-trips one telegram object alongside existing settings', () => {
  const source = readFileSync('admin/src/pages/FormEditPage.tsx', 'utf8');
  assert.match(source, /TelegramNotificationSettings/);
  assert.match(source, /telegramNotification/);
  assert.match(source, /\.\.\.formData\.settings, telegramNotification/);
});

test('editor source uses the focused Lexical plugins and never persists private JSON or raw HTML', () => {
  const source = readFileSync('admin/src/ee/components/TelegramTemplateEditor.tsx', 'utf8');
  for (const plugin of ['LexicalComposer', 'RichTextPlugin', 'HistoryPlugin', 'ListPlugin', 'LinkPlugin']) assert.match(source, new RegExp(plugin));
  assert.doesNotMatch(source, /editorState\.toJSON\(\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
