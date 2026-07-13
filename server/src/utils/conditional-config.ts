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

  const fieldByName = new Map<string, FormField>();
  for (const field of validFields) {
    if ((nameCounts.get(field.name) ?? 0) === 1) {
      fieldByName.set(field.name, field);
    }
  }

  const edges = new Map<string, string>();

  for (const field of validFields) {
    const rawRule = field.conditional as unknown;
    if (rawRule === undefined || rawRule === null) continue;

    const rule = isRecord(rawRule) ? rawRule : null;
    const sourceName = rule && typeof rule.field === 'string' ? rule.field : '';
    const operator = rule && typeof rule.operator === 'string' ? rule.operator : '';
    const source = sourceName ? fieldByName.get(sourceName) : undefined;

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
    } else if (source.id === field.id) {
      issues.push(issue(field, 'self_reference', 'A field cannot depend on itself.'));
      validEdge = false;
    } else if (isLayoutField(source.type)) {
      issues.push(
        issue(
          field,
          'layout_source',
          `Layout field "${source.name}" cannot be a conditional source.`
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
      edges.set(field.id, source.id);
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycleIds = new Set<string>();

  const visit = (fieldId: string): void => {
    state.set(fieldId, 'visiting');
    stack.push(fieldId);

    const sourceId = edges.get(fieldId);
    if (sourceId) {
      const sourceState = state.get(sourceId);
      if (sourceState === undefined) {
        visit(sourceId);
      } else if (sourceState === 'visiting') {
        const cycleStart = stack.indexOf(sourceId);
        for (const cycleId of stack.slice(cycleStart)) {
          cycleIds.add(cycleId);
        }
      }
    }

    stack.pop();
    state.set(fieldId, 'visited');
  };

  for (const field of validFields) {
    if (state.get(field.id) === undefined) {
      visit(field.id);
    }
  }

  for (const field of validFields) {
    if (cycleIds.has(field.id)) {
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
