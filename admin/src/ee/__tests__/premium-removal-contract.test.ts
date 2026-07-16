/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { premiumMutationPolicy } from '../license-state';

const REPO_ROOT = process.cwd();

const readSource = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const formSettings = readSource('admin/src/components/FormSettings/index.tsx');
const localesEditor = readSource('admin/src/components/FormSettings/LocalesEditor.tsx');
const integrationsSettings = readSource(
  'admin/src/components/FormSettings/IntegrationsSettings.tsx'
);
const submissionsPage = readSource('admin/src/pages/SubmissionsListPage.tsx');
const apiSource = readSource('admin/src/utils/api.ts');
const submissionController = readSource('server/src/controllers/submission.ts');

const methodSource = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
};

// Pure policy: confirmed unentitled access permits monotonic cleanup only;
// unresolved access remains fully fail-closed; entitlement permits both.
assert.deepEqual(premiumMutationPolicy('entitled'), { canEdit: true, canRemove: true });
assert.deepEqual(premiumMutationPolicy('unentitled'), { canEdit: false, canRemove: true });
assert.deepEqual(premiumMutationPolicy('checking'), { canEdit: false, canRemove: false });
assert.deepEqual(premiumMutationPolicy('unavailable'), { canEdit: false, canRemove: false });

// Raw export failures retain the HTTP status so the same authoritative-402
// recovery path works for binary downloads as for Strapi fetch-client calls.
const statusBearingRawErrors = apiSource.match(
  /Object\.assign\s*\([\s\S]*?\{\s*status\s*:\s*response\.status\s*\}\s*\)/g
);
assert.equal(statusBearingRawErrors?.length, 2);

// Advanced export plus scheduled GET/save/remove each refresh license state on
// a 402. CSV/JSON keep their existing error path by guarding refresh with the
// advanced-format discriminator.
assert.match(submissionsPage, /const\s*\{\s*access\s*,\s*refresh\s*\}\s*=\s*useLicense\s*\(\s*\)/);
const paymentRequiredRefreshes = submissionsPage.match(
  /await\s+refreshLicenseOnPaymentRequired\s*\(\s*\w+\s*,\s*refresh\s*\)/g
);
assert.equal(paymentRequiredRefreshes?.length, 4);
assert.match(
  submissionsPage,
  /isAdvancedFormat\s*&&\s*\(?\s*await\s+refreshLicenseOnPaymentRequired\s*\(\s*\w+\s*,\s*refresh\s*\)/
);

// Form settings: approval may transition true -> false after a lapse, but not
// false -> true. Existing custom CSS gets an explicit cleanup action while its
// editor remains read-only.
assert.match(formSettings, /premiumMutationPolicy\s*\(\s*approvalAccess\s*\)/);
assert.match(formSettings, /premiumMutationPolicy\s*\(\s*whiteLabelAccess\s*\)/);
assert.match(formSettings, /premiumMutationPolicy\s*\(\s*multistepAccess\s*\)/);
assert.match(
  formSettings,
  /requiresApproval\s*\?\s*!approvalPolicy\.canRemove\s*:\s*!approvalPolicy\.canEdit/
);
assert.match(
  formSettings,
  /whiteLabelPolicy\.canRemove[\s\S]*updateSetting\s*\(\s*['"]customCss['"]\s*,\s*['"]['"]\s*\)/
);
assert.match(
  formSettings,
  /<LockedSection\s+access=\{whiteLabelAccess\}[\s\S]*?<\/LockedSection>\s*\{Boolean\(settings\.customCss\)[\s\S]*?onClick=\{handleRemoveCustomCss\}/,
  'custom CSS cleanup must remain outside the aria-disabled read-only ancestor'
);
assert.match(
  formSettings,
  /const\s+handleLayoutChange[\s\S]*?nextLayout\s*===\s*['"]multi-step['"][\s\S]*?!multistepPolicy\.canEdit[\s\S]*?currentLayout\s*===\s*['"]multi-step['"][\s\S]*?!multistepPolicy\.canRemove/,
  'layout changes must allow unentitled downgrade but reject unresolved cleanup'
);
assert.match(
  formSettings,
  /<SingleSelect[\s\S]*?disabled=\{currentLayout\s*===\s*['"]multi-step['"]\s*&&\s*!multistepPolicy\.canRemove\}[\s\S]*?onChange=\{handleLayoutChange\}/,
  'a stored multi-step layout must be fully disabled while access is unresolved'
);

// Locales: all content stays read-only when locked, while confirmed-unentitled
// access receives a policy-guarded remove button.
assert.match(localesEditor, /premiumMutationPolicy\s*\(\s*multiLanguageAccess\s*\)/);
assert.match(localesEditor, /if\s*\(\s*!multiLanguagePolicy\.canRemove\s*\)\s*return/);
assert.match(localesEditor, /disabled=\{!canRemove\}/);
assert.match(
  localesEditor,
  /renderLocalesList\s*\(\s*disabled\s*,\s*multiLanguagePolicy\.canRemove\s*\)/
);

// Integrations: unknown states expose no mutation path; resolved unentitled
// access renders a static summary with only policy-guarded removal.
assert.match(integrationsSettings, /premiumMutationPolicy\s*\(\s*integrationsAccess\s*\)/);
assert.match(integrationsSettings, /if\s*\(\s*!integrationsPolicy\.canRemove\s*\)\s*return/);
assert.match(
  integrationsSettings,
  /const\s+renderIntegrationList\s*=\s*\(disabled:\s*boolean,\s*canRemove:\s*boolean\)[\s\S]*?renderFields\(config,\s*index,\s*disabled\)/,
  'locked integration lists must render their stored field values with explicit control state'
);
assert.match(
  integrationsSettings,
  /case\s+['"]checking['"]\s*:[\s\S]*renderIntegrationList\(true,\s*false\)[\s\S]*case\s+['"]unavailable['"]\s*:[\s\S]*renderIntegrationList\(true,\s*false\)[\s\S]*case\s+['"]unentitled['"]\s*:[\s\S]*renderIntegrationList\(true,\s*integrationsPolicy\.canRemove\)/,
  'unknown integrations must be readable without cleanup while unentitled integrations allow removal'
);
assert.match(
  integrationsSettings,
  /const\s+renderFields\s*=\s*\(config:\s*IntegrationConfig,\s*index:\s*number,\s*disabled\s*=\s*false\)[\s\S]*?readOnly=\{disabled\}[\s\S]*?disabled=\{disabled\}/,
  'locked integration field values must remain visible through real read-only controls'
);

// Scheduled exports: only resolved access may read the saved config. Unknown
// access closes the dialog and clears every draft field. Unentitled access may
// open the removal-only dialog, but create/save remains edit-policy guarded.
assert.match(submissionsPage, /premiumMutationPolicy\s*\(\s*advancedExportAccess\s*\)/);
assert.match(
  submissionsPage,
  /if\s*\(\s*!advancedExportPolicy\.canEdit\s*&&\s*!advancedExportPolicy\.canRemove\s*\)\s*\{[\s\S]*setScheduleDialogOpen\s*\(\s*false\s*\)[\s\S]*setScheduledConfig\s*\(\s*null\s*\)[\s\S]*setScheduleCron\s*\([\s\S]*setScheduleEmails\s*\(\s*['"]['"]\s*\)[\s\S]*setScheduleFormat\s*\(\s*['"]xlsx['"]\s*\)/
);
assert.match(submissionsPage, /if\s*\(\s*!advancedExportPolicy\.canEdit\s*\)\s*\{\s*return;?\s*\}/);
assert.match(
  submissionsPage,
  /if\s*\(\s*!advancedExportPolicy\.canRemove\s*\)\s*\{\s*return;?\s*\}/
);
assert.match(
  submissionsPage,
  /case\s+['"]unentitled['"]\s*:[\s\S]*scheduledConfig[\s\S]*onSelect=\{openScheduleDialog\}/
);
assert.match(
  submissionsPage,
  /advancedExportPolicy\.canEdit\s*\?[\s\S]*schedule-cron[\s\S]*scheduledConfig/
);

// Creating a schedule remains gated; deleting one is monotonic cleanup and may
// not consult the entitlement service.
const createScheduledExport = methodSource(
  submissionController,
  'async createScheduledExport',
  'async removeScheduledExport'
);
const removeScheduledExport = methodSource(
  submissionController,
  'async removeScheduledExport',
  '\n});'
);

assert.match(createScheduledExport, /service\s*\(\s*['"]license['"]\s*\)/);
assert.match(createScheduledExport, /can\s*\(\s*['"]export\.advanced['"]\s*\)/);
assert.doesNotMatch(removeScheduledExport, /service\s*\(\s*['"]license['"]\s*\)/);
assert.doesNotMatch(removeScheduledExport, /can\s*\(\s*['"]export\.advanced['"]\s*\)/);
assert.doesNotMatch(removeScheduledExport, /ctx\.status\s*=\s*402/);

console.log('All assertions passed: premium configuration supports removal-only cleanup.');
