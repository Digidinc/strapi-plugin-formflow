/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type { TelegramFailure } from './types';

const MAX_RESPONSE_BYTES = 64 * 1024;

type FetchResponse = {
  ok: boolean;
  status: number;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } } | null;
};

export type TelegramDeliveryResult =
  | { ok: true; messageId?: number }
  | { ok: false; failure: TelegramFailure; errorCode?: number; retryAfter?: number };

export interface TelegramDeliveryInput {
  connectionId: string;
  destination: string;
  html: string;
}

export interface TelegramDeliveryDependencies {
  resolveCredential(id: string): Promise<string>;
  fetch(input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<FetchResponse>;
  /** Explicit null means this Bot API method is unavailable in the active client. */
  sendRichMessage?: ((token: string, input: TelegramDeliveryInput, signal: AbortSignal) => Promise<FetchResponse>) | null;
  logger: { error(message: string, metadata: Record<string, unknown>): void };
  timeoutMs?: number;
}

class ConfigurationFailure extends Error {}
class TimeoutFailure extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readBounded(response: FetchResponse): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const classify = (status: number, body: unknown): Extract<TelegramDeliveryResult, { ok: false }> => {
  const errorCode = object(body) && typeof body.error_code === 'number' ? body.error_code : status;
  const description = object(body) && typeof body.description === 'string' ? body.description.toLowerCase() : '';
  let failure: TelegramFailure = 'unknown';
  if (status === 401 || errorCode === 401) failure = 'authentication';
  else if (status === 429 || errorCode === 429) failure = 'rate_limit';
  else if (status >= 500) failure = 'telegram_server';
  else if ((status === 400 || status === 404) && description.includes('sendrichmessage') &&
    (description.includes('not found') || description.includes('unsupported'))) failure = 'configuration';
  else if (description.includes('chat not found')) failure = 'destination';
  else if (status === 403 || description.includes('forbidden') || description.includes('cannot post')) failure = 'permission';
  const parameters = object(body) && object(body.parameters) ? body.parameters : undefined;
  const retryAfter = parameters && typeof parameters.retry_after === 'number' && Number.isFinite(parameters.retry_after)
    ? parameters.retry_after : undefined;
  return { ok: false, failure, errorCode, ...(failure === 'rate_limit' && retryAfter !== undefined ? { retryAfter } : {}) };
};

export function createTelegramDeliveryService(dependencies: TelegramDeliveryDependencies) {
  return {
    async sendRichNotification(input: TelegramDeliveryInput): Promise<TelegramDeliveryResult> {
      const controller = new AbortController();
      let rejectTimeout!: (error: Error) => void;
      const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        rejectTimeout(new TimeoutFailure());
      }, dependencies.timeoutMs ?? 10_000);
      try {
        const operation = (async () => {
          let token: string;
          try {
            token = await dependencies.resolveCredential(input.connectionId);
          } catch {
            throw new ConfigurationFailure();
          }
          const response = dependencies.sendRichMessage
            ? await dependencies.sendRichMessage(token, input, controller.signal)
            : await dependencies.fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: input.destination, message: { html: input.html } }),
              signal: controller.signal,
            });
          return { response, body: await readBounded(response) };
        })();
        const { response, body } = await Promise.race([operation, timeout]);
        if (response.ok && object(body) && body.ok === true) {
          const result = object(body.result) ? body.result : undefined;
          return { ok: true, ...(result && typeof result.message_id === 'number' ? { messageId: result.message_id } : {}) };
        }
        const classified = classify(response.status, body);
        dependencies.logger.error('Telegram delivery failed', {
          failure: classified.failure,
          ...(classified.errorCode !== undefined ? { errorCode: classified.errorCode } : {}),
          ...(classified.retryAfter !== undefined ? { retryAfter: classified.retryAfter } : {}),
        });
        return classified;
      } catch (error) {
        const timedOut = error instanceof TimeoutFailure || controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');
        const configured = error instanceof ConfigurationFailure;
        const result: TelegramDeliveryResult = {
          ok: false, failure: timedOut ? 'timeout' : configured ? 'configuration' : 'network',
        };
        dependencies.logger.error('Telegram delivery failed', { failure: result.failure });
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type TelegramDeliveryService = ReturnType<typeof createTelegramDeliveryService>;
