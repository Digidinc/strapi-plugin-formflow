import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  IconButton,
  Field,
  TextInput,
  Textarea,
  Divider,
} from '@strapi/design-system';
import { Plus, Trash } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { getTranslation } from '../../utils/getTranslation';
import type {
  FormField,
  FormLocales,
  FormLocaleContent,
  FieldLocaleOverride,
} from '../../utils/api';
import { useLicense } from '../../ee/hooks/useLicense';
import { premiumMutationPolicy } from '../../ee/license-state';
import { LockedSection } from '../../ee/components/LockedSection';
import { LicenseStatusNotice } from '../../ee/components/LicenseStatusNotice';
import { UpsellCard } from '../../ee/components/UpsellCard';
import { SectionHeading } from '../shared';

export interface LocalesEditorProps {
  /** The form's fields — drives which fields/options can be overridden. */
  fields: FormField[];
  /** Current `locales` map (locale code -> per-locale content). */
  locales: FormLocales;
  /** Persist the updated `locales` map up to the page's form state. */
  onChange: (locales: FormLocales) => void;
}

/**
 * Normalize a user-typed locale code: lowercase, trimmed. Kept permissive
 * (e.g. `fr`, `de`, `pt-br`) since the public schema looks up the requested
 * `?locale=` verbatim against these keys.
 */
const normalizeLocaleCode = (raw: string): string => raw.trim().toLowerCase();

/**
 * Fields whose UI content can be localized. Layout-only fields (heading/
 * paragraph/divider) carry no submitter-facing label/placeholder worth
 * translating, but they DO have a `label`, so we keep all fields except
 * pure dividers to stay simple and predictable.
 */
const isLocalizableField = (field: FormField): boolean => field.type !== 'divider';

/**
 * LocalesEditor — authoring UI for a form's `locales` translation map (Business
 * multi-language). For each added locale code, an admin can override each
 * field's label/placeholder/description, per-option labels for choice fields,
 * and a form-level success message. The emitted shape matches exactly what the
 * server's `getPublicSchema` consumes when serving `?locale=<code>`.
 *
 * Gating: editing follows explicit `multiLanguage` access. Resolved unentitled
 * access shows the upsell; unavailable access shows the status notice; an
 * unresolved check shows nothing at all.
 * Existing locale data remains readable and is never stripped (the server
 * save-gate is the authoritative enforcement point).
 */
export const LocalesEditor = ({ fields, locales, onChange }: LocalesEditorProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const multiLanguageAccess = access('multiLanguage');
  const multiLanguagePolicy = premiumMutationPolicy(multiLanguageAccess);

  const [newLocaleCode, setNewLocaleCode] = useState('');

  const localeCodes = useMemo(() => Object.keys(locales).sort(), [locales]);
  const localizableFields = useMemo(() => fields.filter(isLocalizableField), [fields]);

  const addLocale = useCallback(() => {
    const code = normalizeLocaleCode(newLocaleCode);
    if (!code || locales[code]) {
      return;
    }
    onChange({ ...locales, [code]: {} });
    setNewLocaleCode('');
  }, [newLocaleCode, locales, onChange]);

  const removeLocale = useCallback(
    (code: string) => {
      if (!multiLanguagePolicy.canRemove) return;
      const next = { ...locales };
      delete next[code];
      onChange(next);
    },
    [locales, multiLanguagePolicy.canRemove, onChange]
  );

  /** Merge a partial content patch into one locale and prune empty entries. */
  const updateLocale = useCallback(
    (code: string, patch: FormLocaleContent) => {
      const current = locales[code] ?? {};
      onChange({ ...locales, [code]: { ...current, ...patch } });
    },
    [locales, onChange]
  );

  /** Override a single property of a single field within one locale. */
  const updateFieldOverride = useCallback(
    (
      code: string,
      fieldId: string,
      key: keyof Omit<FieldLocaleOverride, 'options'>,
      value: string
    ) => {
      const current = locales[code] ?? {};
      const currentFields = current.fields ?? {};
      const fieldOverride = { ...(currentFields[fieldId] ?? {}) } as FieldLocaleOverride;
      if (value === '') {
        delete fieldOverride[key];
      } else {
        fieldOverride[key] = value;
      }
      onChange({
        ...locales,
        [code]: { ...current, fields: { ...currentFields, [fieldId]: fieldOverride } },
      });
    },
    [locales, onChange]
  );

  /**
   * Override a single option's label for a choice field within one locale.
   * Emits the full `options` array (value + localized label) the server merges
   * verbatim — so every option carries its (possibly default) label.
   */
  const updateOptionLabel = useCallback(
    (code: string, field: FormField, optionIndex: number, label: string) => {
      const current = locales[code] ?? {};
      const currentFields = current.fields ?? {};
      const fieldOverride = { ...(currentFields[field.id] ?? {}) } as FieldLocaleOverride;
      const baseOptions = field.options ?? [];
      const existing = fieldOverride.options;
      const nextOptions = baseOptions.map((opt, i) => ({
        value: opt.value,
        label: i === optionIndex ? label : (existing?.[i]?.label ?? opt.label),
      }));
      fieldOverride.options = nextOptions;
      onChange({
        ...locales,
        [code]: { ...current, fields: { ...currentFields, [field.id]: fieldOverride } },
      });
    },
    [locales, onChange]
  );

  const localeOverrideValue = (
    code: string,
    fieldId: string,
    key: keyof Omit<FieldLocaleOverride, 'options'>
  ): string => locales[code]?.fields?.[fieldId]?.[key] ?? '';

  const optionLabelValue = (
    code: string,
    field: FormField,
    optionIndex: number,
    defaultLabel: string
  ): string => locales[code]?.fields?.[field.id]?.options?.[optionIndex]?.label ?? defaultLabel;

  const header = (
    <SectionHeading
      title={formatMessage({
        id: getTranslation('translations.title'),
        defaultMessage: 'Translations',
      })}
      description={formatMessage({
        id: getTranslation('translations.subtitle'),
        defaultMessage:
          'Provide per-language overrides for field labels and messages. Consumed via the public API with ?locale=<code>.',
      })}
    />
  );

  /** The editable body — reused both entitled and (read-only) when locked. */
  const renderLocale = (code: string, disabled = false, canRemove = true) => (
    <Box
      key={code}
      padding={4}
      background="neutral0"
      hasRadius
      borderColor="neutral200"
      borderStyle="solid"
      borderWidth="1px"
    >
      <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
        <Typography variant="omega" fontWeight="bold">
          {code}
        </Typography>
        <IconButton
          label={formatMessage({
            id: getTranslation('translations.locale.remove'),
            defaultMessage: 'Remove locale',
          })}
          onClick={() => removeLocale(code)}
          disabled={!canRemove}
          variant="ghost"
        >
          <Trash />
        </IconButton>
      </Flex>

      <Flex direction="column" gap={4} alignItems="stretch">
        {/* Success message override */}
        <Field.Root name={`locale-${code}-successMessage`}>
          <Field.Label>
            {formatMessage({
              id: getTranslation('translations.successMessage.label'),
              defaultMessage: 'Success message',
            })}
          </Field.Label>
          <Textarea
            value={locales[code]?.successMessage ?? ''}
            readOnly={disabled}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              updateLocale(code, { successMessage: e.target.value || undefined })
            }
          />
        </Field.Root>

        <Divider />

        {localizableFields.length === 0 ? (
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('translations.noFields'),
              defaultMessage: 'Add fields to the form to translate their content.',
            })}
          </Typography>
        ) : (
          localizableFields.map((field) => (
            <Box
              key={field.id}
              padding={3}
              background="neutral100"
              hasRadius
              borderColor="neutral200"
              borderStyle="solid"
              borderWidth="1px"
            >
              <Typography variant="sigma" textColor="neutral800">
                {field.label || field.name}
              </Typography>

              <Flex direction="column" gap={3} alignItems="stretch" marginTop={3}>
                <Field.Root name={`locale-${code}-${field.id}-label`}>
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('translations.field.label'),
                      defaultMessage: 'Label',
                    })}
                  </Field.Label>
                  <TextInput
                    value={localeOverrideValue(code, field.id, 'label')}
                    placeholder={field.label}
                    readOnly={disabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateFieldOverride(code, field.id, 'label', e.target.value)
                    }
                  />
                </Field.Root>

                <Field.Root name={`locale-${code}-${field.id}-placeholder`}>
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('translations.field.placeholder'),
                      defaultMessage: 'Placeholder',
                    })}
                  </Field.Label>
                  <TextInput
                    value={localeOverrideValue(code, field.id, 'placeholder')}
                    placeholder={field.placeholder ?? ''}
                    readOnly={disabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateFieldOverride(code, field.id, 'placeholder', e.target.value)
                    }
                  />
                </Field.Root>

                <Field.Root name={`locale-${code}-${field.id}-description`}>
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('translations.field.description'),
                      defaultMessage: 'Description',
                    })}
                  </Field.Label>
                  <TextInput
                    value={localeOverrideValue(code, field.id, 'description')}
                    placeholder={field.description ?? ''}
                    readOnly={disabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateFieldOverride(code, field.id, 'description', e.target.value)
                    }
                  />
                </Field.Root>

                {field.options && field.options.length > 0 && (
                  <Box>
                    <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                      {formatMessage({
                        id: getTranslation('translations.field.options'),
                        defaultMessage: 'Option labels',
                      })}
                    </Typography>
                    <Flex direction="column" gap={2} alignItems="stretch" marginTop={2}>
                      {field.options.map((option, optionIndex) => (
                        <Field.Root
                          key={`${field.id}-option-${optionIndex}`}
                          name={`locale-${code}-${field.id}-option-${optionIndex}`}
                        >
                          <Field.Label>{option.value}</Field.Label>
                          <TextInput
                            value={optionLabelValue(code, field, optionIndex, '')}
                            placeholder={option.label}
                            readOnly={disabled}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              updateOptionLabel(code, field, optionIndex, e.target.value)
                            }
                          />
                        </Field.Root>
                      ))}
                    </Flex>
                  </Box>
                )}
              </Flex>
            </Box>
          ))
        )}
      </Flex>
    </Box>
  );

  const addLocaleRow = (
    <Flex gap={2} alignItems="flex-end">
      <Box flex="1">
        <Field.Root
          name="newLocaleCode"
          hint={formatMessage({
            id: getTranslation('translations.add.hint'),
            defaultMessage: 'Locale code, e.g. fr, de, pt-br',
          })}
        >
          <Field.Label>
            {formatMessage({
              id: getTranslation('translations.add.label'),
              defaultMessage: 'Add language',
            })}
          </Field.Label>
          <TextInput
            value={newLocaleCode}
            placeholder="fr"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewLocaleCode(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLocale();
              }
            }}
          />
          <Field.Hint />
        </Field.Root>
      </Box>
      <Button
        startIcon={<Plus />}
        variant="secondary"
        onClick={addLocale}
        disabled={
          normalizeLocaleCode(newLocaleCode) === '' ||
          Boolean(locales[normalizeLocaleCode(newLocaleCode)])
        }
      >
        {formatMessage({
          id: getTranslation('translations.add.button'),
          defaultMessage: 'Add',
        })}
      </Button>
    </Flex>
  );

  const renderLocalesList = (disabled = false, canRemove = true) =>
    localeCodes.length === 0 ? (
      <Box padding={6} background="neutral100" hasRadius>
        <Flex justifyContent="center">
          <Typography textColor="neutral600">
            {formatMessage({
              id: getTranslation('translations.empty'),
              defaultMessage: 'No translations configured',
            })}
          </Typography>
        </Flex>
      </Box>
    ) : (
      <Flex direction="column" gap={4} alignItems="stretch">
        {localeCodes.map((code) => renderLocale(code, disabled, canRemove))}
      </Flex>
    );

  // --- Locked: status/upsell + existing locales read-only (never stripped) --
  if (multiLanguageAccess !== 'entitled') {
    const hasExisting = localeCodes.length > 0;
    return (
      <Flex direction="column" gap={4} alignItems="stretch">
        {header}
        {multiLanguageAccess === 'unentitled' ? (
          <UpsellCard
            access={multiLanguageAccess}
            feature="multiLanguage"
            description={formatMessage({
              id: getTranslation('translations.upsell.description'),
              defaultMessage:
                'Author multi-language form content with a Business license. Translate labels, placeholders and messages per locale.',
            })}
          />
        ) : (
          <LicenseStatusNotice compact />
        )}
        {hasExisting &&
          (multiLanguageAccess === 'unentitled' ? (
            renderLocalesList(true, multiLanguagePolicy.canRemove)
          ) : (
            <LockedSection access={multiLanguageAccess} feature="multiLanguage" mode="readonly">
              {({ disabled }) => renderLocalesList(disabled, multiLanguagePolicy.canRemove)}
            </LockedSection>
          ))}
      </Flex>
    );
  }

  // --- Entitled: full editor ------------------------------------------------
  return (
    <Flex direction="column" gap={4} alignItems="stretch">
      {header}
      {addLocaleRow}
      {renderLocalesList()}
    </Flex>
  );
};

export default LocalesEditor;
