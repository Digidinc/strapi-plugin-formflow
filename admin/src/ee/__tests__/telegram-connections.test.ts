import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  API,
  buildTelegramCreateRequest,
  buildTelegramUpdateRequest,
  connectionAvailability,
  connectionLimitMessage,
  deletionReferenceWarning,
  resetTelegramCredentialDraft,
  telegramConnectionMutationPolicy,
  telegramValidationMatches,
  telegramDraftCanSave,
} from '../../utils/api';

test('builds keep, replace, and switch update payloads without ambiguity', () => {
  assert.deepEqual(buildTelegramUpdateRequest('Primary', { mode: 'keep' }), {
    name: 'Primary', credential: { type: 'keep' },
  });
  assert.deepEqual(buildTelegramUpdateRequest('Primary', { mode: 'replace', token: '123:secret' }), {
    name: 'Primary', credential: { type: 'replace', token: '123:secret' },
  });
  assert.deepEqual(buildTelegramUpdateRequest('Primary', { mode: 'environment', variableName: 'TELEGRAM_TOKEN' }), {
    name: 'Primary', credential: { type: 'switch-to-environment', variableName: 'TELEGRAM_TOKEN' },
  });
});

test('enables save only for reviewed metadata matching the unchanged draft', () => {
  const bot = { id: '1', displayName: 'Alerts' };
  assert.equal(telegramValidationMatches('name|stored|secret|', 'name|stored|secret|', bot), true);
  assert.equal(telegramValidationMatches('name|stored|secret|', 'renamed|stored|secret|', bot), false);
  assert.equal(telegramValidationMatches('name|stored|secret|', 'name|environment||BOT_TOKEN', bot), false);
  assert.equal(telegramValidationMatches('name|stored|secret|', 'name|stored|secret|', null), false);
});

test('keeps rename and mode round-trip saveable with an explicit keep payload', () => {
  const existingBot = { id: '1', displayName: 'Alerts' };
  assert.equal(telegramDraftCanSave('keep', null, 'Renamed|keep||', null, existingBot), true);
  assert.equal(telegramDraftCanSave('replace', null, 'Renamed|replace|new|', null, existingBot), false);
  // Returning from replace to keep uses safe existing metadata, never a token.
  assert.equal(telegramDraftCanSave('keep', null, 'Renamed|keep||', null, existingBot), true);
  assert.deepEqual(buildTelegramUpdateRequest('Renamed', { mode: 'keep' }), {
    name: 'Renamed', credential: { type: 'keep' },
  });
});

test('keeps inactive excess connections deletable for recovery but not editable', () => {
  assert.deepEqual(telegramConnectionMutationPolicy(false, true), { canEdit: false, canDelete: true });
  assert.deepEqual(telegramConnectionMutationPolicy(true, true), { canEdit: true, canDelete: true });
  assert.deepEqual(telegramConnectionMutationPolicy(false, false), { canEdit: false, canDelete: false });
});

test('settings route is outside the form-read guard while ordinary routes remain protected', () => {
  const source = readFileSync('admin/src/pages/App.tsx', 'utf8');
  assert.match(source, /<LicenseProvider>[\s\S]*path="settings"[\s\S]*permissions=\{PERMISSIONS\.settings\.read\}/);
  assert.match(source, /path="\*"[\s\S]*permissions=\{PERMISSIONS\.main\}[\s\S]*<MainRoutes/);
  assert.doesNotMatch(source, /<Page\.Protect permissions=\{PERMISSIONS\.main\}>\s*<LicenseProvider>/);
});

test('builds token-bearing create requests separately from safe responses', () => {
  assert.deepEqual(buildTelegramCreateRequest('Alerts', { mode: 'stored', token: '123:secret' }), {
    name: 'Alerts', credential: { type: 'stored', token: '123:secret' },
  });
  assert.deepEqual(buildTelegramCreateRequest('Alerts', { mode: 'environment', variableName: 'BOT_TOKEN' }), {
    name: 'Alerts', credential: { type: 'environment', variableName: 'BOT_TOKEN' },
  });
});

test('clears secret-bearing draft state after validation or persistence', () => {
  const reset = resetTelegramCredentialDraft();
  assert.deepEqual(reset, { mode: 'keep', token: '', variableName: '' });
  assert.equal(JSON.stringify(reset).includes('123:secret'), false);
});

test('describes finite and unlimited license capacity', () => {
  assert.equal(connectionLimitMessage(1, 1), 'Connection limit reached (1 of 1).');
  assert.equal(connectionLimitMessage(2, 3), '2 of 3 connections used.');
  assert.equal(connectionLimitMessage(12, 'unlimited'), '12 connections configured.');
});

test('warns before deleting referenced connections', () => {
  assert.equal(deletionReferenceWarning(0), 'This connection is not referenced by any forms.');
  assert.equal(deletionReferenceWarning(2), 'This connection is used by 2 forms. Deleting it will disconnect those forms.');
});

test('distinguishes disconnected and missing environment credentials', () => {
  assert.equal(connectionAvailability({ active: false, credentialConfigured: true }), 'disconnected');
  assert.equal(connectionAvailability({ active: true, credentialConfigured: false }), 'environment-missing');
  assert.equal(connectionAvailability({ active: true, credentialConfigured: true }), 'connected');
});

test('builds every global connection route', () => {
  assert.equal(API.telegramConnections, '/formflow/settings/telegram/connections');
  assert.equal(API.telegramConnection('stable-id'), '/formflow/settings/telegram/connections/stable-id');
  assert.equal(API.validateTelegramConnection, '/formflow/settings/telegram/connections/validate');
});
