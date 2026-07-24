import type { Core } from '@strapi/strapi';

type RecordValue = Record<string, unknown>;
export interface TelegramControllerContext { params: { id?: string; formId?: string }; request: { body: unknown }; status: number; notFound(message?: string): unknown }
export type Context = TelegramControllerContext;

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: RecordValue, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const destinationValid = (value: unknown): value is string => typeof value === 'string' &&
  (/^-?[1-9]\d{0,19}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value));

const errorBody = (status: number, name: string, message: string, details: RecordValue = {}) => ({
  error: { status, name, message, details },
});
const invalid = (ctx: Context, message: string, details: RecordValue = {}) => {
  ctx.status = 400;
  return errorBody(400, 'ValidationError', message, details);
};
const telegramUnavailable = (ctx: Context, resolution = 'resolved') => {
  ctx.status = 402;
  return errorBody(402, 'PaymentRequired', resolution === 'resolved'
    ? 'Telegram connections are unavailable in this build.'
    : 'FormFlow could not verify Telegram availability. Check the license status, then retry.', {
    feature: 'telegramConnections', resolution,
  });
};
const connectionLimitReached = (ctx: Context) => {
  ctx.status = 402;
  return errorBody(402, 'PaymentRequired', 'Telegram connection limit reached for the current plan.', {
    feature: 'telegramConnections',
  });
};

const credential = (value: unknown): boolean => isRecord(value) && exact(value, ['type', 'token']) &&
  value.type === 'stored' && typeof value.token === 'string' &&
  value.token.trim().length > 0 && value.token.length <= 512;
const createInput = (value: unknown): value is RecordValue => isRecord(value) && exact(value, ['name', 'credential']) &&
  typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 100 && credential(value.credential);
const updateInput = (value: unknown): value is RecordValue => isRecord(value) && exact(value, ['name', 'credential']) &&
  (value.name === undefined || (typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 100)) &&
  isRecord(value.credential) && exact(value.credential, value.credential.type === 'keep' ? ['type'] : ['type', 'token']) &&
  (value.credential.type === 'keep' ||
   (value.credential.type === 'replace' && typeof value.credential.token === 'string' &&
    value.credential.token.trim().length > 0 && value.credential.token.length <= 512));
const validationInput = (value: unknown): value is RecordValue => isRecord(value) && exact(value, ['credential']) && credential(value.credential);
const testInput = (value: unknown): value is RecordValue => isRecord(value) && exact(value, ['connectionId', 'destination', 'template']) &&
  typeof value.connectionId === 'string' && value.connectionId.length > 0 && destinationValid(value.destination) && isRecord(value.template);

const safeServiceError = (ctx: Context, error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (/not found/i.test(message)) { ctx.status = 404; return errorBody(404, 'NotFoundError', 'Telegram connection not found.'); }
  if (/limit reached|current license/i.test(message)) return connectionLimitReached(ctx);
  ctx.status = 400;
  const safe = /credential validation/i.test(message) ? 'Telegram credential validation failed. Check the credential and try again.'
    : /referenced/i.test(message) ? 'The Telegram connection is still referenced by a form.'
    : 'Telegram configuration could not be saved. Check the supplied values and try again.';
  return errorBody(400, 'ValidationError', safe);
};

const sampleFor = (field: RecordValue): unknown => field.type === 'checkbox' || field.type === 'toggle' ? true
  : field.type === 'number' ? 42 : field.type === 'email' ? 'person@example.com'
  : field.type === 'date' ? '2026-01-01' : field.type === 'file' ? { name: 'example.pdf', size: 1024 }
  : `Sample ${typeof field.label === 'string' ? field.label : 'value'}`;

const telegramController = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = () => strapi.plugin('formflow').service('telegram');
  const license = () => strapi.plugin('formflow').service('license');
  const gated = (ctx: Context) => {
    const limit = license().limit('telegramConnections');
    return limit === 'unlimited' || (typeof limit === 'number' && limit > 0)
      ? null
      : telegramUnavailable(ctx, license().resolution?.() ?? 'unresolved');
  };
  return {
    async list(ctx: Context) { return { data: await service().listConnections() }; },
    async create(ctx: Context) {
      const gate = gated(ctx); if (gate) return gate;
      if (!createInput(ctx.request.body)) return invalid(ctx, 'A valid name and credential are required.');
      try { ctx.status = 201; return { data: await service().createConnection(ctx.request.body) }; }
      catch (error) { return safeServiceError(ctx, error); }
    },
    async update(ctx: Context) {
      const gate = gated(ctx); if (gate) return gate;
      if (!ctx.params.id || !updateInput(ctx.request.body)) return invalid(ctx, 'A valid connection update is required.');
      try { return { data: await service().updateConnection(ctx.params.id, ctx.request.body) }; }
      catch (error) { return safeServiceError(ctx, error); }
    },
    async delete(ctx: Context) {
      const gate = gated(ctx); if (gate) return gate;
      if (!ctx.params.id) return invalid(ctx, 'Connection ID is required.');
      try { return { data: await service().deleteConnection(ctx.params.id) }; }
      catch (error) { return safeServiceError(ctx, error); }
    },
    async validate(ctx: Context) {
      const gate = gated(ctx); if (gate) return gate;
      if (!validationInput(ctx.request.body)) return invalid(ctx, 'A valid credential is required.');
      try { return { data: await service().validateCredential(ctx.request.body.credential) }; }
      catch (error) { return safeServiceError(ctx, error); }
    },
    async test(ctx: Context) {
      const gate = gated(ctx); if (gate) return gate;
      if (!ctx.params.formId || !testInput(ctx.request.body)) return invalid(ctx, 'Connection, destination, and template are required.');
      const body = ctx.request.body;
      let stage: 'form' | 'connections' | 'render' | 'delivery' = 'form';
      try {
        const form = await strapi.plugin('formflow').service('form').findOne(ctx.params.formId);
        if (!form) return ctx.notFound('Form not found');
        const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
        stage = 'render';
        const { validateTemplate, renderTelegramTemplate } = await import('../ee/telegram/template');
        const checked = validateTemplate(body.template as any, fields as any);
        if (!checked.valid) return invalid(ctx, 'Telegram template is invalid.', { errors: checked.errors, warnings: checked.warnings });
        stage = 'connections';
        const connections = await service().listConnections() as Array<{ id?: unknown; active?: unknown }>;
        if (!connections.some((item) => item.id === body.connectionId && item.active === true)) return invalid(ctx, 'Select an active Telegram connection.');
        stage = 'render';
        const samples = Object.fromEntries(fields.filter((field) => typeof field.id === 'string').map((field) => [field.id as string, sampleFor(field)]));
        const rendered = renderTelegramTemplate(body.template as any, fields as any, samples);
        if (rendered.errors.length) return invalid(ctx, 'Telegram template could not be rendered.', { errors: rendered.errors });
        stage = 'delivery';
        const result = await service().sendRichNotification({ connectionId: body.connectionId, destination: body.destination, html: rendered.html }) as any;
        if (result?.ok) return { data: { success: true, warnings: checked.warnings } };
        const messages: Record<string, string> = { authentication: 'The bot credential is invalid.', destination: 'Telegram could not find that destination.', permission: 'The bot cannot post to that destination.', rate_limit: 'Telegram rate limited the request. Try again later.', telegram_server: 'Telegram is temporarily unavailable.', network: 'Telegram could not be reached.', timeout: 'Telegram did not respond in time.', configuration: 'The Telegram connection is not configured correctly.', template: 'The Telegram template is invalid.', unknown: 'Telegram could not send the test message.' };
        ctx.status = 400;
        return errorBody(400, 'TelegramDeliveryError', messages[result?.failure] ?? messages.unknown, { failure: result?.failure ?? 'unknown' });
      } catch {
        strapi.log.error('Telegram test message failed', { stage });
        ctx.status = 500;
        const messages = {
          form: 'The form configuration could not be loaded. Try again.',
          connections: 'Telegram connections could not be loaded. Check the plugin configuration and try again.',
          render: 'The Telegram test message could not be prepared. Check the template and try again.',
          delivery: 'The Telegram test message could not be sent. Check the connection and try again.',
        };
        return errorBody(500, 'ApplicationError', messages[stage]);
      }
    },
  };
};

export { destinationValid };
export default telegramController;
