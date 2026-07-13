import assert from 'node:assert/strict';

import type { FormField } from '../../services/form';
import {
  isAllowedUnentitledConditionalTransition,
  newConditionalConfigIssues,
  validateConditionalConfig,
} from '../conditional-config';

const makeField = (overrides: Partial<FormField> & Pick<FormField, 'id' | 'name'>): FormField => ({
  type: 'text',
  label: overrides.name,
  required: false,
  validation: [],
  order: 0,
  ...overrides,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const source = makeField({
  id: 'source-id',
  type: 'select',
  name: 'customer_type',
  label: 'Customer type',
  order: 0,
});
const target = makeField({
  id: 'target-id',
  name: 'company_name',
  label: 'Company name',
  order: 1,
  conditional: { field: source.name, operator: 'equals', value: 'business' },
});
const emptyTarget = makeField({
  id: 'empty-target-id',
  name: 'tax_number',
  order: 2,
  conditional: {
    field: source.name,
    operator: 'is_empty',
    value: 'stale-but-ignored',
  },
});

assert.deepEqual(validateConditionalConfig([source, target, emptyTarget]), []);
assert.deepEqual(
  validateConditionalConfig([null, 42, 'field'] as unknown as FormField[]),
  [],
  'runtime-invalid field entries never make pure validation throw'
);

const dangling = [
  source,
  makeField({
    ...target,
    conditional: { field: 'missing_source', operator: 'equals', value: 'business' },
  }),
];
assert.equal(validateConditionalConfig(dangling)[0].code, 'missing_source');
assert.equal(validateConditionalConfig(dangling)[0].fieldId, target.id);

const selfReference = [
  makeField({
    id: 'self-id',
    name: 'self',
    conditional: { field: 'self', operator: 'equals', value: 'yes' },
  }),
];
assert.equal(validateConditionalConfig(selfReference)[0].code, 'self_reference');

const layoutSource = makeField({ id: 'heading-id', type: 'heading', name: 'heading' });
const layoutReference = [
  layoutSource,
  makeField({
    id: 'layout-target-id',
    name: 'layout_target',
    conditional: { field: layoutSource.name, operator: 'equals', value: 'yes' },
  }),
];
assert.equal(validateConditionalConfig(layoutReference)[0].code, 'layout_source');

const badOperator = [
  source,
  makeField({
    ...target,
    conditional: {
      field: source.name,
      operator: 'starts_with',
      value: 'business',
    } as unknown as FormField['conditional'],
  }),
];
assert.equal(validateConditionalConfig(badOperator)[0].code, 'unsupported_operator');

const threeNodeCycle = [
  makeField({
    id: 'cycle-a',
    name: 'cycle_a',
    conditional: { field: 'cycle_b', operator: 'equals', value: 'a' },
  }),
  makeField({
    id: 'cycle-b',
    name: 'cycle_b',
    conditional: { field: 'cycle_c', operator: 'equals', value: 'b' },
  }),
  makeField({
    id: 'cycle-c',
    name: 'cycle_c',
    conditional: { field: 'cycle_a', operator: 'equals', value: 'c' },
  }),
];
assert.deepEqual(
  validateConditionalConfig(threeNodeCycle)
    .filter((issue) => issue.code === 'cycle')
    .map((issue) => issue.fieldId),
  ['cycle-a', 'cycle-b', 'cycle-c']
);

const duplicateNames = [
  makeField({ id: 'duplicate-a', name: 'duplicate' }),
  makeField({ id: 'duplicate-b', name: 'duplicate' }),
];
assert.deepEqual(
  validateConditionalConfig(duplicateNames).map((issue) => [issue.fieldId, issue.code]),
  [
    ['duplicate-a', 'duplicate_name'],
    ['duplicate-b', 'duplicate_name'],
  ]
);

const malformedString = makeField({
  id: 'malformed-string',
  name: 'malformed_string',
  conditional: 'not-an-object' as unknown as FormField['conditional'],
});
const malformedMissingField = makeField({
  id: 'malformed-field',
  name: 'malformed_field',
  conditional: { operator: 'equals' } as unknown as FormField['conditional'],
});
const malformedMissingOperator = makeField({
  id: 'malformed-operator',
  name: 'malformed_operator',
  conditional: { field: source.name } as unknown as FormField['conditional'],
});
assert.deepEqual(
  validateConditionalConfig([source, malformedString]).map((issue) => issue.code),
  ['missing_source', 'unsupported_operator']
);
assert.deepEqual(
  validateConditionalConfig([source, malformedMissingField]).map((issue) => issue.code),
  ['missing_source']
);
assert.deepEqual(
  validateConditionalConfig([source, malformedMissingOperator]).map((issue) => issue.code),
  ['unsupported_operator']
);

const deterministicMultipleIssues = [
  ...duplicateNames,
  makeField({
    id: 'multi-invalid',
    name: 'multi_invalid',
    conditional: {
      field: 'not_present',
      operator: 'starts_with',
    } as unknown as FormField['conditional'],
  }),
];
assert.deepEqual(
  validateConditionalConfig(deterministicMultipleIssues).map((issue) => [
    issue.fieldId,
    issue.code,
  ]),
  [
    ['duplicate-a', 'duplicate_name'],
    ['duplicate-b', 'duplicate_name'],
    ['multi-invalid', 'missing_source'],
    ['multi-invalid', 'unsupported_operator'],
  ]
);

const legacyValue = { nested: { flags: [1, 2], enabled: true } };
const legacyInvalid = [
  source,
  makeField({
    ...target,
    conditional: { field: 'legacy_missing', operator: 'equals', value: legacyValue },
  }),
];
assert.deepEqual(newConditionalConfigIssues(legacyInvalid, clone(legacyInvalid)), []);
const renamedLegacyTarget = clone(legacyInvalid);
renamedLegacyTarget[1].name = 'renamed_company_name';
assert.deepEqual(
  newConditionalConfigIssues(legacyInvalid, renamedLegacyTarget),
  [],
  'mutable target names do not make an unchanged legacy issue new'
);
const reorderedLegacyValue = clone(legacyInvalid);
reorderedLegacyValue[1].conditional!.value = {
  nested: { enabled: true, flags: [1, 2] },
};
assert.deepEqual(
  newConditionalConfigIssues(legacyInvalid, reorderedLegacyValue),
  [],
  'deep rule identity is independent of object key insertion order'
);
const changedLegacy = clone(legacyInvalid);
(changedLegacy[1].conditional!.value as { nested: { flags: number[] } }).nested.flags.push(3);
assert.deepEqual(
  newConditionalConfigIssues(legacyInvalid, changedLegacy).map((issue) => issue.code),
  ['missing_source']
);

const unchanged = clone([source, target]);
assert.equal(isAllowedUnentitledConditionalTransition([source, target], unchanged), true);

const removedRule = [source, { ...target, conditional: undefined }];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], removedRule), true);
assert.equal(isAllowedUnentitledConditionalTransition([source, target], [source]), true);

const semanticRename = [
  { ...source, name: 'customer_kind' },
  { ...target, conditional: { ...target.conditional!, field: 'customer_kind' } },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], semanticRename), true);

const changedValue = [
  source,
  { ...target, conditional: { ...target.conditional!, value: 'personal' } },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], changedValue), false);

const changedOperator = [
  source,
  { ...target, conditional: { ...target.conditional!, operator: 'not_equals' as const } },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], changedOperator), false);

const alternateSource = makeField({ id: 'alternate-source', name: 'alternate_source' });
const changedSource = [
  source,
  alternateSource,
  { ...target, conditional: { ...target.conditional!, field: alternateSource.name } },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], changedSource), false);

const movedRule = [
  source,
  { ...target, conditional: undefined },
  { ...alternateSource, conditional: target.conditional },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], movedRule), false);

const addedRule = [source, target, { ...alternateSource, conditional: target.conditional }];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], addedRule), false);

const sameCountMovedRule = [
  source,
  { ...target, conditional: undefined },
  { ...alternateSource, conditional: target.conditional },
];
assert.equal(isAllowedUnentitledConditionalTransition([source, target], sameCountMovedRule), false);

const spoofedSourceRename = [
  makeField({ id: 'different-source-id', name: 'customer_kind' }),
  { ...target, conditional: { ...target.conditional!, field: 'customer_kind' } },
];
assert.equal(
  isAllowedUnentitledConditionalTransition([source, target], spoofedSourceRename),
  false
);

const staleEmptyOld = [source, emptyTarget];
const staleEmptyUnchanged = clone(staleEmptyOld);
assert.equal(isAllowedUnentitledConditionalTransition(staleEmptyOld, staleEmptyUnchanged), true);
const staleEmptyChanged = clone(staleEmptyOld);
staleEmptyChanged[1].conditional!.value = 'changed-but-still-ignored';
assert.equal(isAllowedUnentitledConditionalTransition(staleEmptyOld, staleEmptyChanged), false);

const frozenFields = deepFreeze(clone([source, target, emptyTarget]));
const frozenSnapshot = clone(frozenFields);
assert.deepEqual(validateConditionalConfig(frozenFields), []);
assert.equal(isAllowedUnentitledConditionalTransition(frozenFields, clone(frozenFields)), true);
assert.deepEqual(frozenFields, frozenSnapshot);

console.log('All assertions passed: conditional configuration is valid and identity-aware.');
