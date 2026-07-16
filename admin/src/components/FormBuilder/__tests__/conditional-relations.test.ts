import assert from 'node:assert/strict';

import type { FormField } from '../../../utils/api';
import {
  conditionalDependents,
  deleteFieldAndConditions,
  renameFieldAndCascade,
} from '../conditional-relations';

const makeField = (overrides: Partial<FormField> & Pick<FormField, 'id' | 'name'>): FormField => ({
  type: 'text',
  label: overrides.name,
  required: false,
  validation: [],
  order: 0,
  width: 'full',
  ...overrides,
});

const source = makeField({
  id: 'source-id',
  name: 'customer_type',
  label: 'Customer type',
  order: 4,
});
const targetId = 'company-id';
const targetField = makeField({
  id: targetId,
  name: 'company_name',
  label: 'Company name',
  order: 8,
  conditional: {
    field: source.name,
    operator: 'equals',
    value: 'business',
  },
});
const secondTarget = makeField({
  id: 'tax-id',
  name: 'tax_number',
  label: 'Tax number',
  order: 12,
  conditional: {
    field: source.name,
    operator: 'not_equals',
    value: 'personal',
  },
});
const unrelatedSource = makeField({
  id: 'country-id',
  name: 'country',
  label: 'Country',
  order: 16,
});
const unrelatedTarget = makeField({
  id: 'state-id',
  name: 'state',
  label: 'State',
  order: 20,
  conditional: {
    field: unrelatedSource.name,
    operator: 'contains',
    value: 'United',
  },
});

const fields: FormField[] = [source, targetField, secondTarget, unrelatedSource, unrelatedTarget];
const originalSnapshot = JSON.parse(JSON.stringify(fields)) as FormField[];
for (const field of fields) {
  if (field.conditional) Object.freeze(field.conditional);
  Object.freeze(field);
}
Object.freeze(fields);

const target = (candidateFields: FormField[]): FormField => {
  const match = candidateFields.find((field) => field.id === targetId);
  assert.ok(match);
  return match;
};

assert.deepEqual(
  conditionalDependents(fields, source.name).map((field) => field.id),
  [targetId, secondTarget.id]
);
assert.deepEqual(conditionalDependents(fields, 'missing_source'), []);

const renamed = renameFieldAndCascade(fields, source.id, 'customer_kind');
assert.equal(renamed.find((field) => field.id === source.id)?.name, 'customer_kind');
assert.equal(target(renamed).conditional?.field, 'customer_kind');
assert.equal(target(renamed).conditional?.operator, 'equals');
assert.equal(target(renamed).conditional?.value, 'business');
assert.equal(
  renamed.find((field) => field.id === secondTarget.id)?.conditional?.field,
  'customer_kind'
);
assert.deepEqual(
  renamed.find((field) => field.id === unrelatedTarget.id),
  unrelatedTarget,
  'rename must leave unrelated conditions unchanged'
);

const deleted = deleteFieldAndConditions(fields, source.id);
assert.deepEqual(
  deleted.affected.map((field) => field.id),
  [targetId, secondTarget.id]
);
assert.equal(target(deleted.fields).conditional, undefined);
assert.equal(deleted.fields.find((field) => field.id === secondTarget.id)?.conditional, undefined);
assert.equal(
  deleted.fields.some((field) => field.id === source.id),
  false
);
assert.deepEqual(
  deleted.fields.find((field) => field.id === unrelatedTarget.id),
  unrelatedTarget,
  'delete must leave unrelated conditions unchanged'
);
assert.deepEqual(
  deleted.fields.map(({ id, order }) => ({ id, order })),
  [
    { id: targetId, order: 8 },
    { id: secondTarget.id, order: 12 },
    { id: unrelatedSource.id, order: 16 },
    { id: unrelatedTarget.id, order: 20 },
  ],
  'relationship helper must leave order reindexing to its caller'
);

const deletedNonSource = deleteFieldAndConditions(fields, unrelatedTarget.id);
assert.deepEqual(deletedNonSource.affected, []);
assert.deepEqual(
  deletedNonSource.fields.find((field) => field.id === targetId)?.conditional,
  targetField.conditional
);
assert.deepEqual(
  deletedNonSource.fields.find((field) => field.id === secondTarget.id)?.conditional,
  secondTarget.conditional
);

assert.deepEqual(fields, originalSnapshot, 'helpers must not mutate their input array or objects');
assert.notStrictEqual(renamed, fields);
assert.notStrictEqual(deleted.fields, fields);

console.log('All assertions passed: conditional field relationships stay consistent.');
