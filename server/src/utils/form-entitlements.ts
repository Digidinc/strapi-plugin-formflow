import { isDeepStrictEqual } from 'node:util';

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
  emailNotifications?: unknown[];
  webhooks?: unknown[];
  spam?: Record<string, unknown>;
  integrations?: unknown[];
  [key: string]: unknown;
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
  requiredTier: FormEntitlementTier;
}

export type FormEntitlementTier = 'pro' | 'business';

const PRO_FIELD_TYPES = new Set([
  'signature',
  'rating',
  'address',
  'richtext',
  'calculated',
  'payment',
]);

const EMAIL_PREMIUM_KEYS = new Set([
  'replyTo',
  'template',
  'isAutoresponder',
  'toField',
  'omitBranding',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const blocked = (
  feature: string,
  requiredTier: FormEntitlementTier = 'pro'
): FormEntitlementBlock => ({ entitled: false, feature, requiredTier });

const isDeepEqualRetainedRecord = (oldValue: unknown, newValue: unknown): boolean => {
  if (isDeepStrictEqual(oldValue, newValue)) return true;
  if (!isRecord(oldValue) || !isRecord(newValue) || hasOwn(oldValue, 'id')) return false;
  if (typeof newValue.id !== 'string' || newValue.id === '') return false;

  const { id: _generatedId, ...newWithoutGeneratedId } = newValue;
  return isDeepStrictEqual(oldValue, newWithoutGeneratedId);
};

const isOrderedDeepEqualSubsequence = (
  oldEntries: unknown[],
  newEntries: unknown[],
  equals: (oldValue: unknown, newValue: unknown) => boolean = isDeepStrictEqual
): boolean => {
  let oldIndex = 0;

  for (const newEntry of newEntries) {
    let matchIndex = -1;
    for (let index = oldIndex; index < oldEntries.length; index += 1) {
      if (equals(oldEntries[index], newEntry)) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex === -1) return false;
    oldIndex = matchIndex + 1;
  }

  return true;
};

const emailFreeProjection = (notification: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(notification).filter(([key]) => !EMAIL_PREMIUM_KEYS.has(key)));

const emailPremiumProjection = (notification: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(notification).filter(([key]) => EMAIL_PREMIUM_KEYS.has(key)));

const storedId = (value: Record<string, unknown>): string | undefined =>
  typeof value.id === 'string' && value.id !== '' ? value.id : undefined;

interface NotificationPair {
  oldNotification: Record<string, unknown> | undefined;
  newNotification: Record<string, unknown>;
}

const matchAdditionalNotifications = (
  oldNotifications: unknown[],
  newNotifications: unknown[]
): NotificationPair[] | null => {
  const oldAdditional = oldNotifications.slice(1);
  const newAdditional = newNotifications.slice(1);
  const matches: NotificationPair[] = [];
  let oldIndex = 0;

  for (const newValue of newAdditional) {
    if (!isRecord(newValue)) return null;

    let matchIndex = -1;
    for (let index = oldIndex; index < oldAdditional.length; index += 1) {
      const oldValue = oldAdditional[index];
      if (!isRecord(oldValue)) continue;

      const oldId = storedId(oldValue);
      const newId = storedId(newValue);
      const identityMatches =
        oldId !== undefined
          ? oldId === newId
          : !hasOwn(oldValue, 'id')
            ? true
            : newId === undefined;
      if (
        identityMatches &&
        isDeepEqualRetainedRecord(emailFreeProjection(oldValue), emailFreeProjection(newValue))
      ) {
        matchIndex = index;
        matches.push({ oldNotification: oldValue, newNotification: newValue });
        break;
      }
    }

    if (matchIndex === -1) return null;
    oldIndex = matchIndex + 1;
  }

  return matches;
};

const pairNotifications = (
  oldNotifications: unknown[],
  newNotifications: unknown[],
  additionalMatches: NotificationPair[] | null
): NotificationPair[] => {
  const oldRecords = oldNotifications.filter(isRecord);
  const oldPromotionRecords =
    newNotifications.length < oldNotifications.length
      ? oldNotifications.slice(1).filter(isRecord)
      : [];
  const reservedAdditionalByIndex = new Map<number, Record<string, unknown>>();
  for (const [matchIndex, match] of (additionalMatches ?? []).entries()) {
    if (match.oldNotification) {
      reservedAdditionalByIndex.set(matchIndex + 1, match.oldNotification);
    }
  }
  const usedOldNotifications = new Set(reservedAdditionalByIndex.values());

  return newNotifications.flatMap((newValue, index) => {
    if (!isRecord(newValue)) return [];

    const orderedMatch = reservedAdditionalByIndex.get(index);
    if (orderedMatch) {
      return [{ oldNotification: orderedMatch, newNotification: newValue }];
    }

    const availableOldRecords = oldRecords.filter(
      (candidate) => !usedOldNotifications.has(candidate)
    );
    const availablePromotionRecords = oldPromotionRecords.filter(
      (candidate) => !usedOldNotifications.has(candidate)
    );
    const newId = storedId(newValue);
    const oldAtIndex = oldNotifications[index];
    const persistedIdMatch =
      newId === undefined
        ? undefined
        : availableOldRecords.find((candidate) => storedId(candidate) === newId);
    const legacyExactCandidates = availableOldRecords.filter(
      (candidate) => !hasOwn(candidate, 'id') && isDeepEqualRetainedRecord(candidate, newValue)
    );
    const legacyFreeCandidates = availableOldRecords.filter(
      (candidate) =>
        !hasOwn(candidate, 'id') &&
        isDeepEqualRetainedRecord(emailFreeProjection(candidate), emailFreeProjection(newValue))
    );
    const legacyPremiumCandidates = availablePromotionRecords.filter(
      (candidate) =>
        !hasOwn(candidate, 'id') &&
        isDeepStrictEqual(emailPremiumProjection(candidate), emailPremiumProjection(newValue))
    );
    const legacyFirstFallback =
      index === 0 &&
      newNotifications.length >= oldNotifications.length &&
      persistedIdMatch === undefined &&
      isRecord(oldAtIndex) &&
      !hasOwn(oldAtIndex, 'id') &&
      !usedOldNotifications.has(oldAtIndex)
        ? oldAtIndex
        : undefined;
    const oldNotification =
      persistedIdMatch ??
      (index === 0 && legacyExactCandidates.length === 1 ? legacyExactCandidates[0] : undefined) ??
      (index === 0 && legacyFreeCandidates.length === 1 ? legacyFreeCandidates[0] : undefined) ??
      (index === 0 ? legacyPremiumCandidates[0] : undefined) ??
      legacyFirstFallback;
    if (oldNotification) usedOldNotifications.add(oldNotification);

    return [{ oldNotification, newNotification: newValue }];
  });
};

const isClearedText = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

const allowsDisableOnly = (oldValue: unknown, newValue: unknown): boolean => {
  if (newValue === undefined || newValue === null) return true;
  if (!isRecord(newValue) || !isRecord(oldValue)) return false;
  if (isDeepStrictEqual(oldValue, newValue)) return true;
  if (oldValue.enabled !== true || newValue.enabled !== false) return false;

  const { enabled: _oldEnabled, ...oldRemainder } = oldValue;
  const { enabled: _newEnabled, ...newRemainder } = newValue;
  return isDeepStrictEqual(oldRemainder, newRemainder);
};

const allowsRecaptchaV3Transition = (oldValue: unknown, newValue: unknown): boolean => {
  if (!isRecord(newValue) || newValue.version !== 'v3') return true;
  if (!isRecord(oldValue) || oldValue.version !== 'v3') return false;
  return allowsDisableOnly(oldValue, newValue);
};

const allowsPropertyRemovalOnly = (oldValue: unknown, newValue: unknown): boolean => {
  if (newValue === undefined || newValue === null) return true;
  if (!isRecord(newValue) || !isRecord(oldValue)) return false;

  return Object.entries(newValue).every(
    ([key, value]) => hasOwn(oldValue, key) && isDeepStrictEqual(oldValue[key], value)
  );
};

const stepsAfterDeletedFields = (
  oldSteps: unknown[],
  oldFields: EntitlementField[],
  newFields: EntitlementField[],
  fieldsWereProvided: boolean
): unknown[] => {
  if (!fieldsWereProvided) return oldSteps;

  const newFieldIds = new Set(
    newFields.flatMap((field) => (typeof field.id === 'string' ? [field.id] : []))
  );
  const deletedFieldIds = new Set(
    oldFields.flatMap((field) =>
      typeof field.id === 'string' && !newFieldIds.has(field.id) ? [field.id] : []
    )
  );
  if (deletedFieldIds.size === 0) return oldSteps;

  return oldSteps.map((step) => {
    if (!isRecord(step) || !Array.isArray(step.fields)) return step;
    return {
      ...step,
      fields: step.fields.filter(
        (fieldId) => typeof fieldId !== 'string' || !deletedFieldIds.has(fieldId)
      ),
    };
  });
};

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

  const settingsWereProvided = hasOwn(newData, 'settings');
  const oldSettings = asRecord(oldForm?.settings);
  const newSettings = settingsWereProvided ? asRecord(newData.settings) : {};
  const oldFields = oldForm?.fields ?? [];
  const fieldsWereProvided = Array.isArray(newData.fields);
  const newFields = fieldsWereProvided ? newData.fields! : [];

  if (settingsWereProvided && !safeCan('multistep')) {
    const oldIsMultiStep = oldSettings.layout === 'multi-step';
    const newIsMultiStep = newSettings.layout === 'multi-step';
    if (newIsMultiStep) {
      const oldSteps = asArray(oldSettings.steps);
      const expectedSteps = stepsAfterDeletedFields(
        oldSteps,
        oldFields,
        newFields,
        fieldsWereProvided
      );
      if (!oldIsMultiStep || !isDeepStrictEqual(expectedSteps, asArray(newSettings.steps))) {
        return blocked('multistep');
      }
    }
  }

  if (
    fieldsWereProvided &&
    !safeCan('conditionalLogic') &&
    !isAllowedUnentitledConditionalTransition(oldFields as FormField[], newFields as FormField[])
  ) {
    return blocked('conditionalLogic');
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
      return blocked(`fields.${field.type}`);
    }
  }

  if (!safeCan('compliance.consent')) {
    for (const field of newFields) {
      if (field.type !== 'consent') continue;
      const existingType = existingTypeFor(field);
      if (existingType !== 'consent') {
        return blocked('compliance.consent', 'business');
      }
    }
  }

  if (settingsWereProvided) {
    const oldWebhooks = asArray(oldSettings.webhooks);
    const newWebhooks = asArray(newSettings.webhooks);
    if (
      !safeCan('webhooks') &&
      !isOrderedDeepEqualSubsequence(oldWebhooks, newWebhooks, isDeepEqualRetainedRecord)
    ) {
      return blocked('webhooks');
    }

    const oldNotifications = asArray(oldSettings.emailNotifications);
    const newNotifications = asArray(newSettings.emailNotifications);
    const additionalNotificationMatches = matchAdditionalNotifications(
      oldNotifications,
      newNotifications
    );
    if (!safeCan('email.advanced') && additionalNotificationMatches === null) {
      return blocked('email.advanced');
    }

    const notificationPairs = pairNotifications(
      oldNotifications,
      newNotifications,
      additionalNotificationMatches
    );
    if (!safeCan('email.customTemplate')) {
      for (const { oldNotification, newNotification } of notificationPairs) {
        for (const key of ['replyTo', 'template'] as const) {
          const oldValue = oldNotification?.[key];
          const newValue = newNotification[key];
          if (!isDeepStrictEqual(oldValue, newValue) && !isClearedText(newValue)) {
            return blocked('email.customTemplate');
          }
        }
      }
    }

    if (!safeCan('email.autoresponder')) {
      for (const { oldNotification, newNotification } of notificationPairs) {
        const autoresponderChanged =
          !isDeepStrictEqual(oldNotification?.isAutoresponder, newNotification.isAutoresponder) ||
          !isDeepStrictEqual(oldNotification?.toField, newNotification.toField);
        const isCleaned =
          (newNotification.isAutoresponder === false ||
            newNotification.isAutoresponder === undefined ||
            newNotification.isAutoresponder === null) &&
          isClearedText(newNotification.toField);
        if (autoresponderChanged && !isCleaned) {
          return blocked('email.autoresponder');
        }
      }
    }

    if (!safeCan('email.whiteLabel')) {
      for (const { oldNotification, newNotification } of notificationPairs) {
        const newValue = newNotification.omitBranding;
        if (
          !isDeepStrictEqual(oldNotification?.omitBranding, newValue) &&
          newValue !== false &&
          newValue !== undefined &&
          newValue !== null
        ) {
          return blocked('email.whiteLabel');
        }
      }
    }

    const oldSpam = asRecord(oldSettings.spam);
    const newSpam = asRecord(newSettings.spam);
    if (
      !safeCan('spam.recaptchaV3') &&
      !allowsRecaptchaV3Transition(oldSpam.recaptcha, newSpam.recaptcha)
    ) {
      return blocked('spam.recaptchaV3');
    }
    for (const [property, feature] of [
      ['turnstile', 'spam.turnstile'],
      ['hcaptcha', 'spam.hcaptcha'],
    ] as const) {
      if (!safeCan(feature) && !allowsDisableOnly(oldSpam[property], newSpam[property])) {
        return blocked(feature);
      }
    }
    if (
      !safeCan('spam.ipBlocklist') &&
      !allowsPropertyRemovalOnly(oldSpam.ipBlocklist, newSpam.ipBlocklist)
    ) {
      return blocked('spam.ipBlocklist');
    }

    const oldIntegrations = asArray(oldSettings.integrations);
    const newIntegrations = asArray(newSettings.integrations);
    if (
      !safeCan('integrations') &&
      !isOrderedDeepEqualSubsequence(oldIntegrations, newIntegrations)
    ) {
      return blocked('integrations');
    }

    if (!safeCan('whiteLabel')) {
      const oldCss = typeof oldSettings.customCss === 'string' ? oldSettings.customCss : '';
      const newCss = typeof newSettings.customCss === 'string' ? newSettings.customCss : '';
      if (newCss.trim() !== '' && newCss !== oldCss) {
        return blocked('whiteLabel');
      }
    }
  }

  if (
    hasOwn(newData, 'requiresApproval') &&
    !safeCan('approval') &&
    newData.requiresApproval === true &&
    oldForm?.requiresApproval !== true
  ) {
    return blocked('approval', 'business');
  }

  if (hasOwn(newData, 'locales') && !safeCan('multiLanguage')) {
    const oldLocales = asRecord(oldForm?.locales);
    const newLocales = asRecord(newData.locales);
    const changesRetainedOrAddsLocale = Object.entries(newLocales).some(
      ([locale, content]) =>
        !hasOwn(oldLocales, locale) || !isDeepStrictEqual(oldLocales[locale], content)
    );
    if (changesRetainedOrAddsLocale) {
      return blocked('multiLanguage', 'business');
    }
  }

  return null;
}
