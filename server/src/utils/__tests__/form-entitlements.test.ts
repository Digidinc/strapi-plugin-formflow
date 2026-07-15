import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import formController, { formPaymentRequiredMetadata, type Context } from '../../controllers/form';
import { FEATURE_TIER, type FeatureKey } from '../../ee/feature-map';
import formService, { type FormField } from '../../services/form';
import {
  findFormEntitlementBlock,
  type EntitlementSettings,
  type NewFormData,
  type OldForm,
} from '../form-entitlements';

const makeField = (overrides: Partial<FormField> & Pick<FormField, 'id' | 'name'>): FormField => ({
  type: 'text',
  label: overrides.name,
  required: false,
  validation: [],
  order: 0,
  ...overrides,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const withoutId = (field: FormField): FormField => {
  const { id: _id, ...fieldWithoutId } = field;
  return fieldWithoutId as FormField;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const source = makeField({ id: 'source-id', type: 'select', name: 'customer_type' });
const target = makeField({
  id: 'target-id',
  name: 'company_name',
  conditional: { field: source.name, operator: 'equals', value: 'business' },
});
const conditionalFields = [source, target];
const missingIdConditionalSource = withoutId({
  ...source,
  name: 'missing_id_customer_type',
});
const missingIdConditionalTarget = withoutId({
  ...target,
  name: 'missing_id_company_name',
  conditional: {
    ...target.conditional!,
    field: missingIdConditionalSource.name,
  },
});
const missingIdConditionalFields = [missingIdConditionalSource, missingIdConditionalTarget];
const denyAll = () => false;
const allowAll = () => true;

assert.deepEqual(formPaymentRequiredMetadata('conditionalLogic', 'pro'), {
  message: 'Upgrade to Pro to use feature: conditionalLogic',
  requiredTier: 'pro',
});
assert.deepEqual(formPaymentRequiredMetadata('compliance.consent', 'business'), {
  message: 'Upgrade to Business to use feature: compliance.consent',
  requiredTier: 'business',
});
assert.deepEqual(formPaymentRequiredMetadata('future.form.feature'), {
  message: 'This feature is not available on the current plan: future.form.feature',
});

const formControllerSource = readFileSync(
  path.join(process.cwd(), 'server/src/controllers/form.ts'),
  'utf8'
);
assert.doesNotMatch(
  formControllerSource,
  /(?:import|require)[\s\S]*?['"]\.\.\/ee\//,
  'the core form controller must not runtime-import the removable EE tree'
);

const expectBlock = (
  oldForm: OldForm | null,
  newData: NewFormData,
  feature: string,
  can: (feature: string) => boolean = denyAll
) => {
  const requiredTier = FEATURE_TIER[feature as FeatureKey];
  assert.ok(requiredTier === 'pro' || requiredTier === 'business');
  assert.deepEqual(findFormEntitlementBlock(oldForm, newData, can), {
    entitled: false,
    feature,
    requiredTier,
  });
};

const asSettings = (settings: Record<string, unknown>): EntitlementSettings =>
  settings as EntitlementSettings;
const withSettings = (settings: Record<string, unknown>): NewFormData => ({
  settings: asSettings(settings),
});
const oldWithSettings = (settings: Record<string, unknown>): OldForm => ({
  settings: asSettings(settings),
});
const expectAllowed = (oldForm: OldForm | null, newData: NewFormData, message: string) => {
  assert.equal(findFormEntitlementBlock(oldForm, newData, denyAll), null, message);
};

expectBlock(null, { fields: conditionalFields }, 'conditionalLogic');

const changedValueFields = [
  source,
  { ...target, conditional: { ...target.conditional!, value: 'personal' } },
];
expectBlock({ fields: conditionalFields }, { fields: changedValueFields }, 'conditionalLogic');
assert.equal(
  findFormEntitlementBlock(
    { fields: conditionalFields },
    { fields: [source, { ...target, conditional: undefined }] },
    denyAll
  ),
  null
);

const renamedFields = [
  { ...source, name: 'customer_kind' },
  { ...target, conditional: { ...target.conditional!, field: 'customer_kind' } },
];
assert.equal(
  findFormEntitlementBlock({ fields: conditionalFields }, { fields: renamedFields }, denyAll),
  null
);
assert.equal(
  findFormEntitlementBlock(
    { fields: conditionalFields },
    { settings: { layout: 'single' } },
    denyAll
  ),
  null,
  'omitting fields must not make a conditional entitlement decision'
);

expectBlock(null, { settings: { layout: 'multi-step' } }, 'multistep');
expectBlock(
  { settings: { layout: 'multi-step', steps: [{ id: 'step-1' }] } },
  { settings: { layout: 'multi-step', steps: [{ id: 'step-1' }, { id: 'step-2' }] } },
  'multistep'
);

const signature = makeField({ id: 'signature-id', type: 'signature', name: 'signature' });
expectBlock(null, { fields: [signature] }, 'fields.signature');
expectBlock(
  { fields: [{ ...signature, type: 'text' }] },
  { fields: [signature] },
  'fields.signature'
);
assert.equal(
  findFormEntitlementBlock({ fields: [signature] }, { fields: [clone(signature)] }, denyAll),
  null
);
expectBlock(
  { fields: [signature] },
  { fields: [signature, { ...signature, name: 'signature_copy' }] },
  'fields.signature'
);
assert.equal(
  findFormEntitlementBlock(
    null,
    { fields: [makeField({ id: 'file-id', type: 'file', name: 'file' })] },
    denyAll
  ),
  null,
  'free file fields remain allowed'
);
const missingIdFreeField = {
  type: 'text',
  name: 'new_free_field',
};
assert.equal(
  findFormEntitlementBlock({ fields: [source] }, { fields: [source, missingIdFreeField] }, denyAll),
  null,
  'new free fields without client-provided IDs remain eligible for service-generated IDs'
);

const consent = makeField({ id: 'consent-id', type: 'consent', name: 'consent' });
expectBlock(null, { fields: [consent] }, 'compliance.consent');
assert.equal(
  findFormEntitlementBlock({ fields: [consent] }, { fields: [clone(consent)] }, denyAll),
  null
);
expectBlock(
  { fields: [consent] },
  { fields: [consent, { ...consent, name: 'consent_copy' }] },
  'compliance.consent'
);

expectBlock(null, { settings: { customCss: '.form { color: red; }' } }, 'whiteLabel');
expectBlock(
  { settings: { customCss: '.form { color: red; }' } },
  { settings: { customCss: '.form { color: blue; }' } },
  'whiteLabel'
);
expectBlock(null, { requiresApproval: true }, 'approval');
assert.equal(
  findFormEntitlementBlock({ requiresApproval: true }, { requiresApproval: true }, denyAll),
  null
);
expectBlock(null, { locales: { fa: { fields: {} } } }, 'multiLanguage');
expectBlock(
  { locales: { fa: { fields: {} } } },
  { locales: { fa: { fields: {} }, en: { fields: {} } } },
  'multiLanguage'
);

// Server-authoritative removal-only projections. Settings is a JSON replacement:
// omitting the top-level key means no decision, while omitted nested keys remove config.
const webhookA = {
  id: 'webhook-a',
  enabled: true,
  url: 'https://example.com/a',
  method: 'POST',
  events: ['submission.created'],
};
const webhookB = {
  id: 'webhook-b',
  enabled: false,
  url: 'https://example.com/b',
  method: 'PUT',
  events: ['submission.updated'],
};
expectBlock(null, withSettings({ webhooks: [webhookA] }), 'webhooks');
expectAllowed(
  oldWithSettings({ webhooks: [webhookA, webhookB] }),
  withSettings({ webhooks: [webhookB] }),
  'an ordered webhook subsequence is removal-only'
);
expectAllowed(
  oldWithSettings({ webhooks: [webhookA] }),
  withSettings({}),
  'omitting webhooks from replacement settings removes them'
);
const legacyWebhookA = { ...webhookA } as Record<string, unknown>;
const legacyWebhookB = { ...webhookB } as Record<string, unknown>;
delete legacyWebhookA.id;
delete legacyWebhookB.id;
expectAllowed(
  oldWithSettings({ webhooks: [legacyWebhookA, legacyWebhookB] }),
  withSettings({ webhooks: [{ ...legacyWebhookB, id: 'generated-webhook-b' }] }),
  'a generated id may normalize a retained legacy webhook during removal'
);
expectBlock(
  oldWithSettings({ webhooks: [webhookA] }),
  withSettings({ webhooks: [{ ...webhookA, url: 'https://example.com/edited' }] }),
  'webhooks'
);
expectBlock(
  oldWithSettings({ webhooks: [webhookA, webhookB] }),
  withSettings({ webhooks: [webhookB, webhookA] }),
  'webhooks'
);
expectBlock(
  oldWithSettings({ webhooks: [webhookA] }),
  withSettings({ webhooks: [webhookA, clone(webhookA)] }),
  'webhooks'
);
expectBlock(
  oldWithSettings({ webhooks: [webhookA] }),
  withSettings({ webhooks: [{ ...webhookA, id: 'changed-persisted-webhook-id' }] }),
  'webhooks'
);

const integrationA = { id: 'integration-a', type: 'slack', enabled: true, webhookUrl: 'a' };
const integrationB = { id: 'integration-b', type: 'zapier', enabled: true, webhookUrl: 'b' };
expectBlock(null, withSettings({ integrations: [integrationA] }), 'integrations');
expectAllowed(
  oldWithSettings({ integrations: [integrationA, integrationB] }),
  withSettings({ integrations: [integrationA] }),
  'integration removal preserves the ordered retained entry'
);
expectBlock(
  oldWithSettings({ integrations: [integrationA] }),
  withSettings({ integrations: [{ ...integrationA, webhookUrl: 'edited' }] }),
  'integrations'
);
expectBlock(
  oldWithSettings({ integrations: [integrationA, integrationB] }),
  withSettings({ integrations: [integrationB, integrationA] }),
  'integrations'
);
expectBlock(
  oldWithSettings({ integrations: [integrationA] }),
  withSettings({ integrations: [integrationA, clone(integrationA)] }),
  'integrations'
);

const freeNotification = {
  id: 'notification-free',
  enabled: true,
  to: ['owner@example.com'],
  subject: 'New submission',
  includeData: true,
};
const extraNotificationA = {
  id: 'notification-extra-a',
  enabled: true,
  to: ['sales@example.com'],
  subject: 'Sales copy',
};
const extraNotificationB = {
  id: 'notification-extra-b',
  enabled: false,
  to: ['audit@example.com'],
  subject: 'Audit copy',
};
expectAllowed(
  null,
  withSettings({ emailNotifications: [freeNotification] }),
  'the first basic email notification is free'
);
expectBlock(
  null,
  withSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  'email.advanced'
);
expectAllowed(
  oldWithSettings({
    emailNotifications: [freeNotification, extraNotificationA, extraNotificationB],
  }),
  withSettings({
    emailNotifications: [
      { ...freeNotification, subject: 'Freely edited first notification' },
      extraNotificationB,
    ],
  }),
  'the first notification stays free-editable while additional records are removed'
);
expectAllowed(
  oldWithSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  withSettings({ emailNotifications: [extraNotificationA] }),
  'removing the first notification promotes the old premium record into the sole free slot'
);
expectAllowed(
  oldWithSettings({ emailNotifications: [extraNotificationA] }),
  withSettings({
    emailNotifications: [{ ...extraNotificationA, subject: 'Now freely editable' }],
  }),
  'a subsequently saved sole notification remains free-editable'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  withSettings({
    emailNotifications: [
      freeNotification,
      { ...extraNotificationA, subject: 'Edited premium record' },
    ],
  }),
  'email.advanced'
);
expectBlock(
  oldWithSettings({
    emailNotifications: [freeNotification, extraNotificationA, extraNotificationB],
  }),
  withSettings({
    emailNotifications: [freeNotification, extraNotificationB, extraNotificationA],
  }),
  'email.advanced'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  withSettings({
    emailNotifications: [freeNotification, extraNotificationA, clone(extraNotificationA)],
  }),
  'email.advanced'
);
const premiumExtraNotification = {
  ...extraNotificationA,
  template: 'Premium {{data}}',
};
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification, premiumExtraNotification] }),
  withSettings({
    emailNotifications: [clone(premiumExtraNotification), clone(premiumExtraNotification)],
  }),
  'email.customTemplate'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  withSettings({
    emailNotifications: [freeNotification, { ...extraNotificationA, id: 'replacement-extra-id' }],
  }),
  'email.advanced'
);
const legacyExtraNotification = {
  enabled: true,
  to: ['legacy@example.com'],
  subject: 'Legacy copy',
};
const legacyExtraNotificationB = {
  enabled: false,
  to: ['legacy-b@example.com'],
  subject: 'Legacy B copy',
};
expectAllowed(
  oldWithSettings({ emailNotifications: [freeNotification, legacyExtraNotification] }),
  withSettings({ emailNotifications: [freeNotification, clone(legacyExtraNotification)] }),
  'legacy additional notifications use an exact ordered fallback'
);
expectAllowed(
  oldWithSettings({
    emailNotifications: [freeNotification, legacyExtraNotification, legacyExtraNotificationB],
  }),
  withSettings({
    emailNotifications: [
      freeNotification,
      { ...legacyExtraNotificationB, id: 'generated-legacy-notification-b' },
    ],
  }),
  'a generated id may normalize a retained legacy additional notification during removal'
);
const legacyPremiumNotification = {
  ...legacyExtraNotificationB,
  template: 'Legacy {{data}}',
  isAutoresponder: true,
  toField: 'customer_email',
  omitBranding: true,
};
expectAllowed(
  oldWithSettings({
    emailNotifications: [freeNotification, legacyExtraNotification, legacyPremiumNotification],
  }),
  withSettings({
    emailNotifications: [
      freeNotification,
      { ...legacyPremiumNotification, id: 'generated-legacy-premium-notification' },
    ],
  }),
  'generated-id normalization preserves legacy premium properties without a false 402'
);
const legacyAutoresponderNotification = {
  ...legacyExtraNotificationB,
  isAutoresponder: true,
  toField: 'customer_email',
};
expectBlock(
  oldWithSettings({
    emailNotifications: [legacyExtraNotification, legacyAutoresponderNotification],
  }),
  withSettings({
    emailNotifications: [
      clone(legacyAutoresponderNotification),
      clone(legacyAutoresponderNotification),
    ],
  }),
  'email.autoresponder'
);
const legacyFirstTemplateNotification = {
  ...legacyExtraNotification,
  template: 'First {{data}}',
};
const legacyAdditionalTemplateNotification = {
  ...legacyExtraNotificationB,
  template: 'Additional {{data}}',
};
// Save the exact cleanup first; generated-ID normalization plus free edits is ambiguous until then.
expectBlock(
  oldWithSettings({
    emailNotifications: [legacyFirstTemplateNotification, legacyAdditionalTemplateNotification],
  }),
  withSettings({
    emailNotifications: [
      {
        ...legacyFirstTemplateNotification,
        id: 'generated-retained-first-notification',
        subject: 'Freely edited retained first',
      },
    ],
  }),
  'email.customTemplate'
);
for (const { oldPremium, deletedPremium, feature } of [
  {
    oldPremium: { template: 'First {{data}}' },
    deletedPremium: { template: 'Deleted {{data}}' },
    feature: 'email.customTemplate',
  },
  {
    oldPremium: { replyTo: 'first@example.com' },
    deletedPremium: { replyTo: 'deleted@example.com' },
    feature: 'email.customTemplate',
  },
  {
    oldPremium: {},
    deletedPremium: { isAutoresponder: true, toField: 'customer_email' },
    feature: 'email.autoresponder',
  },
  {
    oldPremium: {},
    deletedPremium: { omitBranding: true },
    feature: 'email.whiteLabel',
  },
] as const) {
  const oldFirst = { ...legacyExtraNotification, ...oldPremium };
  const deletedAdditional = { ...legacyExtraNotificationB, ...deletedPremium };
  expectBlock(
    oldWithSettings({ emailNotifications: [oldFirst, deletedAdditional] }),
    withSettings({
      emailNotifications: [
        {
          ...oldFirst,
          id: 'generated-retained-first-notification',
          subject: 'Freely edited retained first',
          ...deletedPremium,
        },
      ],
    }),
    feature
  );
}
expectAllowed(
  oldWithSettings({
    emailNotifications: [legacyExtraNotification, legacyPremiumNotification],
  }),
  withSettings({ emailNotifications: [clone(legacyPremiumNotification)] }),
  'removing a legacy first notification may promote the retained premium record into the free slot'
);
// A promotion plus a simultaneous free-field edit cannot prove which id-less legacy record survived.
expectBlock(
  oldWithSettings({
    emailNotifications: [legacyExtraNotification, legacyPremiumNotification],
  }),
  withSettings({
    emailNotifications: [
      {
        ...legacyPremiumNotification,
        id: 'generated-promoted-legacy-notification',
        subject: 'Freely edited after promotion',
      },
    ],
  }),
  'email.customTemplate'
);
const legacyDeletedFirstWithTemplate = {
  ...legacyExtraNotification,
  template: 'Borrowed {{data}}',
};
const legacyPromotedWithDifferentTemplate = {
  ...legacyExtraNotificationB,
  template: 'Original {{data}}',
};
expectBlock(
  oldWithSettings({
    emailNotifications: [legacyDeletedFirstWithTemplate, legacyPromotedWithDifferentTemplate],
  }),
  withSettings({
    emailNotifications: [
      {
        ...legacyPromotedWithDifferentTemplate,
        id: 'generated-promoted-legacy-notification',
        subject: 'Freely edited after promotion',
        template: legacyDeletedFirstWithTemplate.template,
      },
    ],
  }),
  'email.customTemplate'
);
const legacySharedFreeNotificationA = {
  ...legacyExtraNotification,
  template: 'Template A {{data}}',
};
const legacySharedFreeNotificationB = {
  ...legacyExtraNotification,
  template: 'Template B {{data}}',
};
expectAllowed(
  oldWithSettings({
    emailNotifications: [legacySharedFreeNotificationA, legacySharedFreeNotificationB],
  }),
  withSettings({ emailNotifications: [clone(legacySharedFreeNotificationB)] }),
  'legacy promotion uses a unique full-record match when free properties are identical'
);
const legacyEquivalentPremiumNotificationA = {
  ...legacyExtraNotification,
  template: 'Shared {{data}}',
};
const legacyEquivalentPremiumNotificationB = {
  ...legacyExtraNotificationB,
  template: 'Shared {{data}}',
};
// Equivalent premium values do not establish identity when the id-less first record may remain.
expectBlock(
  oldWithSettings({
    emailNotifications: [
      legacyExtraNotification,
      legacyEquivalentPremiumNotificationA,
      legacyEquivalentPremiumNotificationB,
    ],
  }),
  withSettings({
    emailNotifications: [
      {
        ...legacyEquivalentPremiumNotificationB,
        id: 'generated-equivalent-premium-notification',
        subject: 'Freely edited after promotion',
      },
    ],
  }),
  'email.customTemplate'
);
const legacyFirstWithTemplate = {
  enabled: true,
  to: ['owner@example.com'],
  subject: 'Legacy subject',
  template: 'Legacy {{data}}',
};
expectAllowed(
  oldWithSettings({ emailNotifications: [legacyFirstWithTemplate] }),
  withSettings({
    emailNotifications: [
      {
        ...legacyFirstWithTemplate,
        id: 'generated-legacy-first-notification',
        subject: 'Freely edited subject',
      },
    ],
  }),
  'a generated id and free edits preserve unchanged premium properties on the legacy first notification'
);
expectBlock(
  oldWithSettings({ emailNotifications: [legacyFirstWithTemplate] }),
  withSettings({
    emailNotifications: [
      {
        ...legacyFirstWithTemplate,
        id: 'generated-legacy-first-notification',
        subject: 'Freely edited subject',
        template: 'Changed {{data}}',
      },
    ],
  }),
  'email.customTemplate'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification, legacyExtraNotification] }),
  withSettings({
    emailNotifications: [
      freeNotification,
      { ...legacyExtraNotification, subject: 'Legacy edit must not be re-associated' },
    ],
  }),
  'email.advanced'
);

expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification] }),
  withSettings({ emailNotifications: [{ ...freeNotification, replyTo: 'reply@example.com' }] }),
  'email.customTemplate'
);
expectAllowed(
  oldWithSettings({
    emailNotifications: [{ ...freeNotification, replyTo: 'reply@example.com' }],
  }),
  withSettings({ emailNotifications: [freeNotification] }),
  'reply-to can only be cleared after entitlement lapses'
);
expectBlock(
  oldWithSettings({
    emailNotifications: [{ ...freeNotification, template: 'Old {{data}}' }],
  }),
  withSettings({
    emailNotifications: [{ ...freeNotification, template: 'New {{data}}' }],
  }),
  'email.customTemplate'
);
expectAllowed(
  oldWithSettings({
    emailNotifications: [freeNotification, { ...extraNotificationA, template: 'Premium {{data}}' }],
  }),
  withSettings({ emailNotifications: [freeNotification, extraNotificationA] }),
  'premium properties may be cleared without tripping the additional-record gate'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification] }),
  withSettings({
    emailNotifications: [{ ...freeNotification, isAutoresponder: true, toField: 'customer_email' }],
  }),
  'email.autoresponder'
);
for (const invalidAutoresponderValue of ['true', 1]) {
  expectBlock(
    oldWithSettings({ emailNotifications: [freeNotification] }),
    withSettings({
      emailNotifications: [{ ...freeNotification, isAutoresponder: invalidAutoresponderValue }],
    }),
    'email.autoresponder'
  );
}
expectAllowed(
  oldWithSettings({
    emailNotifications: [{ ...freeNotification, isAutoresponder: true, toField: 'customer_email' }],
  }),
  withSettings({
    emailNotifications: [{ ...freeNotification, isAutoresponder: false }],
  }),
  'autoresponder cleanup disables it and clears its source field'
);
expectBlock(
  oldWithSettings({
    emailNotifications: [{ ...freeNotification, isAutoresponder: true, toField: 'customer_email' }],
  }),
  withSettings({
    emailNotifications: [
      { ...freeNotification, isAutoresponder: false, toField: 'customer_email' },
    ],
  }),
  'email.autoresponder'
);
expectBlock(
  oldWithSettings({ emailNotifications: [freeNotification] }),
  withSettings({ emailNotifications: [{ ...freeNotification, omitBranding: true }] }),
  'email.whiteLabel'
);
expectAllowed(
  oldWithSettings({
    emailNotifications: [{ ...freeNotification, omitBranding: true }],
  }),
  withSettings({ emailNotifications: [{ ...freeNotification, omitBranding: false }] }),
  'email branding may only be restored'
);

const recaptchaV3 = {
  enabled: true,
  siteKey: 'site-v3',
  secretKey: 'secret-v3',
  version: 'v3',
  threshold: 0.5,
};
expectBlock(null, withSettings({ spam: { recaptcha: recaptchaV3 } }), 'spam.recaptchaV3');
expectAllowed(
  null,
  withSettings({
    spam: {
      honeypot: true,
      recaptcha: { ...recaptchaV3, version: 'v2' },
    },
  }),
  'reCAPTCHA v2 remains free'
);
expectAllowed(
  oldWithSettings({ spam: { recaptcha: recaptchaV3 } }),
  withSettings({ spam: { recaptcha: clone(recaptchaV3) } }),
  'an existing v3 configuration may be preserved exactly'
);
expectAllowed(
  oldWithSettings({ spam: { recaptcha: recaptchaV3 } }),
  withSettings({ spam: { recaptcha: { ...recaptchaV3, enabled: false } } }),
  'v3 may be disabled without editing its keys or threshold'
);
expectAllowed(
  oldWithSettings({ spam: { recaptcha: recaptchaV3 } }),
  withSettings({
    spam: {
      recaptcha: {
        enabled: true,
        version: 'v2',
        siteKey: 'free-v2-site',
        secretKey: 'free-v2-secret',
      },
    },
  }),
  'v3 may be downgraded to freely editable v2'
);
expectBlock(
  oldWithSettings({ spam: { recaptcha: recaptchaV3 } }),
  withSettings({ spam: { recaptcha: { ...recaptchaV3, siteKey: 'edited' } } }),
  'spam.recaptchaV3'
);
expectBlock(
  oldWithSettings({ spam: { recaptcha: { ...recaptchaV3, enabled: false } } }),
  withSettings({ spam: { recaptcha: recaptchaV3 } }),
  'spam.recaptchaV3'
);

const turnstile = { enabled: true, siteKey: 'turn-site', secretKey: 'turn-secret' };
const hcaptcha = { enabled: true, siteKey: 'h-site', secretKey: 'h-secret' };
for (const { property, feature, config } of [
  { property: 'turnstile', feature: 'spam.turnstile', config: turnstile },
  { property: 'hcaptcha', feature: 'spam.hcaptcha', config: hcaptcha },
] as const) {
  expectBlock(null, withSettings({ spam: { [property]: config } }), feature);
  expectAllowed(
    oldWithSettings({ spam: { [property]: config } }),
    withSettings({ spam: { [property]: clone(config) } }),
    `${property} exact preservation is allowed`
  );
  expectAllowed(
    oldWithSettings({ spam: { [property]: config } }),
    withSettings({ spam: { [property]: { ...config, enabled: false } } }),
    `${property} may be disabled without editing credentials`
  );
  expectBlock(
    oldWithSettings({ spam: { [property]: config } }),
    withSettings({ spam: { [property]: { ...config, siteKey: 'edited' } } }),
    feature
  );
}

const ipBlocklist = { ips: ['192.0.2.1'], countryCodes: ['IR', 'US'] };
expectBlock(null, withSettings({ spam: { ipBlocklist } }), 'spam.ipBlocklist');
expectAllowed(
  oldWithSettings({ spam: { ipBlocklist } }),
  withSettings({ spam: { ipBlocklist: { ips: clone(ipBlocklist.ips) } } }),
  'an IP blocklist property may be removed while retained properties stay exact'
);
expectAllowed(
  oldWithSettings({ spam: { ipBlocklist } }),
  withSettings({ spam: {} }),
  'the complete IP blocklist may be removed'
);
expectBlock(
  oldWithSettings({ spam: { ipBlocklist } }),
  withSettings({ spam: { ipBlocklist: { ...ipBlocklist, ips: [] } } }),
  'spam.ipBlocklist'
);

const stepA = { id: 'step-a', title: 'Step A', fields: ['field-a'] };
const stepB = { id: 'step-b', title: 'Step B', fields: ['field-b'] };
expectAllowed(
  oldWithSettings({ layout: 'multi-step', steps: [stepA, stepB], submitButtonText: 'Old' }),
  withSettings({
    layout: 'multi-step',
    steps: [clone(stepA), clone(stepB)],
    submitButtonText: 'New',
  }),
  'free settings may change while multi-step layout and steps stay exact'
);
expectBlock(
  oldWithSettings({ layout: 'multi-step', steps: [stepA, stepB] }),
  withSettings({ layout: 'multi-step', steps: [{ ...stepA, title: 'Edited' }, stepB] }),
  'multistep'
);
expectBlock(
  oldWithSettings({ layout: 'multi-step', steps: [stepA, stepB] }),
  withSettings({ layout: 'multi-step' }),
  'multistep'
);
expectAllowed(
  oldWithSettings({ layout: 'multi-step', steps: [stepA, stepB] }),
  withSettings({ layout: 'single', steps: [stepA, stepB] }),
  'multi-step may be downgraded as one whole feature even if dormant steps remain'
);
expectAllowed(
  oldWithSettings({ layout: 'multi-step', steps: [stepA, stepB] }),
  withSettings({}),
  'omitting layout from replacement settings deactivates multi-step'
);
const assignedField = makeField({ id: 'assigned-field', name: 'assigned_field' });
const retainedAssignedField = makeField({
  id: 'retained-assigned-field',
  name: 'retained_assigned_field',
});
const assignmentStepA = {
  id: 'assignment-step-a',
  title: 'Assignment A',
  description: 'First',
  fields: [assignedField.id, retainedAssignedField.id],
};
const assignmentStepB = {
  id: 'assignment-step-b',
  title: 'Assignment B',
  description: 'Second',
  fields: [],
};
expectAllowed(
  {
    fields: [assignedField, retainedAssignedField],
    settings: asSettings({ layout: 'multi-step', steps: [assignmentStepA, assignmentStepB] }),
  },
  {
    fields: [retainedAssignedField],
    settings: asSettings({
      layout: 'multi-step',
      steps: [{ ...assignmentStepA, fields: [retainedAssignedField.id] }, assignmentStepB],
    }),
  },
  'deleting a field may atomically remove only its stale step assignment'
);
expectBlock(
  {
    fields: [assignedField, retainedAssignedField],
    settings: asSettings({ layout: 'multi-step', steps: [assignmentStepA, assignmentStepB] }),
  },
  {
    fields: [assignedField, retainedAssignedField],
    settings: asSettings({
      layout: 'multi-step',
      steps: [
        { ...assignmentStepA, fields: [assignedField.id] },
        { ...assignmentStepB, fields: [retainedAssignedField.id] },
      ],
    }),
  },
  'multistep'
);

expectAllowed(
  oldWithSettings({ customCss: '.form { color: red; }' }),
  withSettings({ customCss: '.form { color: red; }' }),
  'custom CSS may be preserved exactly'
);
expectAllowed(
  oldWithSettings({ customCss: '.form { color: red; }' }),
  withSettings({ customCss: '' }),
  'custom CSS may be cleared'
);
expectBlock(
  oldWithSettings({ customCss: '.form { color: red; }' }),
  withSettings({ customCss: '.form { color: blue; }' }),
  'whiteLabel'
);

const faLocale = { fields: { 'field-a': { label: 'نام' } }, successMessage: 'سپاس' };
const enLocale = { fields: { 'field-a': { label: 'Name' } }, successMessage: 'Thanks' };
expectAllowed(
  { locales: { fa: faLocale, en: enLocale } },
  { locales: { fa: clone(faLocale) } },
  'locale removal is allowed when retained locale content stays exact'
);
expectAllowed(
  { locales: { fa: faLocale } },
  {},
  'omitting top-level locales makes no entitlement decision on partial update'
);
expectAllowed(
  { locales: { fa: faLocale } },
  { locales: {} },
  'an explicit empty locale replacement removes all locales'
);
expectBlock(
  { locales: { fa: faLocale } },
  { locales: { fa: { ...faLocale, successMessage: 'Edited' } } },
  'multiLanguage'
);
expectBlock(
  { locales: { fa: faLocale } },
  { locales: { fa: faLocale, en: enLocale } },
  'multiLanguage'
);

expectAllowed(
  { requiresApproval: true },
  {},
  'omitting top-level approval makes no entitlement decision'
);
expectAllowed(
  { requiresApproval: true },
  { requiresApproval: false },
  'approval may be disabled after entitlement lapses'
);

expectAllowed(
  {
    settings: asSettings({
      webhooks: [webhookA],
      integrations: [integrationA],
      emailNotifications: [freeNotification, extraNotificationA],
      spam: { recaptcha: recaptchaV3, turnstile, hcaptcha, ipBlocklist },
      layout: 'multi-step',
      steps: [stepA],
      customCss: '.form {}',
    }),
    locales: { fa: faLocale },
    requiresApproval: true,
  },
  {},
  'omitted premium top-level projections are preserved on a partial PUT'
);

expectBlock(
  null,
  {
    settings: { layout: 'multi-step', customCss: '.form {}' },
    fields: conditionalFields,
    requiresApproval: true,
    locales: { fa: {} },
  },
  'multistep'
);
assert.equal(
  findFormEntitlementBlock(
    null,
    {
      settings: { layout: 'multi-step', customCss: '.form {}' },
      fields: [source, target, signature, consent],
      requiresApproval: true,
      locales: { fa: {} },
    },
    allowAll
  ),
  null
);

const existingPremium: OldForm = {
  settings: {
    layout: 'multi-step',
    steps: [{ id: 'step-1' }],
    customCss: '.form { color: red; }',
  },
  fields: [source, target, signature, consent],
  requiresApproval: true,
  locales: { fa: { fields: {} } },
};
assert.equal(
  findFormEntitlementBlock(existingPremium, clone(existingPremium), denyAll),
  null,
  'all existing premium configuration remains preservable after lapse'
);

let throwingCanCalls = 0;
const throwingCan = () => {
  throwingCanCalls += 1;
  throw new Error('license unavailable');
};
assert.equal(
  findFormEntitlementBlock(null, { settings: { layout: 'single' } }, throwingCan),
  null,
  'a failed license lookup must not block free-only changes'
);
expectBlock(null, { fields: conditionalFields }, 'conditionalLogic', throwingCan);
assert.ok(throwingCanCalls > 0);

assert.deepEqual(
  findFormEntitlementBlock(null, { fields: conditionalFields }, denyAll),
  { entitled: false, feature: 'conditionalLogic', requiredTier: 'pro' },
  'whole-form duplication is evaluated as a create'
);

const makeContext = (body: Record<string, unknown>, id?: string): Context => ({
  params: { id },
  query: {},
  request: { body },
  status: 0,
  notFound() {},
  throw(status: number, error: unknown): never {
    const normalized = error instanceof Error ? error : new Error(String(error));
    Object.assign(normalized, { status });
    throw normalized;
  },
});

interface ControllerHarnessOptions {
  existing?: Record<string, unknown> | null;
  proposedDuplicate?: Record<string, unknown>;
  can?: (feature: string) => boolean;
  resolution?: 'checking' | 'resolved' | 'unavailable';
}

const createControllerHarness = (options: ControllerHarnessOptions = {}) => {
  const createCalls: Record<string, unknown>[] = [];
  const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
  const canCalls: string[] = [];
  const proposedDuplicate =
    options.proposedDuplicate ??
    ({
      title: 'Original (Copy)',
      slug: 'original-copy',
      fields: clone(conditionalFields),
      settings: {},
    } as Record<string, unknown>);

  const form = {
    async findOne(_id: string) {
      return options.existing === undefined ? { fields: conditionalFields } : options.existing;
    },
    async create(data: Record<string, unknown>) {
      createCalls.push(data);
      return { documentId: 'created-id', ...data };
    },
    async update(id: string, data: Record<string, unknown>) {
      updateCalls.push({ id, data });
      return { documentId: id, ...data };
    },
    async prepareDuplicate(_id: string) {
      return proposedDuplicate;
    },
  };
  const license = {
    can(feature: string) {
      canCalls.push(feature);
      return (options.can ?? denyAll)(feature);
    },
    resolution() {
      return options.resolution ?? 'resolved';
    },
  };
  const services = { form, license };
  const strapi = {
    plugin() {
      return {
        service(name: keyof typeof services) {
          return services[name];
        },
      };
    },
    log: { error(..._args: unknown[]) {} },
  };

  return {
    controller: formController({ strapi: strapi as any }),
    createCalls,
    updateCalls,
    canCalls,
    proposedDuplicate,
  };
};

void (async () => {
  const invalidFields = [
    source,
    {
      ...target,
      conditional: { ...target.conditional!, field: 'missing_source' },
    },
  ];

  const invalidCreateHarness = createControllerHarness();
  const invalidCreateCtx = makeContext({ title: 'Invalid', fields: invalidFields });
  const invalidCreateResult = (await invalidCreateHarness.controller.create(
    invalidCreateCtx
  )) as any;
  assert.equal(invalidCreateCtx.status, 400);
  assert.equal(invalidCreateResult.error.status, 400);
  assert.equal(invalidCreateResult.error.details.conditionalIssues[0].code, 'missing_source');
  assert.equal(invalidCreateHarness.canCalls.length, 0);
  assert.equal(invalidCreateHarness.createCalls.length, 0);

  const nonArrayCreateHarness = createControllerHarness();
  const nonArrayCreateCtx = makeContext({ title: 'Invalid', fields: {} });
  const nonArrayCreateResult = (await nonArrayCreateHarness.controller.create(
    nonArrayCreateCtx
  )) as any;
  assert.equal(nonArrayCreateCtx.status, 400);
  assert.equal(nonArrayCreateResult.error.status, 400);
  assert.equal(nonArrayCreateHarness.canCalls.length, 0);
  assert.equal(nonArrayCreateHarness.createCalls.length, 0);

  for (const invalidApprovalValue of ['true', 1]) {
    const invalidApprovalCreateHarness = createControllerHarness();
    const invalidApprovalCreateCtx = makeContext({
      title: 'Invalid approval value',
      requiresApproval: invalidApprovalValue,
    });
    const invalidApprovalCreateResult = (await invalidApprovalCreateHarness.controller.create(
      invalidApprovalCreateCtx
    )) as any;
    assert.equal(invalidApprovalCreateCtx.status, 400);
    assert.equal(invalidApprovalCreateResult.error.status, 400);
    assert.equal(invalidApprovalCreateResult.error.name, 'ValidationError');
    assert.equal(invalidApprovalCreateHarness.canCalls.length, 0);
    assert.equal(invalidApprovalCreateHarness.createCalls.length, 0);
  }

  const falseApprovalCreateHarness = createControllerHarness();
  const falseApprovalCreateCtx = makeContext({
    title: 'Approval disabled',
    requiresApproval: false,
  });
  await falseApprovalCreateHarness.controller.create(falseApprovalCreateCtx);
  assert.equal(falseApprovalCreateCtx.status, 201);
  assert.equal(falseApprovalCreateHarness.createCalls.length, 1);

  const malformedShapePayloads = [
    { settings: { customCss: ['.form {}'] } },
    { settings: { customCss: { color: 'red' } } },
    { locales: [] },
  ];
  for (const malformedPayload of malformedShapePayloads) {
    const malformedShapeCreateHarness = createControllerHarness();
    const malformedShapeCreateCtx = makeContext({
      title: 'Malformed form shape',
      ...malformedPayload,
    });
    const malformedShapeCreateResult = (await malformedShapeCreateHarness.controller.create(
      malformedShapeCreateCtx
    )) as any;
    assert.equal(malformedShapeCreateCtx.status, 400);
    assert.equal(malformedShapeCreateResult.error.status, 400);
    assert.equal(malformedShapeCreateResult.error.name, 'ValidationError');
    assert.equal(malformedShapeCreateHarness.canCalls.length, 0);
    assert.equal(malformedShapeCreateHarness.createCalls.length, 0);
  }

  const duplicateIdCreateHarness = createControllerHarness();
  const duplicateIdCreateCtx = makeContext({
    title: 'Duplicate IDs',
    fields: [source, { ...source, name: 'customer_kind' }],
  });
  const duplicateIdCreateResult = (await duplicateIdCreateHarness.controller.create(
    duplicateIdCreateCtx
  )) as any;
  assert.equal(duplicateIdCreateCtx.status, 400);
  assert.equal(duplicateIdCreateResult.error.status, 400);
  assert.equal(duplicateIdCreateHarness.canCalls.length, 0);
  assert.equal(duplicateIdCreateHarness.createCalls.length, 0);

  const nonStringIdCreateHarness = createControllerHarness();
  const nonStringIdCreateCtx = makeContext({
    title: 'Invalid ID',
    fields: [{ ...source, id: 42 }],
  });
  const nonStringIdCreateResult = (await nonStringIdCreateHarness.controller.create(
    nonStringIdCreateCtx
  )) as any;
  assert.equal(nonStringIdCreateCtx.status, 400);
  assert.equal(nonStringIdCreateResult.error.status, 400);
  assert.equal(nonStringIdCreateHarness.canCalls.length, 0);
  assert.equal(nonStringIdCreateHarness.createCalls.length, 0);

  const missingIdCreateHarness = createControllerHarness();
  const missingIdCreateCtx = makeContext({
    title: 'Generated IDs',
    fields: [missingIdFreeField],
  });
  const missingIdCreateResult = (await missingIdCreateHarness.controller.create(
    missingIdCreateCtx
  )) as any;
  assert.equal(missingIdCreateCtx.status, 201);
  assert.equal(missingIdCreateResult.error, undefined);
  assert.equal(missingIdCreateHarness.createCalls.length, 1);

  let generatedCreateData: Record<string, any> | null = null;
  let generatedFormService!: ReturnType<typeof formService>;
  const generatedIdStrapi = {
    documents() {
      return {
        async create({ data }: { data: Record<string, any> }) {
          generatedCreateData = data;
          return { documentId: 'generated-form-id', ...data };
        },
      };
    },
    plugin() {
      return {
        service(name: 'form' | 'license') {
          return name === 'form' ? generatedFormService : { can: allowAll };
        },
      };
    },
    log: { error(..._args: unknown[]) {} },
  };
  generatedFormService = formService({ strapi: generatedIdStrapi as any });
  const generatedIdController = formController({ strapi: generatedIdStrapi as any });
  const generatedIdCreateCtx = makeContext({
    title: 'Generated conditional IDs',
    fields: missingIdConditionalFields,
  });
  const generatedIdCreateResult = (await generatedIdController.create(generatedIdCreateCtx)) as any;
  assert.equal(generatedIdCreateCtx.status, 201);
  assert.equal(generatedIdCreateResult.data.documentId, 'generated-form-id');
  assert.ok(generatedCreateData);
  const generatedIds = generatedCreateData.fields.map((field: FormField) => field.id);
  assert.deepEqual(
    generatedIds.map((fieldId: unknown) => typeof fieldId),
    ['string', 'string']
  );
  assert.equal(new Set(generatedIds).size, 2);

  const invalidUpdateHarness = createControllerHarness({
    existing: { fields: conditionalFields },
  });
  const invalidUpdateCtx = makeContext({ fields: invalidFields }, 'form-id');
  const invalidUpdateResult = (await invalidUpdateHarness.controller.update(
    invalidUpdateCtx
  )) as any;
  assert.equal(invalidUpdateCtx.status, 400);
  assert.equal(invalidUpdateResult.error.details.conditionalIssues[0].code, 'missing_source');
  assert.equal(invalidUpdateHarness.canCalls.length, 0);
  assert.equal(invalidUpdateHarness.updateCalls.length, 0);

  const malformedUpdateHarness = createControllerHarness({
    existing: { fields: conditionalFields },
  });
  const malformedUpdateCtx = makeContext({ fields: [null] }, 'form-id');
  const malformedUpdateResult = (await malformedUpdateHarness.controller.update(
    malformedUpdateCtx
  )) as any;
  assert.equal(malformedUpdateCtx.status, 400);
  assert.equal(malformedUpdateResult.error.status, 400);
  assert.equal(malformedUpdateHarness.canCalls.length, 0);
  assert.equal(malformedUpdateHarness.updateCalls.length, 0);

  for (const invalidApprovalValue of ['true', 1]) {
    const invalidApprovalUpdateHarness = createControllerHarness({
      existing: { fields: [], requiresApproval: false },
    });
    const invalidApprovalUpdateCtx = makeContext(
      { requiresApproval: invalidApprovalValue },
      'form-id'
    );
    const invalidApprovalUpdateResult = (await invalidApprovalUpdateHarness.controller.update(
      invalidApprovalUpdateCtx
    )) as any;
    assert.equal(invalidApprovalUpdateCtx.status, 400);
    assert.equal(invalidApprovalUpdateResult.error.status, 400);
    assert.equal(invalidApprovalUpdateResult.error.name, 'ValidationError');
    assert.equal(invalidApprovalUpdateHarness.canCalls.length, 0);
    assert.equal(invalidApprovalUpdateHarness.updateCalls.length, 0);
  }

  const falseApprovalUpdateHarness = createControllerHarness({
    existing: { fields: [], requiresApproval: true },
  });
  const falseApprovalUpdateCtx = makeContext({ requiresApproval: false }, 'form-id');
  await falseApprovalUpdateHarness.controller.update(falseApprovalUpdateCtx);
  assert.equal(falseApprovalUpdateCtx.status, 0);
  assert.equal(falseApprovalUpdateHarness.updateCalls.length, 1);

  for (const malformedPayload of malformedShapePayloads) {
    const malformedShapeUpdateHarness = createControllerHarness({ existing: { fields: [] } });
    const malformedShapeUpdateCtx = makeContext(malformedPayload, 'form-id');
    const malformedShapeUpdateResult = (await malformedShapeUpdateHarness.controller.update(
      malformedShapeUpdateCtx
    )) as any;
    assert.equal(malformedShapeUpdateCtx.status, 400);
    assert.equal(malformedShapeUpdateResult.error.status, 400);
    assert.equal(malformedShapeUpdateResult.error.name, 'ValidationError');
    assert.equal(malformedShapeUpdateHarness.canCalls.length, 0);
    assert.equal(malformedShapeUpdateHarness.updateCalls.length, 0);
  }

  const duplicateIdUpdateHarness = createControllerHarness({
    existing: { fields: [source] },
  });
  const duplicateIdUpdateCtx = makeContext(
    { fields: [source, { ...source, name: 'customer_kind' }] },
    'form-id'
  );
  const duplicateIdUpdateResult = (await duplicateIdUpdateHarness.controller.update(
    duplicateIdUpdateCtx
  )) as any;
  assert.equal(duplicateIdUpdateCtx.status, 400);
  assert.equal(duplicateIdUpdateResult.error.status, 400);
  assert.equal(duplicateIdUpdateHarness.canCalls.length, 0);
  assert.equal(duplicateIdUpdateHarness.updateCalls.length, 0);

  const invalidDuplicateHarness = createControllerHarness({
    proposedDuplicate: {
      title: 'Invalid (Copy)',
      slug: 'invalid-copy',
      fields: invalidFields,
      settings: {},
    },
  });
  const invalidDuplicateCtx = makeContext({}, 'form-id');
  const invalidDuplicateResult = (await invalidDuplicateHarness.controller.duplicate(
    invalidDuplicateCtx
  )) as any;
  assert.equal(invalidDuplicateCtx.status, 400);
  assert.equal(invalidDuplicateResult.error.details.conditionalIssues[0].code, 'missing_source');
  assert.equal(invalidDuplicateHarness.canCalls.length, 0);
  assert.equal(invalidDuplicateHarness.createCalls.length, 0);

  for (const malformedPayload of malformedShapePayloads) {
    const malformedShapeDuplicateHarness = createControllerHarness({
      proposedDuplicate: {
        title: 'Malformed shape (Copy)',
        slug: 'malformed-shape-copy',
        fields: [],
        ...malformedPayload,
      },
    });
    const malformedShapeDuplicateCtx = makeContext({}, 'form-id');
    const malformedShapeDuplicateResult =
      (await malformedShapeDuplicateHarness.controller.duplicate(
        malformedShapeDuplicateCtx
      )) as any;
    assert.equal(malformedShapeDuplicateCtx.status, 400);
    assert.equal(malformedShapeDuplicateResult.error.status, 400);
    assert.equal(malformedShapeDuplicateResult.error.name, 'ValidationError');
    assert.equal(malformedShapeDuplicateHarness.canCalls.length, 0);
    assert.equal(malformedShapeDuplicateHarness.createCalls.length, 0);
  }

  const malformedDuplicateHarness = createControllerHarness({
    proposedDuplicate: {
      title: 'Invalid (Copy)',
      slug: 'invalid-copy',
      fields: [42],
      settings: {},
    },
  });
  const malformedDuplicateCtx = makeContext({}, 'form-id');
  const malformedDuplicateResult = (await malformedDuplicateHarness.controller.duplicate(
    malformedDuplicateCtx
  )) as any;
  assert.equal(malformedDuplicateCtx.status, 400);
  assert.equal(malformedDuplicateResult.error.status, 400);
  assert.equal(malformedDuplicateHarness.canCalls.length, 0);
  assert.equal(malformedDuplicateHarness.createCalls.length, 0);

  const blockedCreateHarness = createControllerHarness();
  const blockedCreateCtx = makeContext({ title: 'Blocked', fields: conditionalFields });
  const blockedCreateResult = (await blockedCreateHarness.controller.create(
    blockedCreateCtx
  )) as any;
  assert.equal(blockedCreateCtx.status, 402);
  assert.equal(blockedCreateResult.error.details.feature, 'conditionalLogic');
  assert.equal(blockedCreateResult.error.details.requiredTier, 'pro');
  assert.equal(blockedCreateResult.error.details.resolution, 'resolved');
  assert.equal(
    blockedCreateResult.error.message,
    'Upgrade to Pro to use feature: conditionalLogic'
  );
  assert.equal(blockedCreateHarness.createCalls.length, 0);

  const blockedBusinessCreateHarness = createControllerHarness();
  const blockedBusinessCreateCtx = makeContext({ title: 'Blocked', fields: [consent] });
  const blockedBusinessCreateResult = (await blockedBusinessCreateHarness.controller.create(
    blockedBusinessCreateCtx
  )) as any;
  assert.equal(blockedBusinessCreateCtx.status, 402);
  assert.equal(blockedBusinessCreateResult.error.details.feature, 'compliance.consent');
  assert.equal(blockedBusinessCreateResult.error.details.requiredTier, 'business');
  assert.equal(blockedBusinessCreateResult.error.details.resolution, 'resolved');
  assert.equal(
    blockedBusinessCreateResult.error.message,
    'Upgrade to Business to use feature: compliance.consent'
  );
  assert.equal(blockedBusinessCreateHarness.createCalls.length, 0);

  const blockedWebhookCreateHarness = createControllerHarness();
  const blockedWebhookCreateCtx = makeContext({
    title: 'Blocked webhook',
    settings: { webhooks: [webhookA] },
  });
  const blockedWebhookCreateResult = (await blockedWebhookCreateHarness.controller.create(
    blockedWebhookCreateCtx
  )) as any;
  assert.equal(blockedWebhookCreateCtx.status, 402);
  assert.equal(blockedWebhookCreateResult.error.details.feature, 'webhooks');
  assert.equal(blockedWebhookCreateResult.error.details.requiredTier, 'pro');
  assert.equal(blockedWebhookCreateHarness.createCalls.length, 0);

  const blockedCssUpdateHarness = createControllerHarness({
    existing: { fields: [], settings: { customCss: '.form { color: red; }' } },
  });
  const blockedCssUpdateCtx = makeContext(
    { settings: { customCss: '.form { color: blue; }' } },
    'form-id'
  );
  const blockedCssUpdateResult = (await blockedCssUpdateHarness.controller.update(
    blockedCssUpdateCtx
  )) as any;
  assert.equal(blockedCssUpdateCtx.status, 402);
  assert.equal(blockedCssUpdateResult.error.details.feature, 'whiteLabel');
  assert.equal(blockedCssUpdateHarness.updateCalls.length, 0);

  const blockedIntegrationDuplicateHarness = createControllerHarness({
    proposedDuplicate: {
      title: 'Integration copy',
      slug: 'integration-copy',
      fields: [],
      settings: { integrations: [integrationA] },
    },
  });
  const blockedIntegrationDuplicateCtx = makeContext({}, 'form-id');
  const blockedIntegrationDuplicateResult =
    (await blockedIntegrationDuplicateHarness.controller.duplicate(
      blockedIntegrationDuplicateCtx
    )) as any;
  assert.equal(blockedIntegrationDuplicateCtx.status, 402);
  assert.equal(blockedIntegrationDuplicateResult.error.details.feature, 'integrations');
  assert.equal(blockedIntegrationDuplicateHarness.createCalls.length, 0);

  const partialUpdateHarness = createControllerHarness({
    existing: {
      fields: [],
      settings: {
        webhooks: [webhookA],
        integrations: [integrationA],
        customCss: '.form {}',
      },
      locales: { fa: faLocale },
      requiresApproval: true,
    },
  });
  const partialUpdateCtx = makeContext({ title: 'Free title edit' }, 'form-id');
  const partialUpdateResult = (await partialUpdateHarness.controller.update(
    partialUpdateCtx
  )) as any;
  assert.equal(partialUpdateCtx.status, 0);
  assert.equal(partialUpdateResult.error, undefined);
  assert.equal(partialUpdateHarness.updateCalls.length, 1);

  const blockedUpdateHarness = createControllerHarness({
    existing: { fields: conditionalFields },
    resolution: 'checking',
  });
  const blockedUpdateCtx = makeContext({ fields: changedValueFields }, 'form-id');
  const blockedUpdateResult = (await blockedUpdateHarness.controller.update(
    blockedUpdateCtx
  )) as any;
  assert.equal(blockedUpdateCtx.status, 402);
  assert.equal(blockedUpdateResult.error.details.feature, 'conditionalLogic');
  assert.equal(blockedUpdateResult.error.details.requiredTier, 'pro');
  assert.equal(blockedUpdateResult.error.details.resolution, 'checking');
  assert.equal(blockedUpdateResult.error.details.upgradeUrl, undefined);
  assert.equal(
    blockedUpdateResult.error.message,
    'FormFlow could not verify premium access. Check the license status, then retry saving.'
  );
  assert.equal(blockedUpdateHarness.updateCalls.length, 0);

  const blockedDuplicateHarness = createControllerHarness({ resolution: 'unavailable' });
  const blockedDuplicateCtx = makeContext({}, 'form-id');
  const blockedDuplicateResult = (await blockedDuplicateHarness.controller.duplicate(
    blockedDuplicateCtx
  )) as any;
  assert.equal(blockedDuplicateCtx.status, 402);
  assert.equal(blockedDuplicateResult.error.details.feature, 'conditionalLogic');
  assert.equal(blockedDuplicateResult.error.details.requiredTier, 'pro');
  assert.equal(blockedDuplicateResult.error.details.resolution, 'unavailable');
  assert.equal(blockedDuplicateResult.error.details.upgradeUrl, undefined);
  assert.equal(
    blockedDuplicateResult.error.message,
    'FormFlow could not verify premium access. Check the license status, then retry saving.'
  );
  assert.equal(blockedDuplicateHarness.createCalls.length, 0);

  const entitledDuplicateHarness = createControllerHarness({ can: allowAll });
  const entitledDuplicateCtx = makeContext({}, 'form-id');
  const entitledDuplicateResult = (await entitledDuplicateHarness.controller.duplicate(
    entitledDuplicateCtx
  )) as any;
  assert.equal(entitledDuplicateCtx.status, 201);
  assert.strictEqual(
    entitledDuplicateHarness.createCalls[0],
    entitledDuplicateHarness.proposedDuplicate
  );
  assert.equal(entitledDuplicateResult.data.documentId, 'created-id');

  const original = deepFreeze({
    documentId: 'original-id',
    title: 'Original',
    slug: 'original',
    description: 'Description',
    fields: clone(conditionalFields),
    settings: {
      layout: 'multi-step',
      steps: [
        {
          id: 'step-id',
          title: 'Step one',
          description: 'Step description',
          fields: [source.id, target.id, 'stale-field-id'],
        },
      ],
      customCss: '.form { color: purple; }',
      emailNotifications: [{ enabled: true, to: ['owner@example.com'], subject: 'New' }],
      webhooks: [],
      spam: { honeypot: true, honeypotFieldName: 'website' },
    },
    successMessage: 'Thanks',
    redirectUrl: 'https://example.com/thanks',
    isActive: false,
    requiresApproval: true,
    locales: {
      fa: {
        fields: {
          [target.id]: { label: 'نام شرکت' },
          'stale-field-id': { label: 'قدیمی' },
        },
        successMessage: 'سپاس',
      },
    },
  });
  let createdData: Record<string, any> | null = null;
  const duplicateStrapi = {
    documents() {
      return {
        async findOne() {
          return original;
        },
        async findMany() {
          return [];
        },
        async create({ data }: { data: Record<string, any> }) {
          createdData = data;
          return { documentId: 'copy-id', ...data };
        },
      };
    },
  };
  const duplicateService = formService({ strapi: duplicateStrapi as any });
  await duplicateService.duplicate(original.documentId);
  assert.ok(createdData);

  const duplicatedSource = createdData.fields.find(
    (field: FormField) => field.name === source.name
  );
  const duplicatedTarget = createdData.fields.find(
    (field: FormField) => field.name === target.name
  );
  assert.notEqual(duplicatedSource.id, source.id);
  assert.notEqual(duplicatedTarget.id, target.id);
  assert.deepEqual(duplicatedTarget.conditional, target.conditional);
  assert.deepEqual(createdData.settings.steps[0].fields, [
    duplicatedSource.id,
    duplicatedTarget.id,
  ]);
  assert.equal(createdData.settings.steps[0].title, 'Step one');
  assert.equal(createdData.settings.customCss, original.settings.customCss);
  assert.equal(createdData.requiresApproval, true);
  assert.deepEqual(createdData.locales, {
    fa: {
      fields: { [duplicatedTarget.id]: { label: 'نام شرکت' } },
      successMessage: 'سپاس',
    },
  });
  assert.equal(createdData.isActive, false);
  assert.deepEqual(original.fields, conditionalFields);
  assert.deepEqual(original.settings.steps[0].fields, [source.id, target.id, 'stale-field-id']);

  console.log('All assertions passed: form entitlement and duplication preserve configuration.');
})();
