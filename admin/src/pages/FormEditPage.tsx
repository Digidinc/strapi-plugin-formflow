import * as React from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useBlocker } from 'react-router-dom';
import {
  Box,
  Flex,
  Typography,
  Button,
  Tabs,
  Field,
  TextInput,
  Textarea,
  Toggle,
  Grid,
  Dialog,
} from '@strapi/design-system';
import { Check, WarningCircle } from '@strapi/icons';
import {
  Page,
  Layouts,
  BackButton,
  ConfirmDialog,
  useNotification,
  useRBAC,
} from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { getTranslation } from '../utils/getTranslation';
import {
  classifyFormApiError,
  paymentRequiredCopy,
  safeUpgradeUrl,
  type FormApiError,
} from '../utils/form-api-error';
import { FORM_PERMISSIONS } from '../permissions';
import { useForm } from '../hooks';
import { useLicense } from '../ee/hooks/useLicense';
import { FormBuilder } from '../components/FormBuilder';
import { FormSettings } from '../components/FormSettings';
import { EmailSettings } from '../components/FormSettings/EmailSettings';
import { WebhookSettings } from '../components/FormSettings/WebhookSettings';
import { IntegrationsSettings } from '../components/FormSettings/IntegrationsSettings';
import { LocalesEditor } from '../components/FormSettings/LocalesEditor';
import { PLUGIN_ID } from '../pluginId';
import type {
  FormField,
  FormSettings as FormSettingsType,
  FormPayload,
  FormLocales,
  EmailNotification,
  WebhookConfig,
  IntegrationConfig,
} from '../utils/api';

/**
 * Default form settings used when creating a new form
 */
const getDefaultSettings = (): Partial<FormSettingsType> => ({
  submitButtonText: 'Submit',
  resetButtonText: 'Reset',
  showResetButton: false,
  layout: 'single',
  emailNotifications: [],
  webhooks: [],
  integrations: [],
  spam: {
    honeypot: true,
    honeypotFieldName: '_gotcha',
  },
});

/**
 * Form data structure for local state management
 */
interface FormData {
  title: string;
  slug: string;
  description: string;
  fields: FormField[];
  settings: Partial<FormSettingsType>;
  successMessage: string;
  redirectUrl: string;
  isActive: boolean;
  /** Approval workflow (Business). Top-level form field, round-trips via the save path. */
  requiresApproval: boolean;
  /** Multi-language overrides (Business). Round-trips via the form save path. */
  locales: FormLocales;
}

/**
 * Field-level validation errors keyed by field name.
 */
type FieldErrors = Partial<Record<'title' | 'slug', string>>;

/**
 * Default empty form data for creating new forms
 */
const getEmptyFormData = (): FormData => ({
  title: '',
  slug: '',
  description: '',
  fields: [],
  settings: getDefaultSettings(),
  successMessage: 'Thank you for your submission!',
  redirectUrl: '',
  isActive: true,
  requiresApproval: false,
  locales: {},
});

/**
 * Generates a URL-friendly slug from a title string
 */
const generateSlug = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
};

/**
 * The set of form fields that can carry a server validation error.
 */
const MAPPABLE_FIELDS: Array<keyof FieldErrors> = ['title', 'slug'];

/**
 * Coerce a server-provided detail value (which may be a string, an array of
 * messages, or a nested object) into a single human-readable message string.
 */
const detailToMessage = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const messages = value
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof (item as { message?: unknown })?.message === 'string'
            ? (item as { message: string }).message
            : undefined
      )
      .filter((m): m is string => Boolean(m));
    return messages.length > 0 ? messages.join(', ') : undefined;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    return (value as { message: string }).message;
  }
  return undefined;
};

/**
 * Maps a server error onto specific form fields. Prefers the structured
 * `details` payload (a record of `field -> message(s)`) when present, then
 * falls back to scanning the error message for a known field reference.
 */
const mapServerErrorToFields = (
  message: string,
  details?: Record<string, unknown>
): FieldErrors => {
  const errors: FieldErrors = {};

  if (details) {
    for (const field of MAPPABLE_FIELDS) {
      const detailMessage = detailToMessage(details[field]);
      if (detailMessage) {
        errors[field] = detailMessage;
      }
    }
    if (Object.keys(errors).length > 0) {
      return errors;
    }
  }

  const lower = message.toLowerCase();
  if (lower.includes('slug')) {
    errors.slug = message;
  } else if (lower.includes('title')) {
    errors.title = message;
  }
  return errors;
};

/**
 * Form Edit Page - used for creating new forms and editing existing ones.
 * Uses the native Strapi page scaffold (Page.Main + Layouts.Header/Content) and
 * a tabbed Builder / Settings / Notifications interface.
 */
export const FormEditPage = () => {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();
  const { refresh: refreshLicense } = useLicense();

  const isCreating = !id;
  const documentId = isCreating ? undefined : id;

  const { form, isLoading, isSaving, error, createForm, updateForm } = useForm(documentId);

  // Saving maps to create (new form) or update (existing form). Gated by the
  // global `form.create`/`form.update` actions — the editor must never lock out
  // an authorized user (super-admins always hold these). The route remains the
  // authoritative source of truth.
  const {
    isLoading: isLoadingRBAC,
    allowedActions: { canCreate, canUpdate },
  } = useRBAC(FORM_PERMISSIONS);
  const canSave = isCreating ? canCreate : canUpdate;

  const [formData, setFormData] = useState<FormData>(getEmptyFormData());
  const [hasChanges, setHasChanges] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [isSavePending, setIsSavePending] = useState(false);
  const isSavePendingRef = React.useRef(false);
  const savePending = isSaving || isSavePending;
  // Set while programmatically navigating after a successful save so the
  // unsaved-changes blocker does not fire on our own redirect.
  const isSaveNavigatingRef = React.useRef(false);

  // Once the route param settles (e.g. after a create redirect), re-arm the
  // unsaved-changes blocker for subsequent edits.
  useEffect(() => {
    isSaveNavigatingRef.current = false;
  }, [id]);

  // Load form data when editing an existing form
  useEffect(() => {
    if (form && !isCreating) {
      setFormData({
        title: form.title,
        slug: form.slug,
        description: form.description || '',
        fields: form.fields || [],
        settings: form.settings || getDefaultSettings(),
        successMessage: form.successMessage || 'Thank you for your submission!',
        redirectUrl: form.redirectUrl || '',
        isActive: form.isActive ?? true,
        requiresApproval: form.requiresApproval ?? false,
        locales: form.locales || {},
      });
      setHasChanges(false);
    }
  }, [form, isCreating]);

  // Generic field update handler
  const updateField = useCallback(<K extends keyof FormData>(name: K, value: FormData[K]) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
    setHasChanges(true);
  }, []);

  // Title change handler with auto-slug generation for new forms
  const handleTitleChange = useCallback(
    (value: string) => {
      updateField('title', value);
      setFieldErrors((prev) => ({ ...prev, title: undefined }));
      if (isCreating) {
        updateField('slug', generateSlug(value));
      }
    },
    [isCreating, updateField]
  );

  // ----- Unsaved-changes guard (react-router useBlocker) -----
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasChanges &&
      !isSaveNavigatingRef.current &&
      currentLocation.pathname !== nextLocation.pathname
  );

  // `useBlocker` only guards in-app navigation; it cannot intercept a tab close
  // or full-page refresh. Warn via the native `beforeunload` prompt while there
  // are unsaved changes (and we are not in the middle of a save redirect).
  useEffect(() => {
    if (!hasChanges) {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isSaveNavigatingRef.current) {
        return;
      }
      event.preventDefault();
      // Legacy browsers require `returnValue` to be set to trigger the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasChanges]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (isSavePendingRef.current) {
      return;
    }

    const nextErrors: FieldErrors = {};
    if (!formData.title.trim()) {
      nextErrors.title = formatMessage({
        id: getTranslation('form.validation.titleRequired'),
        defaultMessage: 'Please enter a form title',
      });
    }
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      toggleNotification({
        type: 'warning',
        message: formatMessage({
          id: getTranslation('form.validation.titleRequired'),
          defaultMessage: 'Please enter a form title',
        }),
      });
      return;
    }

    isSavePendingRef.current = true;
    setIsSavePending(true);
    setFieldErrors({});

    try {
      const payload: FormPayload = {
        title: formData.title,
        slug: formData.slug || generateSlug(formData.title),
        description: formData.description || undefined,
        fields: formData.fields,
        settings: formData.settings as FormSettingsType,
        successMessage: formData.successMessage,
        redirectUrl: formData.redirectUrl || undefined,
        isActive: formData.isActive,
        requiresApproval: formData.requiresApproval,
        locales: formData.locales,
      };

      if (isCreating) {
        const newForm = await createForm(payload);
        toggleNotification({
          type: 'success',
          message: formatMessage({
            id: getTranslation('form.create.success'),
            defaultMessage: 'Form created successfully',
          }),
        });
        setHasChanges(false);
        isSaveNavigatingRef.current = true;
        navigate(`/plugins/${PLUGIN_ID}/forms/${newForm.documentId}/edit`);
      } else {
        await updateForm(payload);
        toggleNotification({
          type: 'success',
          message: formatMessage({
            id: getTranslation('form.save.success'),
            defaultMessage: 'Form saved successfully',
          }),
        });
        setHasChanges(false);
      }
    } catch (err) {
      const apiErr = err as FormApiError;
      const message = err instanceof Error ? err.message : '';
      const details = apiErr?.details;
      const kind = classifyFormApiError(apiErr);

      if (kind === 'payment_required') {
        const copy = paymentRequiredCopy(details);
        const upgradeUrl = safeUpgradeUrl(details?.upgradeUrl);
        await refreshLicense();

        const paymentMessage =
          copy.kind === 'known'
            ? formatMessage(
                {
                  id: getTranslation('form.save.paymentRequired.known'),
                  defaultMessage:
                    '{feature} requires a {tier} plan. Upgrade your plan or remove that premium configuration before saving.',
                },
                {
                  feature: formatMessage({
                    id: getTranslation(`form.save.paymentFeature.${copy.feature}`),
                    defaultMessage: copy.defaultLabel,
                  }),
                  tier: formatMessage({
                    id: getTranslation(`license.tier.${copy.tier}`),
                    defaultMessage: copy.tier === 'business' ? 'Business' : 'Pro',
                  }),
                }
              )
            : formatMessage({
                id: getTranslation('form.save.paymentRequired'),
                defaultMessage:
                  'This form uses premium configuration that is not available on the current plan. Review the plan or remove the premium settings before saving.',
              });

        toggleNotification({
          type: 'info',
          message: paymentMessage,
          link: upgradeUrl
            ? {
                label: formatMessage({
                  id: getTranslation('license.viewPlans'),
                  defaultMessage: 'View plans',
                }),
                url: upgradeUrl,
                target: '_blank',
              }
            : undefined,
        });
        return;
      }

      if (kind === 'validation') {
        const conditionalIssues = Array.isArray(details?.conditionalIssues)
          ? details.conditionalIssues
          : [];

        if (conditionalIssues.length > 0) {
          const issueSummary = conditionalIssues
            .flatMap((issue) => {
              if (!issue || typeof issue !== 'object' || typeof issue.message !== 'string') {
                return [];
              }

              const fieldName =
                typeof issue.fieldName === 'string' && issue.fieldName
                  ? `“${issue.fieldName}”: `
                  : '';
              return [`${fieldName}${issue.message}`];
            })
            .join('; ');

          toggleNotification({
            type: 'danger',
            message: formatMessage(
              {
                id: getTranslation('form.validation.conditionalConfiguration'),
                defaultMessage: 'Fix the conditional logic configuration before saving: {issues}',
              },
              { issues: issueSummary || message }
            ),
          });
          return;
        }

        // Only explicit 400 responses may map structured details onto fields.
        const mapped = mapServerErrorToFields(message, details);
        if (Object.keys(mapped).length > 0) {
          setFieldErrors(mapped);
          return;
        }
      }

      toggleNotification({
        type: 'danger',
        message:
          message ||
          formatMessage({
            id: getTranslation(isCreating ? 'form.create.error' : 'form.save.error'),
            defaultMessage: isCreating ? 'Failed to create form' : 'Failed to save form',
          }),
      });
    } finally {
      isSavePendingRef.current = false;
      setIsSavePending(false);
    }
  }, [
    formData,
    isCreating,
    createForm,
    updateForm,
    toggleNotification,
    navigate,
    formatMessage,
    refreshLicense,
  ]);

  const tabTitle = useMemo(
    () =>
      formatMessage({
        id: getTranslation(isCreating ? 'form.create.title' : 'form.edit.title'),
        defaultMessage: isCreating ? 'Create Form' : 'Edit Form',
      }),
    [isCreating, formatMessage]
  );

  // Loading & error states (native)
  if (isLoadingRBAC || (isLoading && !isCreating)) {
    return <Page.Loading />;
  }

  // Block the page when the user lacks the permission for the current mode
  // (create vs edit). Super-admins always pass.
  if (!canSave) {
    return <Page.NoPermissions />;
  }

  if (error && !isCreating) {
    return <Page.Error />;
  }

  return (
    <Page.Main>
      <Page.Title>{tabTitle}</Page.Title>

      <Layouts.Header
        title={tabTitle}
        subtitle={formatMessage({
          id: getTranslation(isCreating ? 'form.create.subtitle' : 'form.edit.subtitle'),
          defaultMessage: isCreating
            ? 'Build a new form with custom fields'
            : 'Modify your form configuration',
        })}
        navigationAction={<BackButton disabled={false} fallback={`/plugins/${PLUGIN_ID}`} />}
        primaryAction={
          <Button
            type="submit"
            startIcon={<Check />}
            onClick={handleSave}
            loading={savePending}
            disabled={savePending || (!hasChanges && !isCreating)}
          >
            {formatMessage({ id: getTranslation('common.save'), defaultMessage: 'Save' })}
          </Button>
        }
      />

      <Layouts.Content>
        <Tabs.Root defaultValue="builder">
          <Tabs.List
            aria-label={formatMessage({
              id: getTranslation('form.tabs.ariaLabel'),
              defaultMessage: 'Form configuration tabs',
            })}
          >
            <Tabs.Trigger value="builder">
              {formatMessage({
                id: getTranslation('form.tabs.builder'),
                defaultMessage: 'Form Builder',
              })}
            </Tabs.Trigger>
            <Tabs.Trigger value="settings">
              {formatMessage({
                id: getTranslation('form.tabs.settings'),
                defaultMessage: 'Settings',
              })}
            </Tabs.Trigger>
            <Tabs.Trigger value="notifications">
              {formatMessage({
                id: getTranslation('form.tabs.notifications'),
                defaultMessage: 'Notifications',
              })}
            </Tabs.Trigger>
            <Tabs.Trigger value="integrations">
              {formatMessage({
                id: getTranslation('form.tabs.integrations'),
                defaultMessage: 'Integrations',
              })}
            </Tabs.Trigger>
            <Tabs.Trigger value="translations">
              {formatMessage({
                id: getTranslation('form.tabs.translations'),
                defaultMessage: 'Translations',
              })}
            </Tabs.Trigger>
          </Tabs.List>

          <Box marginTop={6}>
            {/* Form Builder Tab */}
            <Tabs.Content value="builder">
              <Box
                marginBottom={6}
                padding={6}
                background="neutral0"
                hasRadius
                shadow="tableShadow"
              >
                <Flex justifyContent="space-between" alignItems="flex-start" marginBottom={5}>
                  <Typography variant="delta" fontWeight="bold">
                    {formatMessage({
                      id: getTranslation('form.basicInfo.title'),
                      defaultMessage: 'Basic Information',
                    })}
                  </Typography>
                  <Field.Root name="isActive">
                    <Flex direction="column" gap={1} alignItems="flex-start">
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('common.active'),
                          defaultMessage: 'Active',
                        })}
                      </Field.Label>
                      <Toggle
                        onLabel={formatMessage({
                          id: getTranslation('common.active'),
                          defaultMessage: 'Active',
                        })}
                        offLabel={formatMessage({
                          id: getTranslation('common.inactive'),
                          defaultMessage: 'Inactive',
                        })}
                        checked={formData.isActive}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateField('isActive', e.target.checked)
                        }
                      />
                    </Flex>
                  </Field.Root>
                </Flex>

                <Grid.Root gridCols={12} gap={5}>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <Field.Root
                      name="title"
                      required
                      error={fieldErrors.title || false}
                      hint={formatMessage({
                        id: getTranslation('form.basicInfo.formTitle.hint'),
                        defaultMessage: 'A descriptive name for your form',
                      })}
                    >
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('form.basicInfo.formTitle.label'),
                          defaultMessage: 'Form Title',
                        })}
                      </Field.Label>
                      <TextInput
                        value={formData.title}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          handleTitleChange(e.target.value)
                        }
                        placeholder={formatMessage({
                          id: getTranslation('form.basicInfo.formTitle.placeholder'),
                          defaultMessage: 'Contact Form',
                        })}
                      />
                      <Field.Hint />
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>

                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <Field.Root
                      name="slug"
                      required
                      error={fieldErrors.slug || false}
                      hint={formatMessage({
                        id: getTranslation(
                          isCreating
                            ? 'form.basicInfo.slug.hint.create'
                            : 'form.basicInfo.slug.hint.edit'
                        ),
                        defaultMessage: isCreating
                          ? 'URL-friendly identifier (auto-generated from title)'
                          : 'Cannot be changed after creation',
                      })}
                    >
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('form.basicInfo.slug.label'),
                          defaultMessage: 'Slug',
                        })}
                      </Field.Label>
                      <TextInput
                        value={formData.slug}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          updateField('slug', e.target.value);
                          setFieldErrors((prev) => ({ ...prev, slug: undefined }));
                        }}
                        placeholder={formatMessage({
                          id: getTranslation('form.basicInfo.slug.placeholder'),
                          defaultMessage: 'contact-form',
                        })}
                        disabled={!isCreating}
                      />
                      <Field.Hint />
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>

                  <Grid.Item col={12} direction="column" alignItems="stretch">
                    <Field.Root
                      name="description"
                      hint={formatMessage({
                        id: getTranslation('form.basicInfo.description.hint'),
                        defaultMessage: 'Internal description for your reference',
                      })}
                    >
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('form.basicInfo.description.label'),
                          defaultMessage: 'Description (Optional)',
                        })}
                      </Field.Label>
                      <Textarea
                        value={formData.description}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                          updateField('description', e.target.value)
                        }
                        placeholder={formatMessage({
                          id: getTranslation('form.basicInfo.description.placeholder'),
                          defaultMessage: 'A brief description of what this form is for...',
                        })}
                      />
                      <Field.Hint />
                    </Field.Root>
                  </Grid.Item>
                </Grid.Root>
              </Box>

              <FormBuilder
                fields={formData.fields}
                onChange={(fields) => updateField('fields', fields)}
                settings={formData.settings}
                onSettingsChange={(settings) => updateField('settings', settings)}
              />
            </Tabs.Content>

            {/* Settings Tab */}
            <Tabs.Content value="settings">
              <FormSettings
                settings={formData.settings}
                successMessage={formData.successMessage}
                redirectUrl={formData.redirectUrl}
                showResetButton={formData.settings.showResetButton ?? false}
                requiresApproval={formData.requiresApproval}
                onSettingsChange={(settings) => updateField('settings', settings)}
                onSuccessMessageChange={(value) => updateField('successMessage', value)}
                onRedirectUrlChange={(value) => updateField('redirectUrl', value)}
                onShowResetButtonChange={(value) =>
                  updateField('settings', { ...formData.settings, showResetButton: value })
                }
                onRequiresApprovalChange={(value) => updateField('requiresApproval', value)}
              />
            </Tabs.Content>

            {/* Notifications Tab */}
            <Tabs.Content value="notifications">
              <Flex direction="column" gap={6} alignItems="stretch">
                <Box padding={6} background="neutral0" hasRadius shadow="tableShadow">
                  <EmailSettings
                    notifications={formData.settings.emailNotifications || []}
                    onChange={(emailNotifications: EmailNotification[]) =>
                      updateField('settings', { ...formData.settings, emailNotifications })
                    }
                    formFields={formData.fields}
                  />
                </Box>

                <Box padding={6} background="neutral0" hasRadius shadow="tableShadow">
                  <WebhookSettings
                    webhooks={formData.settings.webhooks || []}
                    onChange={(webhooks: WebhookConfig[]) =>
                      updateField('settings', { ...formData.settings, webhooks })
                    }
                    formId={form?.documentId ?? ''}
                  />
                </Box>
              </Flex>
            </Tabs.Content>

            {/* Integrations Tab */}
            <Tabs.Content value="integrations">
              <Box padding={6} background="neutral0" hasRadius shadow="tableShadow">
                <IntegrationsSettings
                  integrations={formData.settings.integrations || []}
                  onChange={(integrations: IntegrationConfig[]) =>
                    updateField('settings', { ...formData.settings, integrations })
                  }
                />
              </Box>
            </Tabs.Content>

            {/* Translations (locales) Tab */}
            <Tabs.Content value="translations">
              <Box padding={6} background="neutral0" hasRadius shadow="tableShadow">
                <LocalesEditor
                  fields={formData.fields}
                  locales={formData.locales}
                  onChange={(locales: FormLocales) => updateField('locales', locales)}
                />
              </Box>
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </Layouts.Content>

      {/* Unsaved-changes confirmation dialog */}
      <Dialog.Root
        open={blocker.state === 'blocked'}
        onOpenChange={(open: boolean) => {
          if (!open && blocker.state === 'blocked') {
            blocker.reset();
          }
        }}
      >
        <ConfirmDialog
          variant="danger"
          icon={<WarningCircle />}
          title={formatMessage({
            id: getTranslation('form.unsaved.title'),
            defaultMessage: 'Unsaved changes',
          })}
          onConfirm={() => {
            if (blocker.state === 'blocked') {
              blocker.proceed();
            }
          }}
          onCancel={() => {
            if (blocker.state === 'blocked') {
              blocker.reset();
            }
          }}
        >
          {formatMessage({
            id: getTranslation('form.unsaved.body'),
            defaultMessage: 'You have unsaved changes. Are you sure you want to leave this page?',
          })}
        </ConfirmDialog>
      </Dialog.Root>
    </Page.Main>
  );
};
