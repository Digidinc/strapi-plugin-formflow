/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Alert, Box, Button, Field, Flex, Grid, SingleSelect, SingleSelectOption, TextInput, Toggle, Typography } from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import { useTheme } from 'styled-components';

import { API, type FormField, type TelegramConnectionResponse, type TelegramNotificationSettings as ApiSettings } from '../../utils/api';
import { getTranslation } from '../../utils/getTranslation';
import { buildTelegramPreviewDocument, buildTelegramTestPayload, createDefaultTelegramDocument, previewTelegramDocument, telegramNotificationState, validateTelegramDocument, type TelegramTemplateDocument } from '../telegram/template-document';
import { TelegramTemplateEditor } from './TelegramTemplateEditor';
import { SectionHeading } from '../../components/shared';

export type TelegramNotificationSettingsValue = Omit<ApiSettings, 'template'> & { template: TelegramTemplateDocument };

export const TelegramNotificationSettings = ({ value, fields, formId, formTitle, onChange }: { value?: TelegramNotificationSettingsValue; fields: FormField[]; formId: string; formTitle: string; onChange(value: TelegramNotificationSettingsValue): void }) => {
  const { formatMessage } = useIntl(); const { get, post } = useFetchClient(); const { toggleNotification } = useNotification();
  const theme = useTheme();
  const normalizedFields = useMemo(() => fields.map(({ id, type, name, label, defaultValue }) => ({ id, type, name, label, defaultValue })), [fields]);
  const settings = value ?? { enabled: false, connectionId: '', destination: '', template: createDefaultTelegramDocument(normalizedFields, formTitle) };
  const [connections, setConnections] = useState<TelegramConnectionResponse[]>([]); const [loading, setLoading] = useState(true); const [testing, setTesting] = useState(false); const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => { let live = true; setLoading(true); get<{ data: TelegramConnectionResponse[] }>(API.telegramConnections).then((result) => { if (live) { setConnections(result.data.data); setLoadFailed(false); } }).catch(() => { if (live) setLoadFailed(true); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [get]);
  const validation = validateTelegramDocument(settings.template, normalizedFields); const status = telegramNotificationState(settings, connections); const validDestination = /^(-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(settings.destination.trim());
  const update = (patch: Partial<TelegramNotificationSettingsValue>) => onChange({ ...settings, ...patch });
  const sendTest = async () => { setTesting(true); try { await post(API.testTelegramConnection(formId), buildTelegramTestPayload(settings)); toggleNotification({ type: 'success', message: formatMessage({ id: getTranslation('notifications.telegram.test.success'), defaultMessage: 'Telegram test message sent.' }) }); } catch (error) { toggleNotification({ type: 'danger', message: error instanceof Error ? error.message : formatMessage({ id: getTranslation('notifications.telegram.test.failure'), defaultMessage: 'Telegram test message could not be sent.' }) }); } finally { setTesting(false); } };
  const warning = status.state === 'missing' ? formatMessage({ id: getTranslation('notifications.telegram.status.missing.body'), defaultMessage: 'The saved connection was deleted. Select another connection.' }) : status.state === 'inactive' ? formatMessage({ id: getTranslation('notifications.telegram.status.inactive.body'), defaultMessage: 'This connection is inactive because it exceeds the licensed limit.' }) : status.state === 'disconnected' ? formatMessage({ id: getTranslation('notifications.telegram.status.disconnected.body'), defaultMessage: 'This connection has no available credential.' }) : null;
  return <Flex direction="column" alignItems="stretch" gap={4}>
    <SectionHeading
      title={formatMessage({ id: getTranslation('notifications.telegram.title'), defaultMessage: 'Telegram notification' })}
      description={formatMessage({ id: getTranslation('notifications.telegram.description'), defaultMessage: 'Send one rich Telegram message for each form submission.' })}
    />
    <Toggle checked={settings.enabled} onLabel={formatMessage({ id: getTranslation('common.enabled'), defaultMessage: 'Enabled' })} offLabel={formatMessage({ id: getTranslation('common.disabled'), defaultMessage: 'Disabled' })} onChange={(event: ChangeEvent<HTMLInputElement>) => update({ enabled: event.target.checked })} />
    {loadFailed ? <Alert variant="danger" title={formatMessage({ id: getTranslation('notifications.telegram.connections.error'), defaultMessage: 'Connections could not be loaded' })}>{formatMessage({ id: getTranslation('notifications.telegram.connections.error.body'), defaultMessage: 'Try again before enabling this notification.' })}</Alert> : null}
    {warning ? <Alert variant="warning" title={formatMessage({ id: getTranslation(`notifications.telegram.status.${status.state}`), defaultMessage: 'Connection unavailable' })}>{warning}</Alert> : null}
    <Field.Root required><Field.Label>{formatMessage({ id: getTranslation('notifications.telegram.connection'), defaultMessage: 'Connection' })}</Field.Label><SingleSelect disabled={loading} value={settings.connectionId} placeholder={formatMessage({ id: getTranslation('notifications.telegram.connection.placeholder'), defaultMessage: 'Select a Telegram bot' })} onChange={(connectionId: string) => update({ connectionId })}>{settings.connectionId && !connections.some((item) => item.id === settings.connectionId) ? <SingleSelectOption value={settings.connectionId}>{formatMessage({ id: getTranslation('notifications.telegram.connection.deleted'), defaultMessage: 'Deleted connection' })}</SingleSelectOption> : null}{connections.map((connection) => <SingleSelectOption key={connection.id} value={connection.id}>{connection.name}{!connection.active ? formatMessage({ id: getTranslation('notifications.telegram.connection.inactiveSuffix'), defaultMessage: ' (inactive)' }) : ''}</SingleSelectOption>)}</SingleSelect></Field.Root>
    <Field.Root required error={settings.destination && !validDestination ? formatMessage({ id: getTranslation('notifications.telegram.destination.error'), defaultMessage: 'Enter a numeric chat ID or an @channel username.' }) : undefined}><Field.Label>{formatMessage({ id: getTranslation('notifications.telegram.destination'), defaultMessage: 'Destination' })}</Field.Label><TextInput value={settings.destination} placeholder="@channel or -1001234567890" onChange={(event: ChangeEvent<HTMLInputElement>) => update({ destination: event.target.value })} /><Field.Hint>{formatMessage({ id: getTranslation('notifications.telegram.destination.hint'), defaultMessage: 'Add the bot to the destination and grant permission to post.' })}</Field.Hint></Field.Root>
    <Grid.Root gap={4}>
      <Grid.Item col={6} xs={12} direction="column" alignItems="stretch" gap={1}>
        <Field.Root>
          <Flex direction="column" alignItems="stretch" gap={1}>
            <Field.Label>{formatMessage({ id: getTranslation('notifications.telegram.template'), defaultMessage: 'Message template' })}</Field.Label>
            <TelegramTemplateEditor value={settings.template} fields={normalizedFields} onChange={(template) => update({ template })} />
          </Flex>
        </Field.Root>
      </Grid.Item>
      <Grid.Item col={6} xs={12} direction="column" alignItems="stretch" gap={1}>
        <Typography variant="omega" fontWeight="bold" tag="h3">{formatMessage({ id: getTranslation('notifications.telegram.preview'), defaultMessage: 'Preview' })}</Typography>
        <Box background="neutral0" borderColor="neutral200" borderStyle="solid" borderWidth="1px" hasRadius style={{ overflow: 'hidden' }}>
          <iframe
            sandbox=""
            title={formatMessage({ id: getTranslation('notifications.telegram.preview.frame'), defaultMessage: 'Telegram message preview' })}
            srcDoc={buildTelegramPreviewDocument(
              previewTelegramDocument(settings.template, normalizedFields),
              {
                background: theme.colors.neutral0,
                surface: theme.colors.neutral100,
                text: theme.colors.neutral800,
                mutedText: theme.colors.neutral700,
                border: theme.colors.neutral200,
                link: theme.colors.primary600,
                accent: theme.colors.secondary500,
              }
            )}
            style={{ border: 0, display: 'block', width: '100%', minHeight: 240, background: theme.colors.neutral0 }}
          />
        </Box>
      </Grid.Item>
    </Grid.Root>
    {validation.errors.length ? <Alert variant="danger" title={formatMessage({ id: getTranslation('notifications.telegram.validation.title'), defaultMessage: 'Template needs attention' })}>{validation.errors.map((error) => error.message).join(' ')}</Alert> : null}
    {validation.warnings.length ? <Alert variant="warning" title={formatMessage({ id: getTranslation('notifications.telegram.sensitive.title'), defaultMessage: 'Sensitive fields included' })}>{validation.warnings.map((warning) => warning.message).join(' ')}</Alert> : null}
    <Button loading={testing} disabled={!formId || !settings.enabled || !status.canSend || !validDestination || !validation.valid} onClick={sendTest}>{formatMessage({ id: getTranslation('notifications.telegram.test'), defaultMessage: 'Send test' })}</Button>
  </Flex>;
};
