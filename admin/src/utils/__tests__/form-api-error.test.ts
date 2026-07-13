import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FEATURE_TIER } from '../../ee/feature-map';
import {
  classifyFormApiError,
  paymentRequiredCopy,
  safeUpgradeUrl,
  toFormApiError,
  type FormApiError,
  type FormApiErrorDetails,
} from '../form-api-error';

const makeError = (status?: number, details?: FormApiErrorDetails): FormApiError => {
  const error = new Error('Request failed') as FormApiError;
  error.status = status;
  error.details = details;
  return error;
};

assert.equal(classifyFormApiError(makeError(400, {})), 'validation');

const paymentDetails: FormApiErrorDetails = {
  feature: 'conditionalLogic',
  upgradeUrl: 'https://example.com/pricing',
};
const paymentError = makeError(402, paymentDetails);
assert.equal(classifyFormApiError(paymentError), 'payment_required');
assert.notEqual(classifyFormApiError(paymentError), 'validation');
assert.equal(paymentError.details, paymentDetails);

const futureFeatureDetails: FormApiErrorDetails = { feature: 'future.server.feature' };
assert.equal(classifyFormApiError(makeError(402, futureFeatureDetails)), 'payment_required');
assert.equal(classifyFormApiError(makeError(undefined, futureFeatureDetails)), 'other');
assert.equal(
  classifyFormApiError(makeError(200, { conditionalIssues: [] })),
  'other',
  'structured details must never determine the error kind without a matching status'
);

assert.equal(classifyFormApiError(makeError(500)), 'other');
assert.equal(classifyFormApiError(makeError()), 'other');

const knownFormSaveFeatures = [
  { feature: 'multistep', defaultLabel: 'Multi-step forms', tier: 'pro' },
  { feature: 'conditionalLogic', defaultLabel: 'Conditional Logic', tier: 'pro' },
  { feature: 'fields.signature', defaultLabel: 'Signature fields', tier: 'pro' },
  { feature: 'fields.rating', defaultLabel: 'Rating / NPS fields', tier: 'pro' },
  { feature: 'fields.address', defaultLabel: 'Address fields', tier: 'pro' },
  { feature: 'fields.richtext', defaultLabel: 'Rich Text fields', tier: 'pro' },
  { feature: 'fields.calculated', defaultLabel: 'Calculated fields', tier: 'pro' },
  { feature: 'fields.payment', defaultLabel: 'Stripe Payment fields', tier: 'pro' },
  { feature: 'compliance.consent', defaultLabel: 'Consent Checkbox fields', tier: 'business' },
  { feature: 'whiteLabel', defaultLabel: 'Custom CSS', tier: 'pro' },
  { feature: 'approval', defaultLabel: 'Approval workflow', tier: 'business' },
  { feature: 'multiLanguage', defaultLabel: 'Multi-language forms', tier: 'business' },
] as const;

for (const { feature, defaultLabel, tier } of knownFormSaveFeatures) {
  assert.equal(FEATURE_TIER[feature], tier);
  assert.deepEqual(paymentRequiredCopy({ feature }), {
    kind: 'known',
    feature,
    defaultLabel,
    tier,
  });
}

assert.deepEqual(paymentRequiredCopy({ feature: 'future.server.feature' }), { kind: 'generic' });
assert.deepEqual(paymentRequiredCopy(undefined), { kind: 'generic' });
assert.deepEqual(paymentRequiredCopy({ feature: 123 } as unknown as FormApiErrorDetails), {
  kind: 'generic',
});

assert.equal(safeUpgradeUrl('https://example.com/pricing'), 'https://example.com/pricing');
assert.equal(safeUpgradeUrl('http://example.com/plans'), 'http://example.com/plans');
assert.equal(safeUpgradeUrl('  https://example.com/pricing  '), 'https://example.com/pricing');

for (const invalidUpgradeUrl of [
  undefined,
  null,
  '',
  '   ',
  'not a URL',
  '//example.com/pricing',
  'javascript:alert(1)',
  'mailto:sales@example.com',
  42,
  {},
]) {
  assert.equal(safeUpgradeUrl(invalidUpgradeUrl), undefined);
}

const conditionalIssues = [
  {
    fieldId: 'target-field',
    fieldName: 'company_name',
    code: 'missing_source',
    message: 'Conditional source field "customer_type" does not exist.',
  },
];
const normalized = toFormApiError(
  {
    message: 'Generic fetch error',
    response: {
      status: 402,
      data: {
        error: {
          status: 400,
          message: 'Conditional configuration is invalid.',
          details: {
            feature: 'conditionalLogic',
            upgradeUrl: 'https://example.com/pricing',
            conditionalIssues,
          },
        },
      },
    },
  },
  'Fallback message'
);

assert.equal(normalized.message, 'Conditional configuration is invalid.');
assert.equal(normalized.status, 400);
assert.deepEqual(normalized.details, {
  feature: 'conditionalLogic',
  upgradeUrl: 'https://example.com/pricing',
  conditionalIssues,
});
assert.equal(classifyFormApiError(normalized), 'validation');

const responseStatusFallback = toFormApiError(
  { response: { status: 402, data: {} } },
  'Upgrade required'
);
assert.equal(responseStatusFallback.status, 402);
assert.equal(responseStatusFallback.message, 'Upgrade required');
assert.equal(classifyFormApiError(responseStatusFallback), 'payment_required');

const directStatusFallback = toFormApiError({ status: 500 }, 'Request failed');
assert.equal(directStatusFallback.status, 500);
assert.equal(directStatusFallback.message, 'Request failed');
assert.equal(classifyFormApiError(directStatusFallback), 'other');

const nativeMessageFallback = toFormApiError(new Error('Network unavailable'), 'Request failed');
assert.equal(nativeMessageFallback.message, 'Network unavailable');

const formApiErrorSource = readFileSync(
  path.join(process.cwd(), 'admin/src/utils/form-api-error.ts'),
  'utf8'
);
assert.match(formApiErrorSource, /FEATURE_TIER\[knownFeature\]/);

const useFormSource = readFileSync(path.join(process.cwd(), 'admin/src/hooks/useForm.ts'), 'utf8');
const createMutationSource = useFormSource.slice(
  useFormSource.indexOf('const createForm'),
  useFormSource.indexOf('const updateForm')
);
const updateMutationSource = useFormSource.slice(
  useFormSource.indexOf('const updateForm'),
  useFormSource.indexOf('const deleteForm')
);

for (const [name, source] of [
  ['createForm', createMutationSource],
  ['updateForm', updateMutationSource],
] as const) {
  assert.doesNotMatch(
    source,
    /setError\(error\)/,
    `${name} save failures must not replace the editor with the page-load error state`
  );
  assert.match(source, /throw error/, `${name} must still reject with the normalized server error`);
}

const formEditSource = readFileSync(
  path.join(process.cwd(), 'admin/src/pages/FormEditPage.tsx'),
  'utf8'
);
const saveHandlerSource = formEditSource.slice(
  formEditSource.indexOf('const handleSave'),
  formEditSource.indexOf('const tabTitle')
);

assert.match(formEditSource, /const \{ refresh: refreshLicense \} = useLicense\(\)/);
assert.match(formEditSource, /const \[isSavePending, setIsSavePending\] = useState\(false\)/);
assert.match(formEditSource, /const isSavePendingRef = React\.useRef\(false\)/);
assert.match(formEditSource, /const savePending = isSaving \|\| isSavePending/);
assert.match(saveHandlerSource, /if \(isSavePendingRef\.current\) \{\s*return;\s*\}/);
assert.match(saveHandlerSource, /isSavePendingRef\.current = true/);
assert.match(saveHandlerSource, /setIsSavePending\(true\)/);
assert.match(
  saveHandlerSource,
  /finally \{\s*isSavePendingRef\.current = false;\s*setIsSavePending\(false\);\s*\}/
);
assert.match(formEditSource, /loading=\{savePending\}/);
assert.match(formEditSource, /disabled=\{savePending \|\|/);
assert.match(saveHandlerSource, /const kind = classifyFormApiError\(apiErr\)/);
assert.match(saveHandlerSource, /kind === ['"]payment_required['"]/);
assert.match(saveHandlerSource, /await refreshLicense\(\)/);
assert.match(saveHandlerSource, /type: ['"]info['"]/);
assert.match(saveHandlerSource, /form\.save\.paymentRequired/);
assert.match(saveHandlerSource, /paymentRequiredCopy\(details\)/);
assert.match(saveHandlerSource, /copy\.kind === ['"]known['"]/);
assert.match(saveHandlerSource, /form\.save\.paymentRequired\.known/);
assert.match(saveHandlerSource, /form\.save\.paymentFeature\.\$\{copy\.feature\}/);
assert.match(saveHandlerSource, /license\.tier\.\$\{copy\.tier\}/);
assert.match(saveHandlerSource, /safeUpgradeUrl\(details\?\.upgradeUrl\)/);
assert.match(saveHandlerSource, /url: upgradeUrl/);
assert.match(saveHandlerSource, /license\.viewPlans/);
assert.doesNotMatch(saveHandlerSource, /\}\)\s*\|\|\s*message/);
assert.match(saveHandlerSource, /kind === ['"]validation['"]/);
assert.match(saveHandlerSource, /Array\.isArray\(details\?\.conditionalIssues\)/);
assert.match(saveHandlerSource, /form\.validation\.conditionalConfiguration/);
assert.match(saveHandlerSource, /issue\.fieldName/);
assert.match(saveHandlerSource, /issue\.message/);

const paymentBranchIndex = saveHandlerSource.indexOf("kind === 'payment_required'");
const refreshIndex = saveHandlerSource.indexOf('await refreshLicense()');
const infoNotificationIndex = saveHandlerSource.indexOf("type: 'info'", refreshIndex);
const validationBranchIndex = saveHandlerSource.indexOf("kind === 'validation'");
const conditionalIssuesIndex = saveHandlerSource.indexOf('const conditionalIssues');
const fieldMappingIndex = saveHandlerSource.indexOf('mapServerErrorToFields');
const pendingLockIndex = saveHandlerSource.indexOf('isSavePendingRef.current = true');
const firstMutationIndex = saveHandlerSource.indexOf('await createForm');

assert.ok(paymentBranchIndex >= 0 && paymentBranchIndex < refreshIndex);
assert.ok(refreshIndex < infoNotificationIndex, 'the authoritative 402 refresh must settle first');
assert.ok(
  validationBranchIndex >= 0 && validationBranchIndex < fieldMappingIndex,
  'only the explicit validation branch may map details onto fields'
);
assert.match(
  saveHandlerSource.slice(conditionalIssuesIndex, fieldMappingIndex),
  /return;/,
  'conditional-configuration failures must stop before generic field mapping'
);
assert.ok(
  pendingLockIndex >= 0 && pendingLockIndex < firstMutationIndex,
  'the synchronous guard must lock before the first form mutation can start'
);

const translations = JSON.parse(
  readFileSync(path.join(process.cwd(), 'admin/src/translations/en.json'), 'utf8')
) as Record<string, string>;
assert.equal(
  translations['formflow.form.save.paymentRequired'],
  'This form uses premium configuration that is not available on the current plan. Review the plan or remove the premium settings before saving.'
);
assert.equal(
  translations['formflow.form.save.paymentRequired.known'],
  '{feature} requires a {tier} plan. Upgrade your plan or remove that premium configuration before saving.'
);
assert.equal(translations['formflow.license.tier.pro'], 'Pro');
assert.equal(translations['formflow.license.tier.business'], 'Business');
for (const { feature, defaultLabel } of knownFormSaveFeatures) {
  assert.equal(translations[`formflow.form.save.paymentFeature.${feature}`], defaultLabel);
}
assert.equal(translations['formflow.form.save.paymentRequired.conditionalLogic'], undefined);
assert.equal(
  translations['formflow.form.validation.conditionalConfiguration'],
  'Fix the conditional logic configuration before saving: {issues}'
);

console.log('All assertions passed: form API error classification and detail preservation.');
