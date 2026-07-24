import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  Field,
  TextInput,
  NumberInput,
  SingleSelect,
  SingleSelectOption,
  IconButton,
  Divider,
  Checkbox,
} from '@strapi/design-system';
import { Plus, Trash, Eye, EyeStriked } from '@strapi/icons';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import { v4 as uuidv4 } from 'uuid';
import styled from 'styled-components';

import { getTranslation } from '../../utils/getTranslation';
import { API, WebhookConfig, WebhookEvent } from '../../utils/api';
import { useLicense } from '../../ee/hooks/useLicense';
import { GatedButton } from '../../ee/components/GatedButton';
import { LockedSection } from '../../ee/components/LockedSection';
import { LicenseStatusNotice } from '../../ee/components/LicenseStatusNotice';
import { UpsellCard } from '../../ee/components/UpsellCard';
import { premiumMutationPolicy } from '../../ee/license-state';
import { refreshLicenseOnPaymentRequired } from '../../ee/payment-required';
import { SectionHeading } from '../shared';

export interface WebhookSettingsProps {
  webhooks: WebhookConfig[];
  onChange: (webhooks: WebhookConfig[]) => void;
  /** Document id of the form, used to scope the test-webhook request. */
  formId: string;
}

/**
 * Webhook record with a stable client-side id. The `id` is used to key cards and
 * editor-local state so that splicing the array never aliases neighbours' state.
 * `id` is treated as optional on the wire (the api.ts type owns the shape); the
 * server tolerates the extra key.
 */
type WebhookWithId = WebhookConfig & { id: string };

/** A single editable header row (kept in component state, serialised to the record). */
interface HeaderRow {
  key: string;
  value: string;
}

/**
 * Monospace code block used to display the example webhook payload.
 * Replaces the previous raw <pre> + inline styles.
 */
const CodeBlock = styled(Box)`
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: ${({ theme }) => theme.fontSizes[1]};
  line-height: 1.6;
  white-space: pre;
  overflow: auto;
  max-height: 18rem;
`;

/**
 * Webhook timeout is stored on the wire in MILLISECONDS (the server reads
 * `config.timeout` directly as ms, capping it at 30s). The UI presents it in
 * seconds, so we convert on read/write. Bounds: 5s min, 30s max — the upper
 * bound matches the server's hard cap so a configured value is never silently
 * clamped lower than what the admin sees.
 */
const SECOND_MS = 1000;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 30;
/** Default shown when a webhook has no explicit timeout (server default: 10s). */
const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * Available webhook events with labels
 */
const AVAILABLE_EVENTS: Array<{
  value: WebhookEvent;
  labelId: string;
  defaultLabel: string;
}> = [
  {
    value: 'submission.created',
    labelId: 'notifications.webhook.events.created',
    defaultLabel: 'Submission created',
  },
  {
    value: 'submission.updated',
    labelId: 'notifications.webhook.events.updated',
    defaultLabel: 'Submission updated',
  },
  {
    value: 'submission.deleted',
    labelId: 'notifications.webhook.events.deleted',
    defaultLabel: 'Submission deleted',
  },
];

/**
 * Default webhook configuration
 */
const createDefaultWebhook = (): WebhookWithId => ({
  id: uuidv4(),
  enabled: true,
  url: '',
  method: 'POST',
  events: ['submission.created'],
  includeFormData: true,
});

/**
 * Ensure every webhook has a stable `id`. Existing records persisted before the
 * `id` field was introduced are normalised on first render.
 */
const withIds = (webhooks: WebhookConfig[]): WebhookWithId[] =>
  webhooks.map((webhook) => {
    const existing = (webhook as Partial<WebhookWithId>).id;
    return existing ? (webhook as WebhookWithId) : { ...webhook, id: uuidv4() };
  });

/**
 * Whether any webhook is missing an `id` (i.e. needs normalising on mount).
 */
const needsIds = (webhooks: WebhookConfig[]): boolean =>
  webhooks.some((webhook) => !(webhook as Partial<WebhookWithId>).id);

/**
 * Validate URL format
 */
const isValidUrl = (url: string): boolean => {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
};

/**
 * Convert a headers record into ordered editable rows (always ≥ 1 row).
 */
const headersToRows = (headers?: Record<string, string>): HeaderRow[] => {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({ key, value }));
};

/**
 * Convert editable rows back into a headers record, dropping empty keys.
 */
const rowsToHeaders = (rows: HeaderRow[]): Record<string, string> | undefined => {
  const record: Record<string, string> = {};
  rows.forEach(({ key, value }) => {
    const trimmed = key.trim();
    if (trimmed) record[trimmed] = value;
  });
  return Object.keys(record).length > 0 ? record : undefined;
};

/**
 * Example webhook payload
 */
const EXAMPLE_PAYLOAD = {
  event: 'submission.created',
  timestamp: '2024-01-15T10:30:00.000Z',
  form: { id: 'abc123', title: 'Contact Form', slug: 'contact-form' },
  submission: {
    id: 'xyz789',
    status: 'new',
    data: { name: 'John Doe', email: 'john@example.com' },
  },
};

/**
 * WebhookSettings component for configuring webhook integrations
 */
export const WebhookSettings = ({ webhooks, onChange, formId }: WebhookSettingsProps) => {
  const { formatMessage } = useIntl();
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { access, refresh } = useLicense();
  const webhooksAccess = access('webhooks');
  const webhooksPolicy = premiumMutationPolicy(webhooksAccess);
  const webhooksLockReasonId = 'formflow-webhooks-locked-reason';
  // Editor-local state keyed by the webhook's stable id (never by array index).
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [urlErrors, setUrlErrors] = useState<Record<string, string>>({});
  // Header rows kept locally so partially-typed rows (empty key) survive edits.
  const [headerRows, setHeaderRows] = useState<Record<string, HeaderRow[]>>({});

  // Normalise to records that always carry a stable id for keying.
  const items = useMemo<WebhookWithId[]>(() => withIds(webhooks), [webhooks]);
  const canPersistWebhookIds = webhooksPolicy.canEdit;

  // Keep generated keys editor-local until premium authoring access is
  // confirmed; unresolved verification must not mutate premium configuration.
  useEffect(() => {
    if (needsIds(webhooks) && canPersistWebhookIds) {
      onChange(items);
    }
  }, [canPersistWebhookIds, items, onChange, webhooks]);

  const invalidUrlMessage = formatMessage({
    id: getTranslation('notifications.webhook.url.invalid'),
    defaultMessage: 'Please enter a valid URL (http or https)',
  });

  const getHeaderRows = (id: string, index: number): HeaderRow[] =>
    headerRows[id] ?? headersToRows(items[index]?.headers);

  const addWebhook = () => {
    onChange([...items, createDefaultWebhook()]);
  };

  const removeWebhook = (id: string, index: number) => {
    if (!webhooksPolicy.canRemove) return;
    const updated = [...items];
    updated.splice(index, 1);
    onChange(updated);

    setUrlErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setHeaderRows((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setShowSecrets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const updateWebhook = <K extends keyof WebhookConfig>(
    index: number,
    key: K,
    value: WebhookConfig[K]
  ) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [key]: value };
    onChange(updated);
  };

  const handleUrlChange = (id: string, index: number, value: string) => {
    updateWebhook(index, 'url', value);
    setUrlErrors((prev) => {
      const next = { ...prev };
      if (value && !isValidUrl(value)) {
        next[id] = invalidUrlMessage;
      } else {
        delete next[id];
      }
      return next;
    });
  };

  const setRows = (id: string, index: number, rows: HeaderRow[]) => {
    setHeaderRows((prev) => ({ ...prev, [id]: rows }));
    updateWebhook(index, 'headers', rowsToHeaders(rows));
  };

  const addHeader = (id: string, index: number) => {
    setRows(id, index, [...getHeaderRows(id, index), { key: '', value: '' }]);
  };

  const updateHeader = (id: string, index: number, rowIndex: number, patch: Partial<HeaderRow>) => {
    const rows = getHeaderRows(id, index).map((row, i) =>
      i === rowIndex ? { ...row, ...patch } : row
    );
    setRows(id, index, rows);
  };

  const removeHeader = (id: string, index: number, rowIndex: number) => {
    const rows = getHeaderRows(id, index).filter((_, i) => i !== rowIndex);
    setRows(id, index, rows.length > 0 ? rows : [{ key: '', value: '' }]);
  };

  const toggleEvent = (index: number, event: WebhookEvent) => {
    const events = items[index].events || [];
    if (events.includes(event)) {
      if (events.length > 1) {
        updateWebhook(
          index,
          'events',
          events.filter((e) => e !== event)
        );
      }
    } else {
      updateWebhook(index, 'events', [...events, event]);
    }
  };

  const toggleSecretVisibility = (id: string) => {
    setShowSecrets((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  /**
   * Fire a one-off test request for a single webhook against the server's
   * `POST /forms/:formId/webhooks/test` endpoint. The server enforces the Pro
   * gate authoritatively. A 402 refreshes the shared license UI, which then
   * presents the resolved, unavailable, or recovered state truthfully.
   */
  const handleTestWebhook = async (index: number) => {
    try {
      await post(API.testWebhook(formId), items[index]);
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('notifications.webhook.test.success'),
          defaultMessage: 'Test webhook sent successfully',
        }),
      });
    } catch (err) {
      if (await refreshLicenseOnPaymentRequired(err, refresh)) {
        return;
      }

      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('notifications.webhook.test.error'),
          defaultMessage: 'Failed to send test webhook',
        }),
      });
    }
  };

  return (
    <Flex direction="column" gap={4} alignItems="stretch">
      {/* Header */}
      <Flex justifyContent="space-between" alignItems="center">
        <SectionHeading
          title={formatMessage({
            id: getTranslation('notifications.webhook.title'),
            defaultMessage: 'Webhooks',
          })}
          description={formatMessage({
            id: getTranslation('notifications.webhook.subtitle'),
            defaultMessage: 'Send submission data to an external URL',
          })}
        />
        <GatedButton
          access={webhooksAccess}
          feature="webhooks"
          size="S"
          startIcon={<Plus />}
          onClick={addWebhook}
        >
          {formatMessage({
            id: getTranslation('notifications.webhook.add'),
            defaultMessage: 'Add webhook',
          })}
        </GatedButton>
      </Flex>

      {items.length > 0 && (webhooksAccess === 'checking' || webhooksAccess === 'unavailable') && (
        <LicenseStatusNotice compact />
      )}

      {/* Empty State */}
      {items.length === 0 ? (
        webhooksAccess === 'checking' || webhooksAccess === 'unavailable' ? (
          <LicenseStatusNotice compact />
        ) : webhooksAccess === 'unentitled' ? (
          <UpsellCard access={webhooksAccess} feature="webhooks" />
        ) : (
          <Box padding={6} background="neutral100" hasRadius>
            <Flex justifyContent="center">
              <Typography textColor="neutral600">
                {formatMessage({
                  id: getTranslation('notifications.webhook.empty'),
                  defaultMessage: 'No webhooks configured',
                })}
              </Typography>
            </Flex>
          </Box>
        )
      ) : (
        <Box
          role="group"
          aria-describedby={webhooksAccess === 'unentitled' ? webhooksLockReasonId : undefined}
        >
          {webhooksAccess === 'unentitled' && (
            <Box paddingBottom={2}>
              <Typography id={webhooksLockReasonId} variant="pi" textColor="neutral600">
                {formatMessage({
                  id: getTranslation('notifications.webhook.lockedReason'),
                  defaultMessage:
                    'Webhooks require Pro. Existing settings are read-only, but you can remove them.',
                })}
              </Typography>
            </Box>
          )}
          <LockedSection access={webhooksAccess} feature="webhooks" mode="readonly">
            {({ disabled }) => (
              <Flex direction="column" gap={4} alignItems="stretch">
                {items.map((webhook, index) => {
                  const webhookId = webhook.id;
                  return (
                    <Box
                      key={webhookId}
                      padding={4}
                      background="neutral0"
                      hasRadius
                      shadow="tableShadow"
                      borderColor="neutral200"
                      borderStyle="solid"
                      borderWidth="1px"
                    >
                      {/* Webhook Header */}
                      <Flex justifyContent="space-between" alignItems="flex-start" marginBottom={4}>
                        <Checkbox
                          checked={webhook.enabled}
                          disabled={disabled}
                          onCheckedChange={(checked: boolean) =>
                            updateWebhook(index, 'enabled', checked)
                          }
                        >
                          <Typography fontWeight="bold">
                            {formatMessage(
                              {
                                id: getTranslation('notifications.webhook.itemTitle'),
                                defaultMessage: 'Webhook #{number}',
                              },
                              { number: index + 1 }
                            )}
                            {!webhook.enabled && (
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
                        <Flex gap={2} alignItems="center">
                          <GatedButton
                            access={webhooksAccess}
                            feature="webhooks"
                            size="S"
                            variant="secondary"
                            onClick={() => handleTestWebhook(index)}
                          >
                            {formatMessage({
                              id: getTranslation('notifications.webhook.test'),
                              defaultMessage: 'Test',
                            })}
                          </GatedButton>
                          <IconButton
                            label={formatMessage({
                              id: getTranslation('notifications.webhook.remove'),
                              defaultMessage: 'Remove webhook',
                            })}
                            onClick={() => removeWebhook(webhookId, index)}
                            disabled={disabled}
                            variant="ghost"
                            withTooltip={false}
                          >
                            <Trash />
                          </IconButton>
                        </Flex>
                      </Flex>

                      <Flex direction="column" gap={4} alignItems="stretch">
                        {/* URL and Method */}
                        <Flex gap={6} alignItems="flex-start">
                          <Box width="14rem">
                            <Field.Root name={`webhook-${webhookId}-method`}>
                              <Field.Label>
                                {formatMessage({
                                  id: getTranslation('notifications.webhook.method.label'),
                                  defaultMessage: 'Method',
                                })}
                              </Field.Label>
                              <SingleSelect
                                value={webhook.method}
                                disabled={disabled}
                                onChange={(value: string | number) =>
                                  updateWebhook(index, 'method', value as 'POST' | 'PUT')
                                }
                              >
                                <SingleSelectOption value="POST">POST</SingleSelectOption>
                                <SingleSelectOption value="PUT">PUT</SingleSelectOption>
                              </SingleSelect>
                            </Field.Root>
                          </Box>
                          <Box flex="1">
                            <Field.Root
                              name={`webhook-${webhookId}-url`}
                              error={urlErrors[webhookId] || false}
                            >
                              <Field.Label>
                                {formatMessage({
                                  id: getTranslation('notifications.webhook.url.label'),
                                  defaultMessage: 'URL',
                                })}
                              </Field.Label>
                              <TextInput
                                type="url"
                                value={webhook.url}
                                readOnly={disabled}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                  handleUrlChange(webhookId, index, e.target.value)
                                }
                                placeholder={formatMessage({
                                  id: getTranslation('notifications.webhook.url.placeholder'),
                                  defaultMessage: 'https://example.com/webhook',
                                })}
                              />
                              <Field.Error />
                            </Field.Root>
                          </Box>
                          <Box width="12rem">
                            <Field.Root
                              name={`webhook-${webhookId}-timeout`}
                              hint={formatMessage(
                                {
                                  id: getTranslation('notifications.webhook.timeout.hint'),
                                  defaultMessage: 'Between {min} and {max} seconds',
                                },
                                { min: MIN_TIMEOUT_SECONDS, max: MAX_TIMEOUT_SECONDS }
                              )}
                            >
                              <Field.Label>
                                {formatMessage({
                                  id: getTranslation('notifications.webhook.timeout.secondsLabel'),
                                  defaultMessage: 'Timeout (seconds)',
                                })}
                              </Field.Label>
                              <NumberInput
                                value={
                                  typeof webhook.timeout === 'number'
                                    ? Math.round(webhook.timeout / SECOND_MS)
                                    : DEFAULT_TIMEOUT_SECONDS
                                }
                                onValueChange={(value: number | undefined) => {
                                  if (value === undefined) {
                                    updateWebhook(index, 'timeout', undefined);
                                    return;
                                  }
                                  const clamped = Math.min(
                                    MAX_TIMEOUT_SECONDS,
                                    Math.max(MIN_TIMEOUT_SECONDS, Math.round(value))
                                  );
                                  updateWebhook(index, 'timeout', clamped * SECOND_MS);
                                }}
                                disabled={disabled}
                                min={MIN_TIMEOUT_SECONDS}
                                max={MAX_TIMEOUT_SECONDS}
                                step={1}
                              />
                              <Field.Hint />
                            </Field.Root>
                          </Box>
                        </Flex>

                        {/* Events */}
                        <Box>
                          <Box marginBottom={2}>
                            <Typography variant="sigma" textColor="neutral600">
                              {formatMessage({
                                id: getTranslation('notifications.webhook.events.label'),
                                defaultMessage: 'Events',
                              })}
                            </Typography>
                          </Box>
                          <Flex direction="column" gap={2} alignItems="stretch">
                            {AVAILABLE_EVENTS.map((event) => (
                              <Checkbox
                                key={event.value}
                                checked={webhook.events?.includes(event.value)}
                                onCheckedChange={() => toggleEvent(index, event.value)}
                                disabled={
                                  disabled ||
                                  (webhook.events?.length === 1 &&
                                    webhook.events.includes(event.value))
                                }
                              >
                                {formatMessage({
                                  id: getTranslation(event.labelId),
                                  defaultMessage: event.defaultLabel,
                                })}
                              </Checkbox>
                            ))}
                          </Flex>
                        </Box>

                        <Divider />

                        {/* Custom Headers */}
                        <Box>
                          <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
                            <Typography variant="sigma" textColor="neutral600">
                              {formatMessage({
                                id: getTranslation('notifications.webhook.headers.label'),
                                defaultMessage: 'Headers',
                              })}
                            </Typography>
                            <Button
                              size="S"
                              variant="secondary"
                              startIcon={<Plus />}
                              onClick={() => addHeader(webhookId, index)}
                              disabled={disabled}
                            >
                              {formatMessage({
                                id: getTranslation('notifications.webhook.headers.add'),
                                defaultMessage: 'Add header',
                              })}
                            </Button>
                          </Flex>
                          <Flex direction="column" gap={2} alignItems="stretch">
                            {getHeaderRows(webhookId, index).map((row, rowIndex) => (
                              <Flex key={rowIndex} gap={2} alignItems="flex-start">
                                <Box flex="1">
                                  <Field.Root name={`webhook-${webhookId}-header-key-${rowIndex}`}>
                                    <TextInput
                                      aria-label={formatMessage({
                                        id: getTranslation('notifications.webhook.headers.key'),
                                        defaultMessage: 'Header name',
                                      })}
                                      placeholder={formatMessage({
                                        id: getTranslation('notifications.webhook.headers.key'),
                                        defaultMessage: 'Header name',
                                      })}
                                      value={row.key}
                                      readOnly={disabled}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                        updateHeader(webhookId, index, rowIndex, {
                                          key: e.target.value,
                                        })
                                      }
                                    />
                                  </Field.Root>
                                </Box>
                                <Box flex="1">
                                  <Field.Root
                                    name={`webhook-${webhookId}-header-value-${rowIndex}`}
                                  >
                                    <TextInput
                                      aria-label={formatMessage({
                                        id: getTranslation('notifications.webhook.headers.value'),
                                        defaultMessage: 'Header value',
                                      })}
                                      placeholder={formatMessage({
                                        id: getTranslation('notifications.webhook.headers.value'),
                                        defaultMessage: 'Header value',
                                      })}
                                      value={row.value}
                                      readOnly={disabled}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                        updateHeader(webhookId, index, rowIndex, {
                                          value: e.target.value,
                                        })
                                      }
                                    />
                                  </Field.Root>
                                </Box>
                                <IconButton
                                  label={formatMessage({
                                    id: getTranslation('notifications.webhook.headers.remove'),
                                    defaultMessage: 'Remove header',
                                  })}
                                  onClick={() => removeHeader(webhookId, index, rowIndex)}
                                  disabled={disabled}
                                  variant="ghost"
                                  withTooltip={false}
                                >
                                  <Trash />
                                </IconButton>
                              </Flex>
                            ))}
                          </Flex>
                        </Box>

                        <Divider />

                        {/* Secret */}
                        <Field.Root
                          name={`webhook-${webhookId}-secret`}
                          hint={formatMessage({
                            id: getTranslation('notifications.webhook.secret.hint'),
                            defaultMessage:
                              'If provided, requests include an X-Webhook-Signature header for verification',
                          })}
                        >
                          <Field.Label>
                            {formatMessage({
                              id: getTranslation('notifications.webhook.secret.label'),
                              defaultMessage: 'Secret',
                            })}
                          </Field.Label>
                          <Flex gap={2} alignItems="flex-start">
                            <Box flex="1">
                              <TextInput
                                type={showSecrets[webhookId] ? 'text' : 'password'}
                                value={webhook.secret || ''}
                                readOnly={disabled}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                  updateWebhook(index, 'secret', e.target.value || undefined)
                                }
                                placeholder={formatMessage({
                                  id: getTranslation('notifications.webhook.secret.placeholder'),
                                  defaultMessage: 'Secret key for HMAC signature',
                                })}
                                autoComplete="new-password"
                              />
                            </Box>
                            <IconButton
                              label={formatMessage({
                                id: getTranslation('notifications.webhook.secret.toggle'),
                                defaultMessage: 'Toggle secret visibility',
                              })}
                              onClick={() => toggleSecretVisibility(webhookId)}
                              disabled={disabled}
                              variant="tertiary"
                            >
                              {showSecrets[webhookId] ? <EyeStriked /> : <Eye />}
                            </IconButton>
                          </Flex>
                          <Field.Hint />
                        </Field.Root>

                        <Divider />

                        {/* Include Data Toggle */}
                        <Checkbox
                          checked={webhook.includeFormData !== false}
                          disabled={disabled}
                          onCheckedChange={(checked: boolean) =>
                            updateWebhook(index, 'includeFormData', checked)
                          }
                        >
                          {formatMessage({
                            id: getTranslation('notifications.webhook.includeFormData.label'),
                            defaultMessage: 'Include form data',
                          })}
                        </Checkbox>
                      </Flex>
                    </Box>
                  );
                })}
              </Flex>
            )}
          </LockedSection>
          {webhooksAccess !== 'entitled' && (
            <Flex direction="column" gap={2} alignItems="flex-start" paddingTop={2}>
              {items.map((webhook, index) => (
                <Button
                  key={`remove-${webhook.id}`}
                  size="S"
                  variant="danger-light"
                  startIcon={<Trash />}
                  onClick={() => removeWebhook(webhook.id, index)}
                  disabled={!webhooksPolicy.canRemove}
                >
                  {formatMessage(
                    {
                      id: getTranslation('notifications.webhook.removeNumbered'),
                      defaultMessage: 'Remove webhook #{number}',
                    },
                    { number: index + 1 }
                  )}
                </Button>
              ))}
            </Flex>
          )}
        </Box>
      )}

      {/* Example Payload */}
      <Box padding={4} background="neutral100" hasRadius>
        <Box marginBottom={2}>
          <Typography variant="sigma" textColor="neutral600">
            {formatMessage({
              id: getTranslation('notifications.webhook.examplePayload'),
              defaultMessage: 'Example Payload',
            })}
          </Typography>
        </Box>
        <CodeBlock padding={3} background="neutral0" hasRadius>
          <Typography variant="pi" textColor="neutral800" fontWeight="regular">
            {JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}
          </Typography>
        </CodeBlock>
        <Box marginTop={2}>
          <Typography variant="pi" textColor="neutral600">
            <Typography tag="span" variant="pi" fontWeight="bold" textColor="neutral700">
              {formatMessage({
                id: getTranslation('notifications.webhook.headers.label'),
                defaultMessage: 'Headers',
              })}
              :
            </Typography>{' '}
            Content-Type: application/json, X-Webhook-Event: [event], X-Webhook-Signature:
            sha256=[hash]
          </Typography>
        </Box>
      </Box>
    </Flex>
  );
};

export default WebhookSettings;
