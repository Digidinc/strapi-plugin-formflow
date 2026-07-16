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
      form: { fields?: unknown[]; settings?: { telegram?: TelegramNotificationSettings } },
      submission: { data?: Record<string, unknown> }
    ): void {
      const settings = form.settings?.telegram;
      if (!settings?.enabled) return;
      const rendered = renderTelegramTemplate(settings.template, (form.fields ?? []) as any, submission.data ?? {});
      if (rendered.errors.length) {
        dependencies.logger?.error('Telegram delivery failed', { failure: 'template' });
        return;
      }
      const input: TelegramDeliveryInput = {
        connectionId: settings.connectionId,
        destination: settings.destination,
        html: rendered.html,
      };
      void delivery.sendRichNotification(input).catch(() => {
        dependencies.logger?.error('Telegram delivery failed', { failure: 'unknown' });
      });
    },
  };
};

export * from './connection';
export * from './crypto';
export * from './delivery';
