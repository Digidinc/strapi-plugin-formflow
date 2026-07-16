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
  connectionLimitMessage, deletionReferenceWarning, resetTelegramCredentialDraft,
  rawRequest,
  type TelegramBotMetadataResponse, type TelegramConnectionResponse,
  type TelegramCreateCredentialRequest, type TelegramCredentialDraft,
} from '../../utils/api';
import { type EntitlementLimit } from '../feature-map';
import { parseLicenseSnapshot } from '../license-state';
import { useLicense } from '../hooks/useLicense';
import { LicenseStatusNotice } from './LicenseStatusNotice';
import { UpsellCard } from './UpsellCard';

type Editor = { kind: 'create' } | { kind: 'edit'; connection: TelegramConnectionResponse };

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong';

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
    } catch (cause) { setError(messageOf(cause)); }
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
    } catch (cause) { toggleNotification({ type: 'danger', message: messageOf(cause) }); }
  };

  if (integrationAccess === 'checking' || integrationAccess === 'unavailable') return <LicenseStatusNotice compact />;
  if (integrationAccess === 'unentitled') return <UpsellCard access={integrationAccess} feature="integrations" description={formatMessage({ id: getTranslation('settings.telegram.upsell'), defaultMessage: 'Telegram connections require a Pro or Business plan.' })} />;

  const limitReached = limit !== 'unlimited' && connections.length >= limit;
  return (
    <Box background="neutral0" hasRadius borderColor="neutral200" padding={6} shadow="tableShadow">
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Flex justifyContent="space-between" alignItems="start" gap={4}>
          <Box>
            <Typography variant="delta" fontWeight="bold">{formatMessage({ id: getTranslation('settings.telegram.title'), defaultMessage: 'Telegram connections' })}</Typography>
            <Typography textColor="neutral600">{connectionLimitMessage(connections.length, limit)}</Typography>
          </Box>
          <Button startIcon={<Plus />} disabled={rbacLoading || !canUpdate || limitReached} onClick={() => setEditor({ kind: 'create' })}>
            {formatMessage({ id: getTranslation('settings.telegram.add'), defaultMessage: 'Add connection' })}
          </Button>
        </Flex>
        {limitReached ? <Alert variant="warning" title={formatMessage({ id: getTranslation('settings.telegram.limit.title'), defaultMessage: 'Connection limit reached' })}>{connectionLimitMessage(connections.length, limit)}</Alert> : null}
        {error ? <Alert variant="danger" title={formatMessage({ id: getTranslation('settings.telegram.loadError'), defaultMessage: 'Could not load Telegram connections' })} action={<Button variant="tertiary" onClick={load}>Retry</Button>}>{error}</Alert> : null}
        {loading ? <Flex justifyContent="center" padding={6}><Loader>Loading connections</Loader></Flex> : connections.length === 0 ? (
          <Typography textColor="neutral600">{formatMessage({ id: getTranslation('settings.telegram.empty'), defaultMessage: 'No Telegram connections configured.' })}</Typography>
        ) : (
          <Table colCount={5} rowCount={connections.length}>
            <Thead><Tr><Th><Typography variant="sigma">Name</Typography></Th><Th><Typography variant="sigma">Bot</Typography></Th><Th><Typography variant="sigma">Credential</Typography></Th><Th><Typography variant="sigma">Status</Typography></Th><Th><Typography variant="sigma">Actions</Typography></Th></Tr></Thead>
            <Tbody>{connections.map((connection) => {
              const availability = connectionAvailability(connection);
              return <Tr key={connection.id}>
                <Td><Typography>{connection.name}</Typography></Td>
                <Td><Typography>{connection.bot.displayName}{connection.bot.username ? ` (@${connection.bot.username})` : ''}</Typography></Td>
                <Td><Typography>{connection.tokenSource.type === 'stored' ? 'Stored securely' : connection.tokenSource.variableName}</Typography></Td>
                <Td><Badge active={availability === 'connected'}>{availability === 'environment-missing' ? 'Environment variable missing' : availability === 'connected' ? 'Connected' : 'Disconnected by license'}</Badge></Td>
                <Td><Flex gap={1}><Button variant="ghost" aria-label={`Edit ${connection.name}`} disabled={!canUpdate} onClick={() => setEditor({ kind: 'edit', connection })}><Pencil /></Button><Button variant="danger-light" aria-label={`Delete ${connection.name}`} disabled={!canUpdate} onClick={() => setDeleting(connection)}><Trash /></Button></Flex></Td>
              </Tr>;
            })}</Tbody>
          </Table>
        )}
      </Flex>
      <ConnectionDialog editor={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await load(); }} />
      <Dialog.Root open={deleting !== null} onOpenChange={(open: boolean) => { if (!open) setDeleting(null); }}>
        <Dialog.Content><Dialog.Header>Delete Telegram connection</Dialog.Header><Dialog.Body>{deleting ? deletionReferenceWarning(deleting.referenceCount) : ''}</Dialog.Body><Dialog.Footer><Dialog.Cancel><Button variant="tertiary">Cancel</Button></Dialog.Cancel><Button variant="danger-light" startIcon={<Trash />} onClick={remove}>Delete</Button></Dialog.Footer></Dialog.Content>
      </Dialog.Root>
    </Box>
  );
};

const ConnectionDialog = ({ editor, onClose, onSaved }: { editor: Editor | null; onClose(): void; onSaved(): Promise<void> }) => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<TelegramCredentialDraft>(resetTelegramCredentialDraft);
  const [validatedBot, setValidatedBot] = useState<TelegramBotMetadataResponse | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(editor?.kind === 'edit' ? editor.connection.name : '');
    setDraft(editor?.kind === 'create' ? { mode: 'stored', token: '', variableName: '' } : resetTelegramCredentialDraft());
    setValidatedBot(null);
  }, [editor]);

  const credential = (): TelegramCreateCredentialRequest | null => draft.mode === 'stored' || draft.mode === 'replace'
    ? { type: 'stored', token: draft.token.trim() }
    : draft.mode === 'environment' ? { type: 'environment', variableName: draft.variableName.trim() } : null;
  const valid = name.trim() !== '' && (draft.mode === 'keep' || (draft.mode === 'environment' ? draft.variableName.trim() !== '' : draft.token.trim() !== ''));

  const save = async () => {
    if (!editor || !valid) return;
    setSaving(true);
    try {
      const candidate = credential();
      if (candidate) {
        const checked = await post<{ data: TelegramBotMetadataResponse }>(API.validateTelegramConnection, { credential: candidate });
        setValidatedBot(checked.data.data);
      }
      if (editor.kind === 'create') await post(API.telegramConnections, buildTelegramCreateRequest(name, draft as Extract<typeof draft, { mode: 'stored' | 'environment' }>));
      else await rawRequest(API.telegramConnection(editor.connection.id), {
        method: 'PATCH',
        body: buildTelegramUpdateRequest(name, draft.mode === 'stored' ? { mode: 'replace', token: draft.token } : draft as Parameters<typeof buildTelegramUpdateRequest>[1]),
      });
      setDraft(resetTelegramCredentialDraft());
      toggleNotification({ type: 'success', message: 'Telegram connection saved.' });
      await onSaved();
    } catch (cause) { toggleNotification({ type: 'danger', message: messageOf(cause) }); }
    finally { setSaving(false); }
  };

  return <Dialog.Root open={editor !== null} onOpenChange={(open: boolean) => { if (!open) onClose(); }}><Dialog.Content><Dialog.Header>{editor?.kind === 'edit' ? 'Edit Telegram connection' : 'Add Telegram connection'}</Dialog.Header><Dialog.Body><Flex direction="column" alignItems="stretch" gap={4}>
    <Field.Root required><Field.Label>Name</Field.Label><TextInput value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} /></Field.Root>
    <Field.Root><Field.Label>Credential action</Field.Label><SingleSelect value={draft.mode} onChange={(value: string) => { setDraft({ mode: value as TelegramCredentialDraft['mode'], token: '', variableName: '' }); setValidatedBot(null); }}>
      {editor?.kind === 'edit' ? <SingleSelectOption value="keep">Keep current credential</SingleSelectOption> : null}
      <SingleSelectOption value={editor?.kind === 'create' ? 'stored' : 'replace'}>{editor?.kind === 'create' ? 'Store token securely' : 'Replace stored token'}</SingleSelectOption>
      <SingleSelectOption value="environment">Use environment variable</SingleSelectOption>
    </SingleSelect></Field.Root>
    {draft.mode === 'stored' || draft.mode === 'replace' ? <Field.Root required><Field.Label>Bot token</Field.Label><TextInput type="password" autoComplete="new-password" value={draft.token} onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, token: event.target.value }); setValidatedBot(null); }} /><Field.Hint>The existing token is never displayed. Telegram validates this token before it is saved.</Field.Hint></Field.Root> : null}
    {draft.mode === 'environment' ? <Field.Root required><Field.Label>Environment variable</Field.Label><TextInput value={draft.variableName} placeholder="TELEGRAM_BOT_TOKEN" onChange={(event: ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, variableName: event.target.value.toUpperCase() }); setValidatedBot(null); }} /></Field.Root> : null}
    {validatedBot ? <Alert variant="success" title="Bot validated">{validatedBot.displayName}{validatedBot.username ? ` (@${validatedBot.username})` : ''}</Alert> : null}
  </Flex></Dialog.Body><Dialog.Footer><Dialog.Cancel><Button variant="tertiary">Cancel</Button></Dialog.Cancel><Button loading={saving} disabled={!valid} onClick={save}>Validate and save</Button></Dialog.Footer></Dialog.Content></Dialog.Root>;
};
