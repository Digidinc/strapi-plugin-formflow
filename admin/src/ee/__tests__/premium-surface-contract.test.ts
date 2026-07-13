/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const ADMIN_SOURCE = path.join(REPO_ROOT, 'admin', 'src');
const EXCLUDED_DIRECTORIES = new Set(['__tests__', 'context', 'providers']);
const PRIMITIVES = [
  'admin/src/ee/components/LockedSection.tsx',
  'admin/src/ee/components/GatedButton.tsx',
] as const;
const EMAIL_SETTINGS = 'admin/src/components/FormSettings/EmailSettings.tsx';
const WEBHOOK_SETTINGS = 'admin/src/components/FormSettings/WebhookSettings.tsx';
const SPAM_SETTINGS = 'admin/src/components/FormSettings/SpamSettings.tsx';
const EN_TRANSLATIONS = 'admin/src/translations/en.json';
const LICENSE_NOTICE = 'admin/src/ee/components/LicenseStatusNotice.tsx';

interface Violation {
  file: string;
  line: number;
  message: string;
}

function presentationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) return [];

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return presentationFiles(absolutePath);
      return entry.isFile() && entry.name.endsWith('.tsx') ? [absolutePath] : [];
    });
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function findMatches(file: string, source: string, pattern: RegExp, message: string): Violation[] {
  return [...source.matchAll(pattern)].map((match) => ({
    file,
    line: lineAt(source, match.index ?? 0),
    message,
  }));
}

const violations: Violation[] = [];

function sourceFor(file: string): string {
  return withoutComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

function requirePattern(file: string, source: string, pattern: RegExp, message: string): void {
  if (!pattern.test(source)) {
    violations.push({ file, line: 1, message });
  }
}

for (const absolutePath of presentationFiles(ADMIN_SOURCE)) {
  const file = path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
  const source = withoutComments(readFileSync(absolutePath, 'utf8'));

  violations.push(
    ...findMatches(
      file,
      source,
      /const\s*\{[^}]*\bcan\b[^}]*\}\s*=\s*useLicense\s*\(\s*\)/g,
      'destructures boolean can from useLicense; derive FeatureAccess with access(feature)'
    ),
    ...findMatches(
      file,
      source,
      /\bcan\s*\(/g,
      'uses a boolean premium presentation decision; switch on FeatureAccess'
    ),
    ...findMatches(
      file,
      source,
      /\b(?:can|canEdit)\s*=\s*\{/g,
      'passes a legacy boolean JSX gate; pass access={...}'
    )
  );
}

const spamSource = sourceFor(SPAM_SETTINGS);
for (const [accessName, policyName] of [
  ['recaptchaV3Access', 'recaptchaV3Policy'],
  ['turnstileAccess', 'turnstilePolicy'],
  ['hcaptchaAccess', 'hcaptchaPolicy'],
  ['ipBlocklistAccess', 'ipBlocklistPolicy'],
] as const) {
  requirePattern(
    SPAM_SETTINGS,
    spamSource,
    new RegExp(`const\\s+${policyName}\\s*=\\s*premiumMutationPolicy\\(\\s*${accessName}\\s*\\)`),
    `${policyName} must derive edit/removal authority from premiumMutationPolicy`
  );
}
requirePattern(
  SPAM_SETTINGS,
  spamSource,
  /\{\s*\(\s*recaptcha\.enabled\s*\|\|\s*recaptcha\.version\s*===\s*['"]v3['"]\s*\)\s*&&\s*\(/,
  'a stored dormant reCAPTCHA v3 configuration must still expose the version selector'
);
requirePattern(
  SPAM_SETTINGS,
  spamSource,
  /const\s+handleRecaptchaVersionChange[\s\S]*?recaptchaV3Policy\.canRemove[\s\S]*?recaptchaV3Policy\.canEdit[\s\S]*?updateRecaptcha\(\s*['"]version['"]/,
  'reCAPTCHA version changes must permit only confirmed v3 removal or entitled v3 authoring'
);
requirePattern(
  SPAM_SETTINGS,
  spamSource,
  /disabled=\{\s*recaptcha\.version\s*===\s*['"]v3['"]\s*&&\s*!recaptchaV3Policy\.canRemove\s*\}/,
  'the v3-to-v2 cleanup path must stay disabled while license access is unresolved'
);
requirePattern(
  SPAM_SETTINGS,
  spamSource,
  /<SingleSelectOption\s+value=['"]v3['"]\s+disabled=\{!recaptchaV3Policy\.canEdit\}/,
  'selecting premium reCAPTCHA v3 must require edit authority'
);
for (const [enabledExpression, policyName] of [
  ['turnstile.enabled', 'turnstilePolicy'],
  ['hcaptcha.enabled', 'hcaptchaPolicy'],
  ['ipBlocklistEnabled', 'ipBlocklistPolicy'],
] as const) {
  requirePattern(
    SPAM_SETTINGS,
    spamSource,
    new RegExp(
      `disabled=\\{\\s*${enabledExpression.replace('.', '\\.')}\\s*\\?\\s*!${policyName}\\.canRemove\\s*:\\s*!${policyName}\\.canEdit\\s*\\}`
    ),
    `${policyName} must allow confirmed removal while blocking additions and unresolved cleanup`
  );
}

const emailSource = sourceFor(EMAIL_SETTINGS);
for (const [accessName, policyName] of [
  ['emailAdvancedAccess', 'emailAdvancedPolicy'],
  ['emailTemplateAccess', 'emailTemplatePolicy'],
  ['emailAutoresponderAccess', 'emailAutoresponderPolicy'],
  ['emailWhiteLabelAccess', 'emailWhiteLabelPolicy'],
] as const) {
  requirePattern(
    EMAIL_SETTINGS,
    emailSource,
    new RegExp(`const\\s+${policyName}\\s*=\\s*premiumMutationPolicy\\(\\s*${accessName}\\s*\\)`),
    `${policyName} must derive edit/removal authority from premiumMutationPolicy`
  );
}
requirePattern(
  EMAIL_SETTINGS,
  emailSource,
  /role=['"]group['"][\s\S]*?aria-describedby=\{\s*emailAdvancedAccess\s*===\s*['"]unentitled['"]\s*\?\s*additionalNotificationReasonId\s*:\s*undefined\s*\}/,
  'additional notification groups must be associated with their resolved-unentitled lock reason'
);
requirePattern(
  EMAIL_SETTINGS,
  emailSource,
  /id=\{additionalNotificationReasonId\}[\s\S]*?notifications\.email\.additionalLockedReason/,
  'additional notifications must show translated resolved-unentitled lock copy'
);
requirePattern(
  EMAIL_SETTINGS,
  emailSource,
  /feature=['"]email\.advanced['"][\s\S]*?<\/LockedSection>[\s\S]*?emailAdvancedAccess\s*!==\s*['"]entitled['"][\s\S]*?removeLockedNotification\([\s\S]*?disabled=\{!emailAdvancedPolicy\.canRemove\}/,
  'additional-notification cleanup must be outside the locked ancestor and policy-disabled while unresolved'
);
for (const [handlerName, policyName, mutationPattern] of [
  ['clearReplyTo', 'emailTemplatePolicy', '[\'"]replyTo[\'"]\\s*,\\s*undefined'],
  ['clearEmailTemplate', 'emailTemplatePolicy', '[\'"]template[\'"]\\s*,\\s*undefined'],
  [
    'disableAutoresponder',
    'emailAutoresponderPolicy',
    'isAutoresponder\\s*:\\s*false[\\s\\S]*?toField\\s*:\\s*undefined',
  ],
  ['restoreBranding', 'emailWhiteLabelPolicy', '[\'"]omitBranding[\'"]\\s*,\\s*false'],
] as const) {
  requirePattern(
    EMAIL_SETTINGS,
    emailSource,
    new RegExp(
      `const\\s+${handlerName}[\\s\\S]*?if\\s*\\(\\s*!${policyName}\\.canRemove\\s*\\)\\s*return[\\s\\S]*?${mutationPattern}`
    ),
    `${handlerName} must be a policy-guarded, removal-only premium cleanup`
  );
  requirePattern(
    EMAIL_SETTINGS,
    emailSource,
    new RegExp(`${handlerName}[\\s\\S]*?disabled=\\{!${policyName}\\.canRemove\\}`),
    `${handlerName} cleanup must remain disabled while license access is unresolved`
  );
}
for (const [feature, fieldName, handlerName] of [
  ['email.customTemplate', 'replyTo', 'clearReplyTo'],
  ['email.autoresponder', 'toField', 'disableAutoresponder'],
  ['email.customTemplate', 'template', 'clearEmailTemplate'],
  ['email.whiteLabel', 'omitBranding', 'restoreBranding'],
] as const) {
  requirePattern(
    EMAIL_SETTINGS,
    emailSource,
    new RegExp(
      `feature=[\"']${feature.replace('.', '\\.')}[\"'][\\s\\S]*?name=\\{[^\\n]*${fieldName}[^\\n]*\\}[\\s\\S]*?<\\/LockedSection>[\\s\\S]*?!notificationDisabled[\\s\\S]*?${handlerName}\\(`
    ),
    `${handlerName} must render outside both its premium lock and disabled additional-notification ancestry`
  );
}
requirePattern(
  EMAIL_SETTINGS,
  emailSource,
  /if\s*\(\s*index\s*===\s*0\s*\)\s*\{\s*return\s+renderNotification\(false\)/,
  'the first free email notification must remain editable'
);
requirePattern(
  EMAIL_SETTINGS,
  emailSource,
  /const\s+canPersistNotificationIds\s*=\s*items\.length\s*<=\s*1\s*\|\|\s*emailAdvancedPolicy\.canEdit[\s\S]*?if\s*\(needsIds\(notifications\)\s*&&\s*canPersistNotificationIds\)/,
  'generated IDs must not mutate additional premium notifications while access is unresolved'
);

const webhookSource = sourceFor(WEBHOOK_SETTINGS);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /const\s+webhooksPolicy\s*=\s*premiumMutationPolicy\(\s*webhooksAccess\s*\)/,
  'webhook edit/removal authority must derive from premiumMutationPolicy'
);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /role=['"]group['"][\s\S]*?aria-describedby=\{\s*webhooksAccess\s*===\s*['"]unentitled['"]\s*\?\s*webhooksLockReasonId\s*:\s*undefined\s*\}/,
  'the existing webhook group must be associated with its resolved-unentitled lock reason'
);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /id=\{webhooksLockReasonId\}[\s\S]*?notifications\.webhook\.lockedReason/,
  'existing webhooks must show translated resolved-unentitled lock copy'
);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /feature=['"]webhooks['"][\s\S]*?<\/LockedSection>[\s\S]*?webhooksAccess\s*!==\s*['"]entitled['"][\s\S]*?removeWebhook\([\s\S]*?disabled=\{!webhooksPolicy\.canRemove\}/,
  'webhook cleanup must be outside the locked ancestor and policy-disabled while unresolved'
);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /if\s*\(\s*await\s+refreshLicenseOnPaymentRequired\(\s*err\s*,\s*refresh\s*\)\s*\)[\s\S]*?notifications\.webhook\.test\.upsell/,
  'test-webhook 402 handling must refresh license state before showing the existing info outcome'
);
requirePattern(
  WEBHOOK_SETTINGS,
  webhookSource,
  /const\s+canPersistWebhookIds\s*=\s*webhooksPolicy\.canEdit[\s\S]*?if\s*\(needsIds\(webhooks\)\s*&&\s*canPersistWebhookIds\)/,
  'generated IDs must not mutate webhook configuration while access is unresolved'
);

const translationSource = readFileSync(path.join(REPO_ROOT, EN_TRANSLATIONS), 'utf8');
for (const key of [
  'formflow.notifications.email.additionalLockedReason',
  'formflow.notifications.email.cleanup.clearReplyTo',
  'formflow.notifications.email.cleanup.clearTemplate',
  'formflow.notifications.email.cleanup.disableAutoresponder',
  'formflow.notifications.email.cleanup.restoreBranding',
  'formflow.notifications.webhook.lockedReason',
] as const) {
  requirePattern(
    EN_TRANSLATIONS,
    translationSource,
    new RegExp(`['"]${key.replace('.', '\\.')}['"]\\s*:`),
    `missing English translation for ${key}`
  );
}

const licenseNoticeSource = sourceFor(LICENSE_NOTICE);
requirePattern(
  LICENSE_NOTICE,
  licenseNoticeSource,
  /if\s*\(compact\s*&&\s*resolution\s*===\s*['"]checking['"]\)[\s\S]*?return\s*\([\s\S]*?<Box[\s\S]*?<Typography/,
  'compact checking context must be static text; the plugin-shell notice owns live recovery UI'
);
requirePattern(
  LICENSE_NOTICE,
  licenseNoticeSource,
  /if\s*\(compact\s*&&\s*resolution\s*===\s*['"]unavailable['"]\)[\s\S]*?return\s*\([\s\S]*?<Box[\s\S]*?<Typography/,
  'compact unavailable context must not duplicate the global Retry alert'
);

for (const file of PRIMITIVES) {
  const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const optionalAccess = source.match(/\baccess\s*\?\s*:\s*FeatureAccess\b/);
  const requiredAccess = source.match(/\baccess\s*:\s*FeatureAccess\b/);
  const optionalCan = source.match(/\bcan\s*\?\s*:\s*boolean\b/);

  if (optionalAccess) {
    violations.push({
      file,
      line: lineAt(source, optionalAccess.index ?? 0),
      message: 'keeps optional access compatibility; access: FeatureAccess must be required',
    });
  } else if (!requiredAccess) {
    violations.push({
      file,
      line: 1,
      message: 'does not declare required access: FeatureAccess',
    });
  }

  if (optionalCan) {
    violations.push({
      file,
      line: lineAt(source, optionalCan.index ?? 0),
      message: 'keeps legacy can?: boolean compatibility',
    });
  }
}

const lockedSectionFile = PRIMITIVES[0];
const lockedSectionSource = readFileSync(path.join(REPO_ROOT, lockedSectionFile), 'utf8');
const pointerBlocking = lockedSectionSource.match(/\bpointerEvents\b/);
if (pointerBlocking) {
  violations.push({
    file: lockedSectionFile,
    line: lineAt(lockedSectionSource, pointerBlocking.index ?? 0),
    message:
      'uses pointerEvents as an interaction lock; descendants need real disabled/readOnly state',
  });
}
requirePattern(
  lockedSectionFile,
  lockedSectionSource,
  /role="group"[\s\S]*aria-label=\{lockedReason\}/,
  'readonly sections must expose their access-specific lock reason to assistive technology'
);

assert.equal(
  violations.length,
  0,
  `Premium surface contract violations (${violations.length}):\n${violations
    .map(({ file, line, message }) => `- ${file}:${line} ${message}`)
    .join('\n')}`
);

console.log('All assertions passed: premium admin surfaces use explicit FeatureAccess contracts.');
