/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { randomUUID } from 'node:crypto';
import type { TelegramBotMetadata, TelegramConnectionId, TelegramCredentialInput } from './types';

const STORE_KEY = 'telegram.connections';

type Limit = number | 'unlimited';
type Fetch = (input: string, init?: { method?: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
interface StoredConnection {
  id: string; name: string; token: string; bot: TelegramBotMetadata;
  createdAt: string; updatedAt: string;
}
interface StoredDocument { version: 1; connections: StoredConnection[] }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStoredConnection = (value: unknown): value is StoredConnection => {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !isObject(value.bot) ||
    typeof value.bot.id !== 'string' || typeof value.bot.displayName !== 'string' ||
    (value.bot.username !== undefined && typeof value.bot.username !== 'string')) return false;
  return typeof value.token === 'string' && value.token.trim().length > 0 && value.token.length <= 512;
};

export interface ConnectionDependencies {
  store: { get(input: { key: string }): Promise<unknown>; set(input: { key: string; value: unknown }): Promise<unknown> };
  license: { limit(key: 'telegramConnections'): Limit };
  fetch: Fetch;
  now?: () => Date;
  randomUUID?: () => string;
  referenceCount?: (id: string) => Promise<number>;
}

export type TokenAction = { type: 'keep' } | { type: 'replace'; token: string };
export interface SafeConnection {
  id: TelegramConnectionId; name: string;
  bot: TelegramBotMetadata; createdAt: string; updatedAt: string;
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
    bot: record.bot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: isActive(index),
    referenceCount: await count(record.id),
  });
  const validateToken = async (value: string): Promise<TelegramBotMetadata> => {
    try {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
        throw genericValidationError();
      }
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
    if (input.type !== 'stored' || !input.token) throw genericValidationError();
    return validateToken(input.token.trim());
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
      const bot = await validateCredential(input.credential);
      const timestamp = (deps.now?.() ?? new Date()).toISOString();
      const record: StoredConnection = {
        id: (deps.randomUUID ?? randomUUID)(), name: input.name, token: input.credential.token.trim(), bot,
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
      let token = previous.token;
      let bot = previous.bot;
      if (input.credential.type === 'replace') {
        bot = await validateCredential({ type: 'stored', token: input.credential.token });
        token = input.credential.token.trim();
      }
      const updated = { ...previous, name: input.name ?? previous.name, token, bot,
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
      return record.token;
    },
    validateCredential,
  };
}

export type TelegramConnectionService = ReturnType<typeof createTelegramConnectionService>;
