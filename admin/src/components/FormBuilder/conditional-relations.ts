import type { FormField } from '../../utils/api';

export function conditionalDependents(fields: FormField[], sourceName: string): FormField[] {
  return fields.filter((field) => field.conditional?.field === sourceName);
}

export function renameFieldAndCascade(
  fields: FormField[],
  fieldId: string,
  nextName: string
): FormField[] {
  const source = fields.find((field) => field.id === fieldId);
  if (!source) return [...fields];

  return fields.map((field) => {
    const isSource = field.id === fieldId;
    const isDependent = field.conditional?.field === source.name;
    if (!isSource && !isDependent) return field;

    const renamedField: FormField = isSource ? { ...field, name: nextName } : field;
    return isDependent
      ? {
          ...renamedField,
          conditional: {
            ...field.conditional!,
            field: nextName,
          },
        }
      : renamedField;
  });
}

export function deleteFieldAndConditions(
  fields: FormField[],
  fieldId: string
): { fields: FormField[]; affected: FormField[] } {
  const source = fields.find((field) => field.id === fieldId);
  if (!source) return { fields: [...fields], affected: [] };

  const affected = conditionalDependents(fields, source.name).filter(
    (field) => field.id !== fieldId
  );
  const affectedIds = new Set(affected.map((field) => field.id));

  return {
    affected,
    fields: fields.flatMap((field) => {
      if (field.id === fieldId) return [];
      if (!affectedIds.has(field.id)) return [field];

      const { conditional: _conditional, ...fieldWithoutConditional } = field;
      return [fieldWithoutConditional];
    }),
  };
}
