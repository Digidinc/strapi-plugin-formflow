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

const READONLY_RENDER_MESSAGE =
  'readonly LockedSection children must be an immediate render function that binds disabled';
const READONLY_CONSUME_MESSAGE =
  'readonly LockedSection render children must consume their disabled binding';
const LOCKED_SECTION_MODE_MESSAGE = 'LockedSection mode must be a readonly or replace literal';
const LOCKED_SECTION_SPREAD_MESSAGE = 'LockedSection opening tags must not use prop spreads';

function stripBalancedWrapper(source: string): string {
  let value = source.trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let wrapsWholeValue = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1;
      if (value[index] === ')') depth -= 1;
      if (depth === 0 && index < value.length - 1) wrapsWholeValue = false;
      if (depth < 0) wrapsWholeValue = false;
    }
    if (!wrapsWholeValue || depth !== 0) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function depthZeroOrOperands(source: string): string[] | undefined {
  const expression = stripBalancedWrapper(source);
  const operands: string[] = [];
  let depth = 0;
  let operandStart = 0;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return undefined;
    if (
      depth === 0 &&
      (character === ',' ||
        character === ':' ||
        (character === '?' && expression[index + 1] !== '.'))
    )
      return undefined;
    if (depth === 0 && character === '|' && expression[index + 1] === '|') {
      operands.push(expression.slice(operandStart, index));
      operandStart = index + 2;
      index += 1;
    }
  }

  if (depth !== 0) return undefined;
  operands.push(expression.slice(operandStart));
  return operands.map(stripBalancedWrapper);
}

function usesBindingAsLock(source: string, binding: string): boolean {
  const unquoted = source.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, (literal) =>
    literal.replace(/[^\n]/g, ' ')
  );
  const identifier = `\\b${binding}\\b`;
  const controlProps = unquoted.matchAll(/(?:^|[\s<])(?:disabled|readOnly)\s*=\s*\{([^{}]*)\}/g);
  const bindingLocksControl = [...controlProps].some((match) => {
    const operands = depthZeroOrOperands(match[1] ?? '');
    return operands?.some((operand) => operand === binding) ?? false;
  });
  const adapter = new RegExp(
    `\\b(?:renderNotification\\(\\s*${identifier}\\s*\\)|renderLocalesList\\(\\s*${identifier}\\s*,)`
  );
  return bindingLocksControl || adapter.test(unquoted);
}

function lockedSectionOpeningTags(source: string): Array<{ start: number; text: string }> {
  const tags: Array<{ start: number; text: string }> = [];
  for (const match of source.matchAll(/<LockedSection\b/g)) {
    const start = match.index ?? 0;
    let quote: '"' | "'" | '`' | undefined;
    let braceDepth = 0;

    for (let index = start + match[0].length; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '{') braceDepth += 1;
      else if (character === '}') braceDepth -= 1;
      else if (character === '>' && braceDepth === 0) {
        tags.push({ start, text: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return tags;
}

function readonlyLockedSectionViolations(file: string, source: string): Violation[] {
  const normalizedSource = withoutComments(source);
  const results: Violation[] = [];
  const literalMode =
    /(?:^|\s)mode\s*=\s*(?:["'](?:readonly|replace)["']|\{\s*["'](?:readonly|replace)["']\s*\})/;
  const readonlyMode = /(?:^|\s)mode\s*=\s*(?:["']readonly["']|\{\s*["']readonly["']\s*\})/;

  for (const openingTag of lockedSectionOpeningTags(normalizedSource)) {
    const { start, text } = openingTag;
    const line = lineAt(normalizedSource, start);
    if (/(?:^|\s)\{\s*\.\.\./.test(text)) {
      results.push({ file, line, message: LOCKED_SECTION_SPREAD_MESSAGE });
      continue;
    }
    if (/(?:^|\s)mode\s*=/.test(text) && !literalMode.test(text)) {
      results.push({ file, line, message: LOCKED_SECTION_MODE_MESSAGE });
      continue;
    }
    if (!readonlyMode.test(text)) continue;

    const bodyStart = start + text.length;
    const bodyEnd = normalizedSource.indexOf('</LockedSection>', bodyStart);
    const body = normalizedSource.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
    const renderFunction = body.match(/^\s*\{\s*\(\s*\{([^}]*)\}\s*\)\s*=>/);
    const disabledBinding = renderFunction?.[1].match(
      /(?:^|,)\s*disabled\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?=,|$)/
    );

    if (!renderFunction || !disabledBinding) {
      results.push({ file, line, message: READONLY_RENDER_MESSAGE });
      continue;
    }

    const localBinding = disabledBinding[1] ?? 'disabled';
    if (!usesBindingAsLock(body.slice(renderFunction[0].length), localBinding)) {
      results.push({ file, line, message: READONLY_CONSUME_MESSAGE });
    }
  }

  return results;
}

function readonlyFixtureMessages(children: string): string[] {
  const source = `<LockedSection access={access} feature="webhooks" mode="readonly">${children}</LockedSection>`;
  return readonlyLockedSectionViolations('fixture.tsx', source).map(({ message }) => message);
}

for (const [children, expected] of [
  ['<MutableEditor />', [READONLY_RENDER_MESSAGE]],
  ['{({ disabled }) => <MutableEditor />}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <MutableEditor disabled={disabled} />}', []],
  ['{({ access, disabled }) => <MutableEditor disabled={disabled} />}', []],
  ['{({ disabled: locked }) => <MutableEditor readOnly={locked} />}', []],
  ['{({ disabled }) => <MutableEditor disabled />}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <MutableEditor aria-label="disabled" />}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <MutableEditor aria-disabled={disabled} />}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <MutableEditor data-locked={disabled} />}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <>{disabled && <LockNotice />}</>}', [READONLY_CONSUME_MESSAGE]],
  ['{({ disabled }) => <MutableEditor disabled={!disabled} />}', [READONLY_CONSUME_MESSAGE]],
  [
    '{({ disabled }) => <MutableEditor disabled={disabled && false} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  [
    '{({ disabled }) => <MutableEditor disabled={disabled ? false : true} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  ['{({ disabled }) => <MutableEditor disabled={(disabled)} />}', []],
  ['{({ disabled }) => <MutableEditor disabled={disabled || (other && true)} />}', []],
  [
    '{({ disabled }) => <MutableEditor disabled={false && (other || disabled || third)} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  [
    '{({ disabled }) => <MutableEditor disabled={!(other || disabled || third)} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  [
    '{({ disabled }) => <MutableEditor disabled={(disabled || other) && false} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  [
    '{({ disabled }) => <MutableEditor disabled={disabled || other ? false : true} />}',
    [READONLY_CONSUME_MESSAGE],
  ],
  ['{({ disabled }) => renderLocalesList(disabled, true)}', []],
  ['{({ disabled }) => renderNotification(disabled)}', []],
] as const) {
  assert.deepEqual(readonlyFixtureMessages(children), expected);
}

assert.deepEqual(
  readonlyLockedSectionViolations(
    'fixture.tsx',
    '<LockedSection access={condition > 0 ? a : b} feature="webhooks" mode={READONLY_MODE}><MutableEditor /></LockedSection>'
  ).map(({ message }) => message),
  [LOCKED_SECTION_MODE_MESSAGE]
);

assert.deepEqual(
  readonlyLockedSectionViolations(
    'fixture.tsx',
    '<LockedSection {...sectionProps}><MutableEditor /></LockedSection>'
  ).map(({ message }) => message),
  [LOCKED_SECTION_SPREAD_MESSAGE]
);

for (const absolutePath of presentationFiles(ADMIN_SOURCE)) {
  const file = path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
  const source = withoutComments(readFileSync(absolutePath, 'utf8'));

  violations.push(
    ...readonlyLockedSectionViolations(file, source),
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
const testWebhookHandler = webhookSource.slice(
  webhookSource.indexOf('const handleTestWebhook'),
  webhookSource.indexOf('\n  return (', webhookSource.indexOf('const handleTestWebhook'))
);
requirePattern(
  WEBHOOK_SETTINGS,
  testWebhookHandler,
  /if\s*\(\s*await\s+refreshLicenseOnPaymentRequired\(\s*err\s*,\s*refresh\s*\)\s*\)\s*\{\s*return;\s*\}/,
  'test-webhook 402 handling must await the license refresh and return to refreshed access UI'
);
violations.push(
  ...findMatches(
    WEBHOOK_SETTINGS,
    testWebhookHandler,
    /notifications\.webhook\.test\.upsell/g,
    'test-webhook 402 handling must not make a stale post-refresh Pro upgrade claim'
  )
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
requirePattern(
  lockedSectionFile,
  lockedSectionSource,
  /typeof\s+children\s*===\s*['"]function['"][\s\S]*?children\(\{\s*access,\s*disabled:\s*presentation\.disabled\s*\}\)/,
  'LockedSection must forward presentation.disabled to its render child'
);

const gatedButtonFile = PRIMITIVES[1];
const gatedButtonSource = sourceFor(gatedButtonFile);
const gatedButtonLockedBranch = gatedButtonSource.slice(
  gatedButtonSource.indexOf('const requiredTier')
);
requirePattern(
  gatedButtonFile,
  gatedButtonLockedBranch,
  /<Tooltip\s+label=\{tooltipLabel\}>[\s\S]*?<span[\s\S]*?role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?aria-disabled="true"[\s\S]*?aria-label=\{tooltipLabel\}/,
  'locked GatedButton must expose a focusable explanatory wrapper'
);
requirePattern(
  gatedButtonFile,
  gatedButtonLockedBranch,
  /<Button\s+\{\.\.\.rest\}\s+disabled\s*>/,
  'locked GatedButton must render a truly disabled Button'
);
violations.push(
  ...findMatches(
    gatedButtonFile,
    gatedButtonLockedBranch,
    /\bonClick\s*=/g,
    'locked GatedButton must not forward onClick'
  )
);

assert.equal(
  violations.length,
  0,
  `Premium surface contract violations (${violations.length}):\n${violations
    .map(({ file, line, message }) => `- ${file}:${line} ${message}`)
    .join('\n')}`
);

console.log('All assertions passed: premium admin surfaces use explicit FeatureAccess contracts.');
