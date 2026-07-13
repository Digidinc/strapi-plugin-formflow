import assert from 'node:assert/strict';

import formController, { type Context } from '../../controllers/form';
import formService, { type FormField } from '../../services/form';
import { findFormEntitlementBlock, type NewFormData, type OldForm } from '../form-entitlements';

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

const expectBlock = (
  oldForm: OldForm | null,
  newData: NewFormData,
  feature: string,
  can: (feature: string) => boolean = denyAll
) => {
  assert.deepEqual(findFormEntitlementBlock(oldForm, newData, can), {
    entitled: false,
    feature,
  });
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
assert.equal(
  findFormEntitlementBlock(
    { settings: { customCss: '.form { color: red; }' } },
    { settings: { customCss: '.form { color: blue; }' } },
    denyAll
  ),
  null
);
expectBlock(null, { requiresApproval: true }, 'approval');
assert.equal(
  findFormEntitlementBlock({ requiresApproval: true }, { requiresApproval: true }, denyAll),
  null
);
expectBlock(null, { locales: { fa: { fields: {} } } }, 'multiLanguage');
assert.equal(
  findFormEntitlementBlock(
    { locales: { fa: { fields: {} } } },
    { locales: { fa: { fields: {} }, en: { fields: {} } } },
    denyAll
  ),
  null
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
  { entitled: false, feature: 'conditionalLogic' },
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
  assert.equal(blockedCreateHarness.createCalls.length, 0);

  const blockedUpdateHarness = createControllerHarness({
    existing: { fields: conditionalFields },
  });
  const blockedUpdateCtx = makeContext({ fields: changedValueFields }, 'form-id');
  const blockedUpdateResult = (await blockedUpdateHarness.controller.update(
    blockedUpdateCtx
  )) as any;
  assert.equal(blockedUpdateCtx.status, 402);
  assert.equal(blockedUpdateResult.error.details.feature, 'conditionalLogic');
  assert.equal(blockedUpdateHarness.updateCalls.length, 0);

  const blockedDuplicateHarness = createControllerHarness();
  const blockedDuplicateCtx = makeContext({}, 'form-id');
  const blockedDuplicateResult = (await blockedDuplicateHarness.controller.duplicate(
    blockedDuplicateCtx
  )) as any;
  assert.equal(blockedDuplicateCtx.status, 402);
  assert.equal(blockedDuplicateResult.error.details.feature, 'conditionalLogic');
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
