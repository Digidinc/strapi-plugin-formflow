import { isDeepStrictEqual } from 'node:util';

import type { FormField } from '../services/form';
import { isLayoutField } from './validation-rules';

export interface ConditionalConfigIssue {
  fieldId?: string;
  fieldName?: string;
  code:
    | 'missing_source'
    | 'self_reference'
    | 'layout_source'
    | 'unsupported_operator'
    | 'cycle'
    | 'duplicate_name';
  message: string;
}

const SUPPORTED_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const runtimeFields = (fields: FormField[]): FormField[] =>
  fields.filter((field) => isRecord(field)) as FormField[];

export function hasDuplicateProvidedFieldIds(fields: Array<{ id?: unknown }>): boolean {
  const seenIds = new Set<string>();

  for (const field of fields) {
    if (typeof field.id !== 'string') continue;
    if (seenIds.has(field.id)) return true;
    seenIds.add(field.id);
  }

  return false;
}

const issue = (
  field: FormField,
  code: ConditionalConfigIssue['code'],
  message: string
): ConditionalConfigIssue => ({
  fieldId: field.id,
  fieldName: field.name,
  code,
  message,
});

export function validateConditionalConfig(fields: FormField[]): ConditionalConfigIssue[] {
  const validFields = runtimeFields(fields);
  const issues: ConditionalConfigIssue[] = [];
  const nameCounts = new Map<string, number>();

  for (const field of validFields) {
    nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1);
  }

  for (const field of validFields) {
    if ((nameCounts.get(field.name) ?? 0) > 1) {
      issues.push(issue(field, 'duplicate_name', `Field name "${field.name}" must be unique.`));
    }
  }

  const fieldByName = new Map<string, { field: FormField; index: number }>();
  for (const [fieldIndex, field] of validFields.entries()) {
    if ((nameCounts.get(field.name) ?? 0) === 1) {
      fieldByName.set(field.name, { field, index: fieldIndex });
    }
  }

  const edges = new Map<number, number>();

  for (const [fieldIndex, field] of validFields.entries()) {
    const rawRule = field.conditional as unknown;
    if (rawRule === undefined || rawRule === null) continue;

    const rule = isRecord(rawRule) ? rawRule : null;
    const sourceName = rule && typeof rule.field === 'string' ? rule.field : '';
    const source = sourceName ? fieldByName.get(sourceName) : undefined;
    const operator = rule && typeof rule.operator === 'string' ? rule.operator : '';

    let validEdge = true;
    if (!source) {
      issues.push(
        issue(
          field,
          'missing_source',
          sourceName
            ? `Conditional source field "${sourceName}" does not exist.`
            : 'Conditional source field is missing.'
        )
      );
      validEdge = false;
    } else if (source.index === fieldIndex) {
      issues.push(issue(field, 'self_reference', 'A field cannot depend on itself.'));
      validEdge = false;
    } else if (isLayoutField(source.field.type)) {
      issues.push(
        issue(
          field,
          'layout_source',
          `Layout field "${source.field.name}" cannot be a conditional source.`
        )
      );
      validEdge = false;
    }

    if (!SUPPORTED_OPERATORS.has(operator)) {
      issues.push(
        issue(
          field,
          'unsupported_operator',
          operator
            ? `Conditional operator "${operator}" is not supported.`
            : 'Conditional operator is missing.'
        )
      );
      validEdge = false;
    }

    if (validEdge && source) {
      edges.set(fieldIndex, source.index);
    }
  }

  const state = new Map<number, 'visiting' | 'visited'>();
  const stack: number[] = [];
  const cycleIndices = new Set<number>();

  const visit = (fieldIndex: number): void => {
    state.set(fieldIndex, 'visiting');
    stack.push(fieldIndex);

    const sourceIndex = edges.get(fieldIndex);
    if (sourceIndex !== undefined) {
      const sourceState = state.get(sourceIndex);
      if (sourceState === undefined) {
        visit(sourceIndex);
      } else if (sourceState === 'visiting') {
        const cycleStart = stack.indexOf(sourceIndex);
        for (const cycleIndex of stack.slice(cycleStart)) {
          cycleIndices.add(cycleIndex);
        }
      }
    }

    stack.pop();
    state.set(fieldIndex, 'visited');
  };

  for (const [fieldIndex] of validFields.entries()) {
    if (state.get(fieldIndex) === undefined) {
      visit(fieldIndex);
    }
  }

  for (const [fieldIndex, field] of validFields.entries()) {
    if (cycleIndices.has(fieldIndex)) {
      issues.push(issue(field, 'cycle', 'Conditional rules cannot form a cycle.'));
    }
  }

  return issues;
}

export function newConditionalConfigIssues(
  oldFields: FormField[],
  newFields: FormField[]
): ConditionalConfigIssue[] {
  const oldIssues = validateConditionalConfig(oldFields);
  const newIssues = validateConditionalConfig(newFields);
  const oldFieldById = new Map(runtimeFields(oldFields).map((field) => [field.id, field] as const));
  const newFieldById = new Map(runtimeFields(newFields).map((field) => [field.id, field] as const));

  return newIssues.filter((newIssue) => {
    const existed = oldIssues.some(
      (oldIssue) => oldIssue.fieldId === newIssue.fieldId && oldIssue.code === newIssue.code
    );
    if (!existed) return true;

    const oldRule = newIssue.fieldId ? oldFieldById.get(newIssue.fieldId)?.conditional : undefined;
    const newRule = newIssue.fieldId ? newFieldById.get(newIssue.fieldId)?.conditional : undefined;
    return !isDeepStrictEqual(oldRule, newRule);
  });
}

const uniqueFieldByName = (fields: FormField[]): Map<string, FormField> => {
  const fieldsByName = new Map<string, FormField[]>();
  for (const field of runtimeFields(fields)) {
    const matches = fieldsByName.get(field.name) ?? [];
    matches.push(field);
    fieldsByName.set(field.name, matches);
  }

  return new Map(
    [...fieldsByName.entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([name, matches]) => [name, matches[0]])
  );
};

const hasNonBijectiveConditionalIdentity = (fields: FormField[]): boolean => {
  const validFields = runtimeFields(fields);
  const idCounts = new Map<string, number>();
  const conditionalIdentityIds = new Set<string>();

  for (const field of validFields) {
    if (typeof field.id === 'string') {
      idCounts.set(field.id, (idCounts.get(field.id) ?? 0) + 1);
    }
  }

  for (const target of validFields) {
    const rule = target.conditional as unknown;
    if (rule === undefined || rule === null) continue;

    if (typeof target.id !== 'string') return true;
    conditionalIdentityIds.add(target.id);
    if (!isRecord(rule) || typeof rule.field !== 'string') continue;

    for (const source of validFields) {
      if (source.name !== rule.field) continue;
      if (typeof source.id !== 'string') return true;
      conditionalIdentityIds.add(source.id);
    }
  }

  return [...conditionalIdentityIds].some((fieldId) => idCounts.get(fieldId) !== 1);
};

const isSourceRenameOnly = (
  oldRule: unknown,
  newRule: unknown,
  oldFields: FormField[],
  newFields: FormField[]
): boolean => {
  if (!isRecord(oldRule) || !isRecord(newRule)) return false;
  if (typeof oldRule.field !== 'string' || typeof newRule.field !== 'string') return false;
  if (oldRule.field === newRule.field) return false;

  const { field: _oldField, ...oldRuleRemainder } = oldRule;
  const { field: _newField, ...newRuleRemainder } = newRule;
  if (!isDeepStrictEqual(oldRuleRemainder, newRuleRemainder)) return false;

  const oldSource = uniqueFieldByName(oldFields).get(oldRule.field);
  const newSource = uniqueFieldByName(newFields).get(newRule.field);
  if (!oldSource || !newSource || oldSource.id !== newSource.id) return false;

  return oldSource.name === oldRule.field && newSource.name === newRule.field;
};

export function isAllowedUnentitledConditionalTransition(
  oldFields: FormField[],
  newFields: FormField[]
): boolean {
  const validOldFields = runtimeFields(oldFields);
  const validNewFields = runtimeFields(newFields);
  if (
    hasNonBijectiveConditionalIdentity(validOldFields) ||
    hasNonBijectiveConditionalIdentity(validNewFields)
  ) {
    return false;
  }

  const oldFieldById = new Map(validOldFields.map((field) => [field.id, field] as const));

  for (const newField of validNewFields) {
    const newRule = newField.conditional as unknown;
    if (newRule === undefined || newRule === null) continue;

    const oldRule = oldFieldById.get(newField.id)?.conditional as unknown;
    if (oldRule === undefined || oldRule === null) return false;
    if (isDeepStrictEqual(oldRule, newRule)) continue;
    if (isSourceRenameOnly(oldRule, newRule, validOldFields, validNewFields)) continue;
    return false;
  }

  return true;
}
