/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { createTelegramConnectionService, type ConnectionDependencies } from './connection';
import { createTelegramDeliveryService, type TelegramDeliveryInput } from './delivery';
import { renderTelegramTemplate } from './template';
import type { TelegramNotificationSettings } from './types';

export const createTelegramService = (
  dependencies: ConnectionDependencies & { logger?: { error(message: string, metadata: Record<string, unknown>): void } }
) => {
  const connection = createTelegramConnectionService(dependencies);
  const delivery = createTelegramDeliveryService({
    resolveCredential: connection.resolveCredential,
    fetch: dependencies.fetch as any,
    logger: dependencies.logger ?? { error() {} },
  });
  return {
    ...connection,
    ...delivery,
    dispatchForSubmission(
      form: { fields?: unknown[]; settings?: { telegramNotification?: TelegramNotificationSettings } },
      submission: { data?: Record<string, unknown> }
    ): void {
      const settings = form.settings?.telegramNotification;
      if (!settings?.enabled) return;
      const fields = (form.fields ?? []) as Array<{ id: string; name: string }>;
      const dataByFieldId = Object.fromEntries(fields.map((field) => [
        field.id,
        (submission.data ?? {})[field.name],
      ]));
      const rendered = renderTelegramTemplate(settings.template, fields as any, dataByFieldId);
      if (rendered.errors.length) {
        dependencies.logger?.error('Telegram delivery failed', { failure: 'template' });
        return;
      }
      void (async () => {
        if (dependencies.license.can?.('integrations') !== true) return;
        const selected = (await connection.listConnections()).find((item) => item.id === settings.connectionId);
        if (!selected?.active) return;
        const input: TelegramDeliveryInput = {
          connectionId: settings.connectionId,
          destination: settings.destination,
          html: rendered.html,
        };
        await delivery.sendRichNotification(input);
      })().catch(() => {
        dependencies.logger?.error('Telegram delivery failed', { failure: 'unknown' });
      });
    },
  };
};

export * from './connection';
export * from './crypto';
export * from './delivery';
