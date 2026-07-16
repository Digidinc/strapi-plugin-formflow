/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { randomUUID } from 'node:crypto';
import type { TelegramBotMetadata, TelegramConnectionId, TelegramCredentialInput } from './types';
import { assertEncryptionKey, decryptSecret, encryptSecret, isEncryptedSecret, type EncryptedSecret } from './crypto';

const STORE_KEY = 'telegram.connections';
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;

type Limit = number | 'unlimited';
type Fetch = (input: string, init?: { method?: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
type StoredSource =
  | { type: 'stored'; secret: EncryptedSecret }
  | { type: 'environment'; variableName: string };
interface StoredConnection {
  id: string; name: string; tokenSource: StoredSource; bot: TelegramBotMetadata;
  createdAt: string; updatedAt: string;
}
interface StoredDocument { version: 1; connections: StoredConnection[] }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStoredConnection = (value: unknown): value is StoredConnection => {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !isObject(value.bot) ||
    typeof value.bot.id !== 'string' || typeof value.bot.displayName !== 'string' ||
    (value.bot.username !== undefined && typeof value.bot.username !== 'string') || !isObject(value.tokenSource)) return false;
  const source = value.tokenSource;
  if (source.type === 'environment') return typeof source.variableName === 'string' && ENVIRONMENT_NAME.test(source.variableName);
  return source.type === 'stored' && isEncryptedSecret(source.secret);
};

export interface ConnectionDependencies {
  store: { get(input: { key: string }): Promise<unknown>; set(input: { key: string; value: unknown }): Promise<unknown> };
  environment: Record<string, string | undefined>;
  encryptionKey?: string;
  license: { limit(key: 'telegramConnections'): Limit };
  fetch: Fetch;
  now?: () => Date;
  randomUUID?: () => string;
  referenceCount?: (id: string) => Promise<number>;
}

export type TokenAction = { type: 'keep' } | { type: 'replace'; token: string } |
  { type: 'switch-to-environment'; variableName: string };
export interface SafeConnection {
  id: TelegramConnectionId; name: string;
  tokenSource: { type: 'stored' } | { type: 'environment'; variableName: string };
  credentialConfigured: boolean; bot: TelegramBotMetadata; createdAt: string; updatedAt: string;
  active: boolean; referenceCount: number;
}

const genericValidationError = () => new Error('Telegram credential validation failed. Check the credential and try again.');

export function createTelegramConnectionService(dependencies: ConnectionDependencies) {
  const deps = dependencies;
  const load = async (): Promise<StoredDocument> => {
    const value = await deps.store.get({ key: STORE_KEY }) as Partial<StoredDocument> | null;
    if (value === null || value === undefined) return { version: 1, connections: [] };
    if (typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.connections) ||
      !value.connections.every(isStoredConnection)) {
      throw new Error('Stored Telegram connection data is invalid. Restore or remove the corrupt plugin-store record before continuing.');
    }
    return { version: 1, connections: value.connections };
  };
  const save = (document: StoredDocument) => deps.store.set({ key: STORE_KEY, value: document });
  const limit = (): Limit => deps.license.limit('telegramConnections');
  const isActive = (index: number): boolean => limit() === 'unlimited' || index < Math.max(0, limit() as number);
  const count = (id: string) => deps.referenceCount?.(id) ?? Promise.resolve(0);
  const safe = async (record: StoredConnection, index: number): Promise<SafeConnection> => ({
    id: record.id as TelegramConnectionId,
    name: record.name,
    tokenSource: record.tokenSource.type === 'stored'
      ? { type: 'stored' }
      : { type: 'environment', variableName: record.tokenSource.variableName },
    credentialConfigured: record.tokenSource.type === 'stored' || Boolean(deps.environment[record.tokenSource.variableName]),
    bot: record.bot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: isActive(index),
    referenceCount: await count(record.id),
  });
  const resolveSource = (source: StoredSource): string => {
    if (source.type === 'stored') return decryptSecret(source.secret, deps.encryptionKey);
    if (!ENVIRONMENT_NAME.test(source.variableName)) throw new Error('The Telegram environment variable name is invalid.');
    const value = deps.environment[source.variableName];
    if (!value) throw new Error('The configured Telegram environment variable is not configured.');
    return value;
  };
  const validateToken = async (value: string): Promise<TelegramBotMetadata> => {
    try {
      const response = await deps.fetch(`https://api.telegram.org/bot${value}/getMe`, { method: 'GET' });
      const body = await response.json() as { ok?: unknown; result?: { id?: unknown; first_name?: unknown; username?: unknown } };
      if (!response.ok || body.ok !== true || !body.result || typeof body.result.id !== 'number' || typeof body.result.first_name !== 'string') {
        throw genericValidationError();
      }
      return {
        id: String(body.result.id), displayName: body.result.first_name,
        ...(typeof body.result.username === 'string' ? { username: body.result.username } : {}),
      };
    } catch {
      throw genericValidationError();
    }
  };
  const validateCredential = async (input: TelegramCredentialInput): Promise<TelegramBotMetadata> => {
    if (input.type === 'stored') {
      if (!input.token) throw genericValidationError();
      return validateToken(input.token);
    }
    if (!ENVIRONMENT_NAME.test(input.variableName)) throw new Error('Telegram environment variable name must contain only uppercase letters, digits, and underscores.');
    const value = deps.environment[input.variableName];
    if (!value) throw new Error('The Telegram environment variable is not configured.');
    return validateToken(value);
  };

  return {
    /** Exposed to support dependency replacement in isolated service tests. */
    dependencies: deps,
    async listConnections(): Promise<SafeConnection[]> {
      const document = await load();
      return Promise.all(document.connections.map(safe));
    },
    async createConnection(input: { name: string; credential: TelegramCredentialInput }): Promise<SafeConnection> {
      const document = await load();
      const max = limit();
      if (max !== 'unlimited' && document.connections.length >= Math.max(0, max)) {
        throw new Error('Telegram connection limit reached for the current license.');
      }
      if (input.credential.type === 'stored') assertEncryptionKey(deps.encryptionKey);
      const bot = await validateCredential(input.credential);
      const source: StoredSource = input.credential.type === 'stored'
        ? { type: 'stored', secret: encryptSecret(input.credential.token, deps.encryptionKey) }
        : { type: 'environment', variableName: input.credential.variableName };
      const timestamp = (deps.now?.() ?? new Date()).toISOString();
      const record: StoredConnection = {
        id: (deps.randomUUID ?? randomUUID)(), name: input.name, tokenSource: source, bot,
        createdAt: timestamp, updatedAt: timestamp,
      };
      document.connections.push(record);
      await save(document);
      return safe(record, document.connections.length - 1);
    },
    async updateConnection(id: string, input: { name?: string; credential: TokenAction }): Promise<SafeConnection> {
      const document = await load();
      const index = document.connections.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Telegram connection not found.');
      const previous = document.connections[index];
      let source = previous.tokenSource;
      let bot = previous.bot;
      if (input.credential.type === 'replace') {
        assertEncryptionKey(deps.encryptionKey);
        bot = await validateCredential({ type: 'stored', token: input.credential.token });
        source = { type: 'stored', secret: encryptSecret(input.credential.token, deps.encryptionKey) };
      } else if (input.credential.type === 'switch-to-environment') {
        bot = await validateCredential({ type: 'environment', variableName: input.credential.variableName });
        source = { type: 'environment', variableName: input.credential.variableName };
      }
      const updated = { ...previous, name: input.name ?? previous.name, tokenSource: source, bot,
        updatedAt: (deps.now?.() ?? new Date()).toISOString() };
      document.connections[index] = updated;
      await save(document);
      return safe(updated, index);
    },
    async deleteConnection(id: string): Promise<{ id: TelegramConnectionId; referenceCount: number }> {
      const document = await load();
      const index = document.connections.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Telegram connection not found.');
      const referenceCount = await count(id);
      document.connections.splice(index, 1);
      await save(document);
      return { id: id as TelegramConnectionId, referenceCount };
    },
    async resolveCredential(id: string): Promise<string> {
      const document = await load();
      const record = document.connections.find((item) => item.id === id);
      if (!record) throw new Error('Telegram connection not found.');
      return resolveSource(record.tokenSource);
    },
    validateCredential,
  };
}

export type TelegramConnectionService = ReturnType<typeof createTelegramConnectionService>;
