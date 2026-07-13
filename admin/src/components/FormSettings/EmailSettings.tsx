import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  Field,
  TextInput,
  Textarea,
  Checkbox,
  IconButton,
  Divider,
  SingleSelect,
  SingleSelectOption,
} from '@strapi/design-system';
import { Plus, Trash } from '@strapi/icons';
import { useIntl } from 'react-intl';
import { v4 as uuidv4 } from 'uuid';

import { getTranslation } from '../../utils/getTranslation';
import { EmailNotification } from '../../utils/api';
import { useLicense } from '../../ee/hooks/useLicense';
import { GatedButton } from '../../ee/components/GatedButton';
import { LockedSection } from '../../ee/components/LockedSection';
import { LicenseStatusNotice } from '../../ee/components/LicenseStatusNotice';
import { ProBadge } from '../../ee/components/ProBadge';
import { premiumMutationPolicy } from '../../ee/license-state';

export interface EmailSettingsProps {
  notifications: EmailNotification[];
  onChange: (notifications: EmailNotification[]) => void;
  /** The form's current fields, used to populate the autoresponder "Submitter
   *  email field" selector. Only email-type fields are offered. */
  formFields?: Array<{ name: string; label: string; type: string }>;
}

/**
 * Notification record with a stable client-side id. The `id` keys cards and
 * editor-local validation state so that splicing the array never aliases
 * neighbours' state. `id` is treated as optional on the wire (the api.ts type
 * owns the shape); the server tolerates the extra key.
 */
type NotificationWithId = EmailNotification & { id: string };

/** Recipient list keys on EmailNotification that this editor manages. */
type RecipientField = 'to' | 'cc' | 'bcc';

/**
 * Default notification configuration
 */
const createDefaultNotification = (): NotificationWithId => ({
  id: uuidv4(),
  enabled: true,
  to: [''],
  subject: 'New submission from {{form.title}}',
  includeData: true,
});

/**
 * Ensure every notification has a stable `id`. Existing records persisted before
 * the `id` field was introduced are normalised on first render.
 */
const withIds = (notifications: EmailNotification[]): NotificationWithId[] =>
  notifications.map((notification) => {
    const existing = (notification as Partial<NotificationWithId>).id;
    return existing ? (notification as NotificationWithId) : { ...notification, id: uuidv4() };
  });

/**
 * Whether any notification is missing an `id` (i.e. needs normalising on mount).
 */
const needsIds = (notifications: EmailNotification[]): boolean =>
  notifications.some((notification) => !(notification as Partial<NotificationWithId>).id);

/**
 * Validate email format. Template tokens (containing `{{`) are always allowed.
 */
const isValidEmail = (email: string): boolean => {
  if (!email) return true;
  if (email.includes('{{')) return true;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * EmailSettings component for configuring email notifications
 */
export const EmailSettings = ({ notifications, onChange, formFields = [] }: EmailSettingsProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const emailAdvancedAccess = access('email.advanced');
  const emailTemplateAccess = access('email.customTemplate');
  const emailAutoresponderAccess = access('email.autoresponder');
  const emailWhiteLabelAccess = access('email.whiteLabel');
  const emailAdvancedPolicy = premiumMutationPolicy(emailAdvancedAccess);
  const emailTemplatePolicy = premiumMutationPolicy(emailTemplateAccess);
  const emailAutoresponderPolicy = premiumMutationPolicy(emailAutoresponderAccess);
  const emailWhiteLabelPolicy = premiumMutationPolicy(emailWhiteLabelAccess);
  const hasUnknownEmailAccess = [
    emailAdvancedAccess,
    emailTemplateAccess,
    emailAutoresponderAccess,
    emailWhiteLabelAccess,
  ].some((featureAccess) => featureAccess === 'checking' || featureAccess === 'unavailable');

  // The email-type fields that can supply the submitter's address.
  const emailFields = useMemo(
    () => formFields.filter((field) => field.type === 'email'),
    [formFields]
  );
  // Validation errors keyed by the notification's stable id (never by array index).
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Normalise to records that always carry a stable id for keying.
  const items = useMemo<NotificationWithId[]>(() => withIds(notifications), [notifications]);
  const canPersistNotificationIds = items.length <= 1 || emailAdvancedPolicy.canEdit;

  // The first notification is free. Additional records are premium, so keep
  // generated keys editor-local until premium authoring access is confirmed.
  useEffect(() => {
    if (needsIds(notifications) && canPersistNotificationIds) {
      onChange(items);
    }
  }, [canPersistNotificationIds, items, notifications, onChange]);

  const invalidEmailMessage = formatMessage({
    id: getTranslation('notifications.email.invalidEmail'),
    defaultMessage: 'Invalid email format',
  });

  const setError = (key: string, message: string | null) => {
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (message) {
        next[key] = message;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const addNotification = () => {
    onChange([...items, createDefaultNotification()]);
  };

  const removeNotification = (id: string, index: number) => {
    const updated = [...items];
    updated.splice(index, 1);
    onChange(updated);

    setValidationErrors((prev) => {
      const next = { ...prev };
      Object.keys(next)
        .filter((key) => key.startsWith(`${id}-`))
        .forEach((key) => delete next[key]);
      return next;
    });
  };

  const updateNotification = <K extends keyof EmailNotification>(
    index: number,
    key: K,
    value: EmailNotification[K]
  ) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [key]: value };
    onChange(updated);
  };

  const removeLockedNotification = (id: string, index: number) => {
    if (!emailAdvancedPolicy.canRemove) return;
    removeNotification(id, index);
  };

  const clearReplyTo = (id: string, index: number) => {
    if (!emailTemplatePolicy.canRemove) return;
    updateNotification(index, 'replyTo', undefined);
    setError(`${id}-replyTo`, null);
  };

  const clearEmailTemplate = (index: number) => {
    if (!emailTemplatePolicy.canRemove) return;
    updateNotification(index, 'template', undefined);
  };

  const disableAutoresponder = (index: number) => {
    if (!emailAutoresponderPolicy.canRemove) return;
    const updated = [...items];
    updated[index] = { ...updated[index], isAutoresponder: false, toField: undefined };
    onChange(updated);
  };

  const restoreBranding = (index: number) => {
    if (!emailWhiteLabelPolicy.canRemove) return;
    updateNotification(index, 'omitBranding', false);
  };

  const getRecipients = (notification: EmailNotification, field: RecipientField): string[] => {
    if (field === 'to') return notification.to;
    return notification[field] ?? [];
  };

  const addRecipient = (index: number, field: RecipientField) => {
    const current = getRecipients(items[index], field);
    updateNotification(index, field, [...current, '']);
  };

  const updateRecipient = (
    id: string,
    notifIndex: number,
    field: RecipientField,
    recipientIndex: number,
    value: string
  ) => {
    const current = [...getRecipients(items[notifIndex], field)];
    current[recipientIndex] = value;
    updateNotification(notifIndex, field, current);

    const errorKey = `${id}-${field}-${recipientIndex}`;
    setError(errorKey, value && !isValidEmail(value) ? invalidEmailMessage : null);
  };

  const removeRecipient = (
    id: string,
    notifIndex: number,
    field: RecipientField,
    recipientIndex: number
  ) => {
    const current = [...getRecipients(items[notifIndex], field)];
    current.splice(recipientIndex, 1);
    updateNotification(notifIndex, field, field === 'to' && current.length === 0 ? [''] : current);

    const errorKey = `${id}-${field}-${recipientIndex}`;
    setError(errorKey, null);
  };

  const handleReplyToChange = (id: string, index: number, value: string) => {
    updateNotification(index, 'replyTo', value || undefined);
    const errorKey = `${id}-replyTo`;
    setError(errorKey, value && !isValidEmail(value) ? invalidEmailMessage : null);
  };

  const recipientLabels: Record<RecipientField, { id: string; defaultMessage: string }> = {
    to: { id: getTranslation('notifications.email.to.label'), defaultMessage: 'To' },
    cc: { id: getTranslation('notifications.email.cc.label'), defaultMessage: 'Cc' },
    bcc: { id: getTranslation('notifications.email.bcc.label'), defaultMessage: 'Bcc' },
  };

  const renderRecipientEditor = (
    notification: NotificationWithId,
    index: number,
    field: RecipientField,
    disabled = false
  ) => {
    const recipients = getRecipients(notification, field);
    const isRequired = field === 'to';
    const notifId = notification.id;

    return (
      <Box key={field}>
        <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
          <Typography variant="sigma" textColor="neutral600">
            {formatMessage(recipientLabels[field])}
          </Typography>
          <Button
            size="S"
            variant="secondary"
            startIcon={<Plus />}
            onClick={() => addRecipient(index, field)}
            disabled={disabled}
          >
            {formatMessage({
              id: getTranslation('notifications.email.addRecipient'),
              defaultMessage: 'Add recipient',
            })}
          </Button>
        </Flex>
        {recipients.length === 0 ? (
          <Typography variant="pi" textColor="neutral500">
            {formatMessage({
              id: getTranslation('notifications.email.noRecipients'),
              defaultMessage: 'No recipients added',
            })}
          </Typography>
        ) : (
          <Flex direction="column" gap={2} alignItems="stretch">
            {recipients.map((email, recipientIndex) => {
              const errorKey = `${notifId}-${field}-${recipientIndex}`;
              const error = validationErrors[errorKey];
              return (
                <Flex key={recipientIndex} gap={2} alignItems="flex-start">
                  <Box flex="1">
                    <Field.Root name={errorKey} error={error || false}>
                      <TextInput
                        type="email"
                        aria-label={`${formatMessage(recipientLabels[field])} ${recipientIndex + 1}`}
                        placeholder={formatMessage({
                          id: getTranslation('notifications.email.to.placeholder'),
                          defaultMessage: 'recipient@example.com',
                        })}
                        value={email}
                        readOnly={disabled}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateRecipient(notifId, index, field, recipientIndex, e.target.value)
                        }
                      />
                      <Field.Error />
                    </Field.Root>
                  </Box>
                  <IconButton
                    label={formatMessage({
                      id: getTranslation('notifications.email.removeRecipient'),
                      defaultMessage: 'Remove recipient',
                    })}
                    onClick={() => removeRecipient(notifId, index, field, recipientIndex)}
                    disabled={disabled || (isRequired && recipients.length === 1)}
                    variant="ghost"
                    withTooltip={false}
                  >
                    <Trash />
                  </IconButton>
                </Flex>
              );
            })}
          </Flex>
        )}
      </Box>
    );
  };

  return (
    <Flex direction="column" gap={4} alignItems="stretch">
      {/* Header */}
      <Flex justifyContent="space-between" alignItems="center">
        <Box>
          <Typography variant="delta" fontWeight="bold">
            {formatMessage({
              id: getTranslation('notifications.email.title'),
              defaultMessage: 'Email Notifications',
            })}
          </Typography>
          <Box>
            <Typography variant="pi" textColor="neutral600">
              {formatMessage({
                id: getTranslation('notifications.email.subtitle'),
                defaultMessage: 'Send an email when a new submission is received',
              })}
            </Typography>
          </Box>
        </Box>
        {items.length === 0 ? (
          <Button size="S" startIcon={<Plus />} onClick={addNotification}>
            {formatMessage({
              id: getTranslation('notifications.email.add'),
              defaultMessage: 'Add email notification',
            })}
          </Button>
        ) : (
          <GatedButton
            access={emailAdvancedAccess}
            feature="email.advanced"
            size="S"
            startIcon={<Plus />}
            onClick={addNotification}
          >
            {formatMessage({
              id: getTranslation('notifications.email.add'),
              defaultMessage: 'Add email notification',
            })}
          </GatedButton>
        )}
      </Flex>

      {hasUnknownEmailAccess && <LicenseStatusNotice compact />}

      {/* Empty State */}
      {items.length === 0 ? (
        <Box padding={6} background="neutral100" hasRadius>
          <Flex justifyContent="center">
            <Typography textColor="neutral600">
              {formatMessage({
                id: getTranslation('notifications.email.empty'),
                defaultMessage: 'No email notifications configured',
              })}
            </Typography>
          </Flex>
        </Box>
      ) : (
        <Flex direction="column" gap={4} alignItems="stretch">
          {items.map((notification, index) => {
            const notifId = notification.id;
            const additionalNotificationReasonId = `notification-${notifId}-locked-reason`;
            const renderNotification = (notificationDisabled: boolean) => (
              <Box
                key={notifId}
                padding={4}
                background="neutral0"
                hasRadius
                shadow="tableShadow"
                borderColor="neutral200"
                borderStyle="solid"
                borderWidth="1px"
              >
                {/* Notification Header */}
                <Flex justifyContent="space-between" alignItems="flex-start" marginBottom={4}>
                  <Checkbox
                    checked={notification.enabled}
                    disabled={notificationDisabled}
                    onCheckedChange={(checked: boolean) =>
                      updateNotification(index, 'enabled', checked)
                    }
                  >
                    <Typography fontWeight="bold">
                      {formatMessage(
                        {
                          id: getTranslation('notifications.email.itemTitle'),
                          defaultMessage: 'Notification #{number}',
                        },
                        { number: index + 1 }
                      )}
                      {!notification.enabled && (
                        <Typography tag="span" variant="pi" textColor="neutral500">
                          {' '}
                          {formatMessage({
                            id: getTranslation('common.disabled'),
                            defaultMessage: '(Disabled)',
                          })}
                        </Typography>
                      )}
                    </Typography>
                  </Checkbox>
                  <IconButton
                    label={formatMessage({
                      id: getTranslation('notifications.email.remove'),
                      defaultMessage: 'Remove notification',
                    })}
                    onClick={() => removeNotification(notifId, index)}
                    disabled={notificationDisabled}
                    variant="ghost"
                    withTooltip={false}
                  >
                    <Trash />
                  </IconButton>
                </Flex>

                <Flex direction="column" gap={4} alignItems="stretch">
                  {/* Recipients: To / Cc / Bcc. When the notification is an
                    autoresponder, the static `to` list is overridden at runtime
                    by the submitter's email, so it is dimmed and read-only. */}
                  {notification.isAutoresponder ? (
                    <Box>
                      <Box style={{ opacity: 0.6 }} aria-disabled>
                        {renderRecipientEditor(notification, index, 'to', true)}
                      </Box>
                      <Box paddingTop={1}>
                        <Typography variant="pi" textColor="neutral500">
                          {formatMessage({
                            id: getTranslation(
                              'notifications.email.autoresponder.staticRecipientsHint'
                            ),
                            defaultMessage:
                              "Static recipients are overridden by the submitter's email when autoresponder is active.",
                          })}
                        </Typography>
                      </Box>
                    </Box>
                  ) : (
                    renderRecipientEditor(notification, index, 'to', notificationDisabled)
                  )}
                  {renderRecipientEditor(notification, index, 'cc', notificationDisabled)}
                  {renderRecipientEditor(notification, index, 'bcc', notificationDisabled)}

                  <Divider />

                  {/* Subject and Reply-To Row */}
                  <Flex gap={6} alignItems="flex-start">
                    <Box flex="1">
                      <Field.Root
                        name={`notification-${notifId}-subject`}
                        hint={formatMessage({
                          id: getTranslation('notifications.email.subject.hint'),
                          defaultMessage:
                            'Use {{form.title}} and {{field.name}} for dynamic values',
                        })}
                      >
                        <Field.Label>
                          {formatMessage({
                            id: getTranslation('notifications.email.subject.label'),
                            defaultMessage: 'Subject',
                          })}
                        </Field.Label>
                        <TextInput
                          value={notification.subject}
                          readOnly={notificationDisabled}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateNotification(index, 'subject', e.target.value)
                          }
                          placeholder={formatMessage({
                            id: getTranslation('notifications.email.subject.placeholder'),
                            defaultMessage: 'New form submission',
                          })}
                        />
                        <Field.Hint />
                      </Field.Root>
                    </Box>

                    <Box flex="1">
                      <LockedSection
                        access={emailTemplateAccess}
                        feature="email.customTemplate"
                        mode="readonly"
                      >
                        {({ disabled }) => (
                          <Field.Root
                            name={`notification-${notifId}-replyTo`}
                            error={validationErrors[`${notifId}-replyTo`] || false}
                            hint={formatMessage({
                              id: getTranslation('notifications.email.replyTo.hint'),
                              defaultMessage: "Use {{field.email}} for the submitter's email",
                            })}
                          >
                            <Field.Label>
                              {formatMessage({
                                id: getTranslation('notifications.email.replyTo.label'),
                                defaultMessage: 'Reply-To',
                              })}
                              {emailTemplateAccess === 'unentitled' && (
                                <>
                                  {' '}
                                  <ProBadge tier="pro" />
                                </>
                              )}
                            </Field.Label>
                            <TextInput
                              value={notification.replyTo || ''}
                              readOnly={notificationDisabled || disabled}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                handleReplyToChange(notifId, index, e.target.value)
                              }
                              placeholder="{{field.email}}"
                            />
                            <Field.Hint />
                            <Field.Error />
                          </Field.Root>
                        )}
                      </LockedSection>
                      {!notificationDisabled &&
                        notification.replyTo &&
                        emailTemplateAccess !== 'entitled' && (
                          <Box paddingTop={2}>
                            <Button
                              size="S"
                              variant="tertiary"
                              onClick={() => clearReplyTo(notifId, index)}
                              disabled={!emailTemplatePolicy.canRemove}
                            >
                              {formatMessage({
                                id: getTranslation('notifications.email.cleanup.clearReplyTo'),
                                defaultMessage: 'Clear Reply-To',
                              })}
                            </Button>
                          </Box>
                        )}
                    </Box>
                  </Flex>

                  <Divider />

                  {/* Autoresponder (Pro): send to the submitter's email field */}
                  <Box>
                    <LockedSection
                      access={emailAutoresponderAccess}
                      feature="email.autoresponder"
                      mode="readonly"
                    >
                      {({ disabled }) => (
                        <Flex direction="column" gap={3} alignItems="stretch">
                          <Checkbox
                            checked={!!notification.isAutoresponder}
                            disabled={notificationDisabled || disabled}
                            onCheckedChange={(checked: boolean) =>
                              updateNotification(index, 'isAutoresponder', checked)
                            }
                          >
                            {formatMessage({
                              id: getTranslation('notifications.email.autoresponder.label'),
                              defaultMessage: 'Send to submitter (autoresponder)',
                            })}
                            {emailAutoresponderAccess === 'unentitled' && (
                              <>
                                {' '}
                                <ProBadge tier="pro" />
                              </>
                            )}
                          </Checkbox>

                          {notification.isAutoresponder && (
                            <Field.Root
                              name={`notification-${notifId}-toField`}
                              hint={formatMessage({
                                id: getTranslation('notifications.email.toField.hint'),
                                defaultMessage:
                                  'Leave blank to use the first email-type field found in the submission.',
                              })}
                            >
                              <Field.Label>
                                {formatMessage({
                                  id: getTranslation('notifications.email.toField.label'),
                                  defaultMessage: 'Submitter email field',
                                })}
                              </Field.Label>
                              <SingleSelect
                                value={notification.toField ?? ''}
                                disabled={notificationDisabled || disabled}
                                onChange={(value: string | number) =>
                                  updateNotification(index, 'toField', String(value) || undefined)
                                }
                                placeholder={formatMessage({
                                  id: getTranslation('notifications.email.toField.placeholder'),
                                  defaultMessage: 'Select a field (optional)',
                                })}
                              >
                                {emailFields.map((field) => (
                                  <SingleSelectOption key={field.name} value={field.name}>
                                    {field.label || field.name}
                                  </SingleSelectOption>
                                ))}
                              </SingleSelect>
                              <Field.Hint />
                            </Field.Root>
                          )}
                        </Flex>
                      )}
                    </LockedSection>
                    {!notificationDisabled &&
                      notification.isAutoresponder &&
                      emailAutoresponderAccess !== 'entitled' && (
                        <Box paddingTop={2}>
                          <Button
                            size="S"
                            variant="tertiary"
                            onClick={() => disableAutoresponder(index)}
                            disabled={!emailAutoresponderPolicy.canRemove}
                          >
                            {formatMessage({
                              id: getTranslation(
                                'notifications.email.cleanup.disableAutoresponder'
                              ),
                              defaultMessage: 'Disable autoresponder',
                            })}
                          </Button>
                        </Box>
                      )}
                  </Box>

                  <Divider />

                  {/* Custom email body template (optional) */}
                  <Box>
                    <LockedSection
                      access={emailTemplateAccess}
                      feature="email.customTemplate"
                      mode="readonly"
                    >
                      {({ disabled }) => (
                        <Field.Root
                          name={`notification-${notifId}-template`}
                          hint={formatMessage({
                            id: getTranslation('notifications.email.template.hint'),
                            defaultMessage:
                              'Optional. Custom email body with {{form.title}}, {{form.slug}}, {{submission.id}}, {{submission.createdAt}}, {{data.fieldName}} for a single field, and {{data}} for all fields. Leave empty to use the default formatted email. HTML is allowed; submitted values are escaped automatically.',
                          })}
                        >
                          <Field.Label>
                            {formatMessage({
                              id: getTranslation('notifications.email.template.label'),
                              defaultMessage: 'Email template',
                            })}
                            {emailTemplateAccess === 'unentitled' && (
                              <>
                                {' '}
                                <ProBadge tier="pro" />
                              </>
                            )}
                          </Field.Label>
                          <Textarea
                            rows={6}
                            value={notification.template || ''}
                            readOnly={notificationDisabled || disabled}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                              updateNotification(index, 'template', e.target.value || undefined)
                            }
                            placeholder={formatMessage({
                              id: getTranslation('notifications.email.template.placeholder'),
                              defaultMessage: 'New submission for {{form.title}}\n\n{{data}}',
                            })}
                          />
                          <Field.Hint />
                        </Field.Root>
                      )}
                    </LockedSection>
                    {!notificationDisabled &&
                      notification.template &&
                      emailTemplateAccess !== 'entitled' && (
                        <Box paddingTop={2}>
                          <Button
                            size="S"
                            variant="tertiary"
                            onClick={() => clearEmailTemplate(index)}
                            disabled={!emailTemplatePolicy.canRemove}
                          >
                            {formatMessage({
                              id: getTranslation('notifications.email.cleanup.clearTemplate'),
                              defaultMessage: 'Clear email template',
                            })}
                          </Button>
                        </Box>
                      )}
                  </Box>

                  <Divider />

                  {/* Include Data Toggle */}
                  <Checkbox
                    checked={notification.includeData !== false}
                    disabled={notificationDisabled}
                    onCheckedChange={(checked: boolean) =>
                      updateNotification(index, 'includeData', checked)
                    }
                  >
                    {formatMessage({
                      id: getTranslation('notifications.email.includeData.label'),
                      defaultMessage: 'Include submission data',
                    })}
                  </Checkbox>

                  {/* White-label (Pro): omit the FormFlow branding footer */}
                  <Box>
                    <LockedSection
                      access={emailWhiteLabelAccess}
                      feature="email.whiteLabel"
                      mode="readonly"
                    >
                      {({ disabled }) => (
                        <Field.Root
                          name={`notification-${notifId}-omitBranding`}
                          hint={
                            emailWhiteLabelAccess === 'checking' ||
                            emailWhiteLabelAccess === 'unavailable'
                              ? undefined
                              : formatMessage({
                                  id: getTranslation('notifications.email.whiteLabel.hint'),
                                  defaultMessage:
                                    "Omit the 'Sent by FormFlow' line from the email footer (Pro feature).",
                                })
                          }
                        >
                          <Checkbox
                            checked={!!notification.omitBranding}
                            disabled={notificationDisabled || disabled}
                            onCheckedChange={(checked: boolean) =>
                              updateNotification(index, 'omitBranding', checked)
                            }
                          >
                            {formatMessage({
                              id: getTranslation('notifications.email.whiteLabel.label'),
                              defaultMessage: 'Remove branding footer',
                            })}
                            {emailWhiteLabelAccess === 'unentitled' && (
                              <>
                                {' '}
                                <ProBadge tier="pro" />
                              </>
                            )}
                          </Checkbox>
                          <Field.Hint />
                        </Field.Root>
                      )}
                    </LockedSection>
                    {!notificationDisabled &&
                      notification.omitBranding &&
                      emailWhiteLabelAccess !== 'entitled' && (
                        <Box paddingTop={2}>
                          <Button
                            size="S"
                            variant="tertiary"
                            onClick={() => restoreBranding(index)}
                            disabled={!emailWhiteLabelPolicy.canRemove}
                          >
                            {formatMessage({
                              id: getTranslation('notifications.email.cleanup.restoreBranding'),
                              defaultMessage: 'Restore branding footer',
                            })}
                          </Button>
                        </Box>
                      )}
                  </Box>
                </Flex>
              </Box>
            );

            if (index === 0) {
              return renderNotification(false);
            }

            return (
              <Box
                key={notifId}
                role="group"
                aria-describedby={
                  emailAdvancedAccess === 'unentitled' ? additionalNotificationReasonId : undefined
                }
              >
                {emailAdvancedAccess === 'unentitled' && (
                  <Box paddingBottom={2}>
                    <Typography
                      id={additionalNotificationReasonId}
                      variant="pi"
                      textColor="neutral600"
                    >
                      {formatMessage({
                        id: getTranslation('notifications.email.additionalLockedReason'),
                        defaultMessage:
                          'Additional email notifications require Pro. Existing settings are read-only, but you can remove this notification.',
                      })}
                    </Typography>
                  </Box>
                )}
                <LockedSection
                  access={emailAdvancedAccess}
                  feature="email.advanced"
                  mode="readonly"
                >
                  {({ disabled }) => renderNotification(disabled)}
                </LockedSection>
                {emailAdvancedAccess !== 'entitled' && (
                  <Box paddingTop={2}>
                    <Button
                      size="S"
                      variant="danger-light"
                      startIcon={<Trash />}
                      onClick={() => removeLockedNotification(notifId, index)}
                      disabled={!emailAdvancedPolicy.canRemove}
                    >
                      {formatMessage({
                        id: getTranslation('notifications.email.remove'),
                        defaultMessage: 'Remove notification',
                      })}
                    </Button>
                  </Box>
                )}
              </Box>
            );
          })}
        </Flex>
      )}

      {/* Requirements Note */}
      <Box padding={4} background="neutral100" hasRadius>
        <Typography variant="pi" textColor="neutral600">
          <Typography tag="span" variant="pi" fontWeight="bold" textColor="neutral700">
            {formatMessage({
              id: getTranslation('common.note'),
              defaultMessage: 'Note:',
            })}
          </Typography>{' '}
          {formatMessage({
            id: getTranslation('notifications.email.requirement'),
            defaultMessage:
              'Email notifications require the Strapi Email plugin to be installed and configured.',
          })}
        </Typography>
      </Box>
    </Flex>
  );
};

export default EmailSettings;
