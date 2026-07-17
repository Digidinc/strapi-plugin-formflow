import type { Core } from '@strapi/strapi';

export interface TelegramService {
  listConnections(): Promise<unknown[]>;
  createConnection(input: unknown): Promise<unknown>;
  updateConnection(id: string, input: unknown): Promise<unknown>;
  deleteConnection(id: string): Promise<unknown>;
  resolveCredential(id: string): Promise<string>;
  validateCredential(input: unknown): Promise<unknown>;
  sendRichNotification(input: unknown): Promise<unknown>;
  dispatchForSubmission(form: unknown, submission: unknown): void;
}

interface EeTelegramService extends TelegramService {}

const unavailable = () => new Error('Telegram connections are unavailable in this build.');

export async function countTelegramConnectionReferences(strapi: Core.Strapi, id: string): Promise<number> {
  const forms = await strapi.documents('plugin::formflow.form').findMany({
    fields: ['settings'], status: 'draft', limit: -1,
  } as any) as Array<{ settings?: unknown }>;
  return forms.reduce((total, form) => {
    const settings = form.settings;
    if (typeof settings !== 'object' || settings === null) return total;
    const telegram = (settings as { telegramNotification?: unknown }).telegramNotification;
    return typeof telegram === 'object' && telegram !== null &&
      (telegram as { connectionId?: unknown }).connectionId === id ? total + 1 : total;
  }, 0);
}

/** MIT-safe boundary: the commercial implementation is only loaded on demand. */
const telegramService = ({ strapi }: { strapi: Core.Strapi }): TelegramService => {
  let implementation: EeTelegramService | null = null;
  let loading: Promise<void> | null = null;
  const load = (): Promise<void> => {
    if (loading) return loading;
    loading = (async () => {
      try {
        const mod = await import('../ee/telegram');
        const plugin = strapi.plugin('formflow');
        implementation = mod.createTelegramService({
          store: strapi.store({ type: 'plugin', name: 'formflow' }),
          environment: process.env,
          encryptionKey: strapi.config.get('plugin::formflow.telegram.encryptionKey') as string | undefined,
          license: plugin.service('license'),
          fetch: globalThis.fetch as any,
          referenceCount: (id: string) => countTelegramConnectionReferences(strapi, id),
          logger: strapi.log,
        }) as EeTelegramService;
      } catch {
        implementation = null;
      }
    })();
    return loading;
  };
  const use = async (): Promise<EeTelegramService> => {
    await load();
    if (!implementation) throw unavailable();
    return implementation;
  };
  return {
    async listConnections() { await load(); return implementation ? implementation.listConnections() : []; },
    async createConnection(input) { return (await use()).createConnection(input); },
    async updateConnection(id, input) { return (await use()).updateConnection(id, input); },
    async deleteConnection(id) { return (await use()).deleteConnection(id); },
    async resolveCredential(id) { return (await use()).resolveCredential(id); },
    async validateCredential(input) { return (await use()).validateCredential(input); },
    async sendRichNotification(input) { return (await use()).sendRichNotification(input); },
    dispatchForSubmission(form, submission) {
      void use().then((service) => service.dispatchForSubmission(form, submission)).catch(() => {
        strapi.log.error('Telegram delivery failed', { failure: 'configuration' });
      });
    },
  };
};

export default telegramService;
