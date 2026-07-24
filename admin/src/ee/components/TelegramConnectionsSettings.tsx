/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  Alert, Badge, Box, Button, Dialog, Field, Flex, Loader, SingleSelect,
  SingleSelectOption, Table, Tbody, Td, TextInput, Th, Thead, Tr, Typography,
} from '@strapi/design-system';
import { Pencil, Plus, Trash } from '@strapi/icons';
import { useFetchClient, useNotification, useRBAC } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { SETTINGS_PERMISSIONS } from '../../permissions';
import { getTranslation } from '../../utils/getTranslation';
import {
  API, buildTelegramCreateRequest, buildTelegramUpdateRequest, connectionAvailability,
  resetTelegramCredentialDraft, telegramConnectionMutationPolicy, telegramDraftCanSubmit,
  rawRequest,
  type TelegramBotMetadataResponse, type TelegramConnectionResponse,
  type TelegramCreateCredentialRequest, type TelegramCredentialDraft,
} from '../../utils/api';
import { type EntitlementLimit } from '../feature-map';
import { parseLicenseSnapshot } from '../license-state';
import { useLicense } from '../hooks/useLicense';
import { LicenseStatusNotice } from './LicenseStatusNotice';
import { UpsellCard } from './UpsellCard';
import { SectionHeading } from '../../components/shared';

type Editor = { kind: 'create' } | { kind: 'edit'; connection: TelegramConnectionResponse };

const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export const TelegramConnectionsSettings = () => {
  const { formatMessage } = useIntl();
  const { get, del } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { access } = useLicense();
  const integrationAccess = access('integrations');
  const { isLoading: rbacLoading, allowedActions: { canUpdate } } = useRBAC(SETTINGS_PERMISSIONS);
  const [connections, setConnections] = useState<TelegramConnectionResponse[]>([]);
  const [limit, setLimit] = useState<EntitlementLimit>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<TelegramConnectionResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [connectionResult, licenseResult] = await Promise.all([
        get<{ data: TelegramConnectionResponse[] }>(API.telegramConnections),
        get<unknown>('/formflow/license'),
      ]);
      setConnections(connectionResult.data.data);
      setLimit(parseLicenseSnapshot(licenseResult.data).limits.telegramConnections);
    } catch (cause) { setError(messageOf(cause, formatMessage({ id: getTranslation('common.error'), defaultMessage: 'Something went wrong' }))); }
    finally { setLoading(false); }
  }, [get]);

  useEffect(() => { void load(); }, [load]);

  const remove = async () => {
    if (!deleting) return;
    try {
      await del(API.telegramConnection(deleting.id));
      setDeleting(null);
      await load();
      toggleNotification({ type: 'success', message: formatMessage({ id: getTranslation('settings.telegram.deleted'), defaultMessage: 'Telegram connection deleted.' }) });
    } catch (cause) { toggleNotification({ type: 'danger', message: messageOf(cause, formatMessage({ id: getTranslation('common.error'), defaultMessage: 'Something went wrong' })) }); }
  };

  if (integrationAccess === 'checking' || integrationAccess === 'unavailable') return <LicenseStatusNotice compact />;
  if (integrationAccess === 'unentitled') return <UpsellCard access={integrationAccess} feature="integrations" description={formatMessage({ id: getTranslation('settings.telegram.upsell'), defaultMessage: 'Telegram connections require a Pro or Business plan.' })} />;

  const limitReached = limit !== 'unlimited' && connections.length >= limit;
  const limitText = formatMessage(
    { id: getTranslation(limitReached ? 'settings.telegram.limit.reached' : limit === 'unlimited' ? 'settings.telegram.limit.unlimited' : 'settings.telegram.limit.used'), defaultMessage: limitReached ? 'Connection limit reached ({used} of {limit}).' : limit === 'unlimited' ? '{used} connections configured.' : '{used} of {limit} connections used.' },
    { used: connections.length, limit: limit === 'unlimited' ? '' : limit }
  );
  return (
    <Box background="neutral0" hasRadius borderColor="neutral200" padding={6} shadow="tableShadow">
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Flex justifyContent="space-between" alignItems="start" gap={4}>
          <SectionHeading
            title={formatMessage({ id: getTranslation('settings.telegram.title'), defaultMessage: 'Telegram connections' })}
            description={limitText}
          />
          <Button startIcon={<Plus />} disabled={rbacLoading || !canUpdate || limitReached} onClick={() => setEditor({ kind: 'create' })}>
            {formatMessage({ id: getTranslation('settings.telegram.add'), defaultMessage: 'Add connection' })}
          </Button>
        </Flex>
        {limitReached ? <Alert variant="warning" title={formatMessage({ id: getTranslation('settings.telegram.limit.title'), defaultMessage: 'Connection limit reached' })}>{limitText}</Alert> : null}
        {error ? <Alert variant="danger" title={formatMessage({ id: getTranslation('settings.telegram.loadError'), defaultMessage: 'Could not load Telegram connections' })} action={<Button variant="tertiary" onClick={load}>{formatMessage({ id: getTranslation('common.tryAgain'), defaultMessage: 'Try again' })}</Button>}>{error}</Alert> : null}
        {loading ? <Flex justifyContent="center" padding={6}><Loader>{formatMessage({ id: getTranslation('settings.telegram.loading'), defaultMessage: 'Loading connections' })}</Loader></Flex> : connections.length === 0 ? (
          <Typography textColor="neutral600">{formatMessage({ id: getTranslation('settings.telegram.empty'), defaultMessage: 'No Telegram connections configured.' })}</Typography>
        ) : (
          <Table colCount={5} rowCount={connections.length}>
            <Thead><Tr>{(['name','bot','credential','status','actions'] as const).map((column) => <Th key={column}><Typography variant="sigma">{formatMessage({ id: getTranslation(`settings.telegram.column.${column}`), defaultMessage: column })}</Typography></Th>)}</Tr></Thead>
            <Tbody>{connections.map((connection) => {
              const availability = connectionAvailability(connection);
              const policy = telegramConnectionMutationPolicy(connection.active, Boolean(canUpdate));
              return <Tr key={connection.id}>
                <Td><Typography>{connection.name}</Typography></Td>
                <Td><Typography>{connection.bot ? `${connection.bot.displayName}${connection.bot.username ? ` (@${connection.bot.username})` : ''}` : formatMessage({ id: getTranslation('settings.telegram.bot.unavailable'), defaultMessage: 'Bot metadata unavailable' })}</Typography></Td>
                <Td><Typography>{connection.tokenSource.type === 'stored' ? formatMessage({ id: getTranslation('settings.telegram.credential.stored'), defaultMessage: 'Stored securely' }) : connection.tokenSource.variableName}</Typography></Td>
                <Td><Badge active={availability === 'connected'}>{formatMessage({ id: getTranslation(`settings.telegram.status.${availability}`), defaultMessage: availability })}</Badge>{!connection.active ? <Typography textColor="neutral600">{formatMessage({ id: getTranslation('settings.telegram.inactive.explanation'), defaultMessage: 'This excess connection is read-only. Delete it to return to your licensed limit, or upgrade to edit it.' })}</Typography> : null}</Td>
                <Td><Flex gap={1}><Button variant="ghost" aria-label={formatMessage({ id: getTranslation('settings.telegram.edit.aria'), defaultMessage: 'Edit {name}' }, { name: connection.name })} disabled={!policy.canEdit} onClick={() => setEditor({ kind: 'edit', connection })}><Pencil /></Button><Button variant="danger-light" aria-label={formatMessage({ id: getTranslation('settings.telegram.delete.aria'), defaultMessage: 'Delete {name}' }, { name: connection.name })} disabled={!policy.canDelete} onClick={() => setDeleting(connection)}><Trash /></Button></Flex></Td>
              </Tr>;
            })}</Tbody>
          </Table>
        )}
      </Flex>
      <ConnectionDialog editor={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await load(); }} />
      <Dialog.Root open={deleting !== null} onOpenChange={(open: boolean) => { if (!open) setDeleting(null); }}>
        <Dialog.Content><Dialog.Header>{formatMessage({ id: getTranslation('settings.telegram.delete.title'), defaultMessage: 'Delete Telegram connection' })}</Dialog.Header><Dialog.Body>{deleting ? formatMessage({ id: getTranslation(deleting.referenceCount === 0 ? 'settings.telegram.delete.unused' : 'settings.telegram.delete.referenced'), defaultMessage: deleting.referenceCount === 0 ? 'This connection is not referenced by any forms.' : 'This connection is used by {count} forms. Deleting it will disconnect those forms.' }, { count: deleting.referenceCount }) : ''}</Dialog.Body><Dialog.Footer><Dialog.Cancel><Button variant="tertiary">{formatMessage({ id: getTranslation('common.cancel'), defaultMessage: 'Cancel' })}</Button></Dialog.Cancel><Button variant="danger-light" startIcon={<Trash />} onClick={remove}>{formatMessage({ id: getTranslation('common.delete'), defaultMessage: 'Delete' })}</Button></Dialog.Footer></Dialog.Content>
      </Dialog.Root>
    </Box>
  );
};

const ConnectionDialog = ({ editor, onClose, onSaved }: { editor: Editor | null; onClose(): void; onSaved(): Promise<void> }) => {
  const { formatMessage } = useIntl();
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<TelegramCredentialDraft>(resetTelegramCredentialDraft);
  const [validatedBot, setValidatedBot] = useState<TelegramBotMetadataResponse | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(editor?.kind === 'edit' ? editor.connection.name : '');
    setDraft(editor?.kind === 'create' ? { mode: 'stored', token: '', variableName: '' } : resetTelegramCredentialDraft());
    setValidatedBot(editor?.kind === 'edit' ? editor.connection.bot ?? null : null);
    setValidatedFingerprint(editor?.kind === 'edit' ? `${editor.connection.name}|keep||` : null);
  }, [editor]);

  const credential = (): TelegramCreateCredentialRequest | null => draft.mode === 'stored' || draft.mode === 'replace'
    ? { type: 'stored', token: draft.token.trim() }
    : draft.mode === 'environment' ? { type: 'environment', variableName: draft.variableName.trim() } : null;
  const valid = name.trim() !== '' && (draft.mode === 'keep' || (draft.mode === 'environment' ? draft.variableName.trim() !== '' : draft.token.trim() !== ''));
  const fingerprint = `${name.trim()}|${draft.mode}|${draft.token.trim()}|${draft.variableName.trim()}`;
  const existingBot = editor?.kind === 'edit' ? editor.connection.bot ?? null : null;
  const reviewedBot = draft.mode === 'keep' ? existingBot : validatedBot;
  const canSubmit = telegramDraftCanSubmit(name, draft.mode, validatedFingerprint, fingerprint, validatedBot, existingBot);

  const invalidate = () => { setValidatedBot(null); setValidatedFingerprint(null); };

  const validate = async () => {
    const candidate = credential();
    if (!candidate || !valid) return;
    setSaving(true);
    try {
      const checked = await post<{ data: TelegramBotMetadataResponse }>(API.validateTelegramConnection, { credential: candidate });
      setValidatedBot(checked.data.data); setValidatedFingerprint(fingerprint);
    } catch (cause) { toggleNotification({ type: 'danger', message: messageOf(cause, formatMessage({ id: getTranslation('common.error'), defaultMessage: 'Something went wrong' })) }); }
    finally { setSaving(false); }
  };

  const save = async () => {
    if (!editor || !valid || !canSubmit) return;
    setSaving(true);
    try {
      if (editor.kind === 'create') await post(API.telegramConnections, buildTelegramCreateRequest(name, draft as Extract<typeof draft, { mode: 'stored' | 'environment' }>));
      else await rawRequest(API.telegramConnection(editor.connection.id), {
        method: 'PATCH',
        body: buildTelegramUpdateRequest(name, draft.mode === 'stored' ? { mode: 'replace', token: draft.token } : draft as Parameters<typeof buildTelegramUpdateRequest>[1]),
      });
      setDraft(resetTelegramCredentialDraft());
      toggleNotification({ type: 'success', message: formatMessage({ id: getTranslation('settings.telegram.saved'), defaultMessage: 'Telegram connection saved.' }) });
      await onSaved();
    } catch (cause) { toggleNotification({ type: 'danger', message: messageOf(cause, formatMessage({ id: getTranslation('common.error'), defaultMessage: 'Something went wrong' })) }); }
    finally { setSaving(false); }
  };

  return <Dialog.Root open={editor !== null} onOpenChange={(open: boolean) => { if (!open) onClose(); }}><Dialog.Content><Dialog.Header>{formatMessage({ id: getTranslation(editor?.kind === 'edit' ? 'settings.telegram.edit.title' : 'settings.telegram.create.title'), defaultMessage: editor?.kind === 'edit' ? 'Edit Telegram connection' : 'Add Telegram connection' })}</Dialog.Header><Dialog.Body><Flex direction="column" alignItems="stretch" gap={4}>
    <Field.Root required><Field.Label>{formatMessage({ id: getTranslation('settings.telegram.field.name'), defaultMessage: 'Name' })}</Field.Label><TextInput value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => { setName(event.target.value); invalidate(); }} /></Field.Root>
    <Field.Root><Field.Label>{formatMessage({ id: getTranslation('settings.telegram.field.action'), defaultMessage: 'Credential action' })}</Field.Label><SingleSelect value={draft.mode} onChange={(value: string) => { setDraft({ mode: value as TelegramCredentialDraft['mode'], token: '', variableName: '' }); invalidate(); }}>
      {editor?.kind === 'edit' ? <SingleSelectOption value="keep">{formatMessage({ id: getTranslation('settings.telegram.action.keep'), defaultMessage: 'Keep current credential' })}</SingleSelectOption> : null}
      <SingleSelectOption value={editor?.kind === 'create' ? 'stored' : 'replace'}>{formatMessage({ id: getTranslation(editor?.kind === 'create' ? 'settings.telegram.action.store' : 'settings.telegram.action.replace'), defaultMessage: editor?.kind === 'create' ? 'Store token securely' : 'Replace stored token' })}</SingleSelectOption>
      <SingleSelectOption value="environment">{formatMessage({ id: getTranslation('settings.telegram.action.environment'), defaultMessage: 'Use environment variable' })}</SingleSelectOption>
    </SingleSelect></Field.Root>
    {draft.mode === 'stored' || draft.mode === 'replace' ? <Field.Root required><Field.Label>{formatMessage({ id: getTranslation('settings.telegram.field.token'), defaultMessage: 'Bot token' })}</Field.Label><TextInput type="password" autoComplete="new-password" value={draft.token} onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, token: event.target.value }); invalidate(); }} /><Field.Hint>{formatMessage({ id: getTranslation('settings.telegram.field.token.hint'), defaultMessage: 'The existing token is never displayed. Validate the new token before saving.' })}</Field.Hint></Field.Root> : null}
    {draft.mode === 'environment' ? <Field.Root required><Field.Label>{formatMessage({ id: getTranslation('settings.telegram.field.environment'), defaultMessage: 'Environment variable' })}</Field.Label><TextInput value={draft.variableName} placeholder={formatMessage({ id: getTranslation('settings.telegram.field.environment.placeholder'), defaultMessage: 'TELEGRAM_BOT_TOKEN' })} onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, variableName: event.target.value.toUpperCase() }); invalidate(); }} /></Field.Root> : null}
    {reviewedBot ? <Alert variant="success" title={formatMessage({ id: getTranslation('settings.telegram.validated'), defaultMessage: 'Bot validated' })}>{reviewedBot.displayName}{reviewedBot.username ? ` (@${reviewedBot.username})` : ''}</Alert> : null}
  </Flex></Dialog.Body><Dialog.Footer><Dialog.Cancel><Button variant="tertiary">{formatMessage({ id: getTranslation('common.cancel'), defaultMessage: 'Cancel' })}</Button></Dialog.Cancel>{draft.mode !== 'keep' ? <Button variant="secondary" loading={saving} disabled={!valid} onClick={validate}>{formatMessage({ id: getTranslation('settings.telegram.validate'), defaultMessage: 'Validate' })}</Button> : null}<Button loading={saving} disabled={!canSubmit} onClick={save}>{formatMessage({ id: getTranslation('common.save'), defaultMessage: 'Save' })}</Button></Dialog.Footer></Dialog.Content></Dialog.Root>;
};
