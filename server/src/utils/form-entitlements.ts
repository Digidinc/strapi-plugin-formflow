import type { FormField } from '../services/form';
import { isAllowedUnentitledConditionalTransition } from './conditional-config';

export interface EntitlementField {
  id?: string;
  type?: string;
  name?: string;
  conditional?: unknown;
}

export interface EntitlementSettings {
  layout?: string;
  steps?: unknown[];
  customCss?: string;
}

export interface OldForm {
  settings?: EntitlementSettings;
  fields?: EntitlementField[];
  requiresApproval?: boolean;
  locales?: Record<string, unknown>;
}

export interface NewFormData {
  settings?: EntitlementSettings;
  fields?: EntitlementField[];
  requiresApproval?: boolean;
  locales?: Record<string, unknown>;
}

export interface FormEntitlementBlock {
  entitled: false;
  feature: string;
}

const PRO_FIELD_TYPES = new Set([
  'signature',
  'rating',
  'address',
  'richtext',
  'calculated',
  'payment',
]);

const providedIdCounts = (fields: EntitlementField[]): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const field of fields) {
    if (typeof field.id !== 'string') continue;
    counts.set(field.id, (counts.get(field.id) ?? 0) + 1);
  }

  return counts;
};

export function findFormEntitlementBlock(
  oldForm: OldForm | null,
  newData: NewFormData,
  can: (feature: string) => boolean
): FormEntitlementBlock | null {
  const safeCan = (feature: string): boolean => {
    try {
      return can(feature) === true;
    } catch {
      return false;
    }
  };

  const oldSettings = oldForm?.settings ?? {};
  const newSettings = newData.settings ?? {};
  const oldFields = oldForm?.fields ?? [];
  const fieldsWereProvided = Array.isArray(newData.fields);
  const newFields = fieldsWereProvided ? newData.fields! : [];

  if (!safeCan('multistep')) {
    const switchingToMultiStep =
      newSettings.layout === 'multi-step' && oldSettings.layout !== 'multi-step';
    const addingSteps =
      Array.isArray(newSettings.steps) &&
      newSettings.steps.length > (oldSettings.steps?.length ?? 0);
    if (switchingToMultiStep || addingSteps) {
      return { entitled: false, feature: 'multistep' };
    }
  }

  if (
    fieldsWereProvided &&
    !safeCan('conditionalLogic') &&
    !isAllowedUnentitledConditionalTransition(oldFields as FormField[], newFields as FormField[])
  ) {
    return { entitled: false, feature: 'conditionalLogic' };
  }

  const oldIdCounts = providedIdCounts(oldFields);
  const newIdCounts = providedIdCounts(newFields);
  const oldFieldTypeById = new Map<string, string | undefined>();
  for (const field of oldFields) {
    if (typeof field.id === 'string') {
      oldFieldTypeById.set(field.id, field.type);
    }
  }

  const existingTypeFor = (field: EntitlementField): string | undefined => {
    if (
      typeof field.id !== 'string' ||
      oldIdCounts.get(field.id) !== 1 ||
      newIdCounts.get(field.id) !== 1
    ) {
      return undefined;
    }

    return oldFieldTypeById.get(field.id);
  };

  for (const field of newFields) {
    if (!PRO_FIELD_TYPES.has(field.type ?? '')) continue;
    const existingType = existingTypeFor(field);
    if (existingType !== field.type && !safeCan(`fields.${field.type}`)) {
      return { entitled: false, feature: `fields.${field.type}` };
    }
  }

  if (!safeCan('compliance.consent')) {
    for (const field of newFields) {
      if (field.type !== 'consent') continue;
      const existingType = existingTypeFor(field);
      if (existingType !== 'consent') {
        return { entitled: false, feature: 'compliance.consent' };
      }
    }
  }

  if (!safeCan('whiteLabel')) {
    const oldCss = oldSettings.customCss ?? '';
    const newCss = newSettings.customCss ?? '';
    if (newCss.trim() !== '' && oldCss.trim() === '') {
      return { entitled: false, feature: 'whiteLabel' };
    }
  }

  if (
    !safeCan('approval') &&
    newData.requiresApproval === true &&
    oldForm?.requiresApproval !== true
  ) {
    return { entitled: false, feature: 'approval' };
  }

  if (!safeCan('multiLanguage')) {
    const oldHasLocales = Object.keys(oldForm?.locales ?? {}).length > 0;
    const newHasLocales = newData.locales != null && Object.keys(newData.locales).length > 0;
    if (newHasLocales && !oldHasLocales) {
      return { entitled: false, feature: 'multiLanguage' };
    }
  }

  return null;
}
