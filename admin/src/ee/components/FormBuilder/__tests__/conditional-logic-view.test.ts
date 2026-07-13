/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';

import {
  resolveConditionalLogicBody,
  type ConditionalLogicBody,
  type ConditionalLogicViewInput,
} from '../conditional-logic-view';

const sourceFields = [{ name: 'customer_type' }];
const replacementFields = [{ name: 'country' }];
const validRule = {
  field: 'customer_type',
  operator: 'equals' as const,
  value: 'business',
};
const danglingRule = {
  field: 'missing_source',
  operator: 'equals' as const,
  value: 'business',
};

const cases: Array<{
  name: string;
  input: ConditionalLogicViewInput;
  expected: ConditionalLogicBody;
}> = [
  {
    name: 'checking dominates a stored dangling rule and missing sources',
    input: { access: 'checking', conditional: danglingRule, conditionSourceFields: [] },
    expected: 'checking',
  },
  {
    name: 'unavailable dominates an otherwise editable valid rule',
    input: { access: 'unavailable', conditional: validRule, conditionSourceFields: sourceFields },
    expected: 'unavailable',
  },
  {
    name: 'unentitled existing valid rule is read only',
    input: { access: 'unentitled', conditional: validRule, conditionSourceFields: sourceFields },
    expected: 'readonly-rule',
  },
  {
    name: 'unentitled existing rule dominates dangling repair',
    input: {
      access: 'unentitled',
      conditional: danglingRule,
      conditionSourceFields: replacementFields,
    },
    expected: 'readonly-rule',
  },
  {
    name: 'entitled dangling rule without a replacement source is static',
    input: { access: 'entitled', conditional: danglingRule, conditionSourceFields: [] },
    expected: 'dangling-readonly',
  },
  {
    name: 'entitled dangling rule with a replacement source is repairable',
    input: {
      access: 'entitled',
      conditional: danglingRule,
      conditionSourceFields: replacementFields,
    },
    expected: 'repair-rule',
  },
  {
    name: 'unentitled field without sources gets the combined prerequisite upsell',
    input: { access: 'unentitled', conditional: undefined, conditionSourceFields: [] },
    expected: 'prerequisite-upsell',
  },
  {
    name: 'entitled field without sources gets the prerequisite',
    input: { access: 'entitled', conditional: undefined, conditionSourceFields: [] },
    expected: 'prerequisite',
  },
  {
    name: 'unentitled field with sources gets the ordinary upsell',
    input: {
      access: 'unentitled',
      conditional: undefined,
      conditionSourceFields: sourceFields,
    },
    expected: 'upsell',
  },
  {
    name: 'entitled field with a valid rule gets the editor',
    input: { access: 'entitled', conditional: validRule, conditionSourceFields: sourceFields },
    expected: 'editor',
  },
  {
    name: 'entitled field with sources and no rule gets the editor toggle',
    input: { access: 'entitled', conditional: undefined, conditionSourceFields: sourceFields },
    expected: 'editor',
  },
];

for (const testCase of cases) {
  assert.equal(resolveConditionalLogicBody(testCase.input), testCase.expected, testCase.name);
}

console.log('All assertions passed: conditional logic body priority is deterministic.');
