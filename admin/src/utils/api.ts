import { PLUGIN_ID } from '../pluginId';

/**
 * API endpoint builders for the formflow plugin
 */
export const API = {
  // Forms
  forms: `/${PLUGIN_ID}/forms`,
  formsCount: `/${PLUGIN_ID}/forms/count`,
  form: (id: string) => `/${PLUGIN_ID}/forms/${id}`,
  duplicateForm: (id: string) => `/${PLUGIN_ID}/forms/${id}/duplicate`,

  // Submissions
  submissions: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/submissions`,
  submissionStats: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/submissions/stats`,
  submission: (id: string) => `/${PLUGIN_ID}/submissions/${id}`,
  // Approval workflow transition (Business). Server gates with a 402 when unentitled.
  approveSubmission: (id: string) => `/${PLUGIN_ID}/submissions/${id}/approve`,
  // Batch delete is a POST (Koa does not parse a DELETE request body), so the
  // ids travel in the JSON body of POST /forms/:formId/submissions/bulk-delete.
  bulkDeleteSubmissions: (formId: string) =>
    `/${PLUGIN_ID}/forms/${formId}/submissions/bulk-delete`,
  // NOTE: the export endpoint is nested under the submissions collection on the server
  // (GET /formflow/forms/:formId/submissions/export).
  exportSubmissions: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/submissions/export`,
  // Scheduled-export CRUD (Pro). GET reads, POST saves, DELETE clears.
  scheduleExport: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/submissions/schedule-export`,

  // Webhooks
  testWebhook: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/webhooks/test`,

  // Global Telegram connection settings (admin-only).
  telegramConnections: `/${PLUGIN_ID}/settings/telegram/connections`,
  telegramConnection: (id: string) => `/${PLUGIN_ID}/settings/telegram/connections/${id}`,
  validateTelegramConnection: `/${PLUGIN_ID}/settings/telegram/connections/validate`,
  testTelegramConnection: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/telegram/test`,

  // Analytics (Pro). Server gates with a 402 when unentitled.
  formAnalytics: (formId: string) => `/${PLUGIN_ID}/forms/${formId}/analytics`,

  // Field Types
  fieldTypes: `/${PLUGIN_ID}/field-types`,

  // Save & resume (Pro). These are PUBLIC content-api endpoints, served under
  // the `/api/${PLUGIN_ID}/forms/...` content-api prefix (NOT the admin plugin
  // routes the helpers above use). The server gates them with a 402 when the
  // license is not entitled.
  savePartialForm: (slug: string) => `/api/${PLUGIN_ID}/forms/${slug}/partial`,
  getPartialForm: (slug: string, resumeToken: string) =>
    `/api/${PLUGIN_ID}/forms/${slug}/partial/${resumeToken}`,
} as const;

export interface TelegramBotMetadataResponse {
  id: string;
  displayName: string;
  username?: string;
}

/** Safe server response. It deliberately cannot contain a bot token. */
export interface TelegramConnectionResponse {
  id: string;
  name: string;
  tokenSource: { type: 'stored' } | { type: 'environment'; variableName: string };
  credentialConfigured: boolean;
  bot: TelegramBotMetadataResponse;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  referenceCount: number;
}

export type TelegramCreateCredentialRequest =
  | { type: 'stored'; token: string }
  | { type: 'environment'; variableName: string };
export type TelegramUpdateCredentialRequest =
  | { type: 'keep' }
  | { type: 'replace'; token: string }
  | { type: 'switch-to-environment'; variableName: string };
export interface TelegramCreateConnectionRequest {
  name: string;
  credential: TelegramCreateCredentialRequest;
}
export interface TelegramUpdateConnectionRequest {
  name: string;
  credential: TelegramUpdateCredentialRequest;
}
export interface TelegramCredentialDraft {
  mode: 'keep' | 'replace' | 'stored' | 'environment';
  token: string;
  variableName: string;
}

type CreateDraft = { mode: 'stored'; token: string } | { mode: 'environment'; variableName: string };
type UpdateDraft = { mode: 'keep' } | { mode: 'replace'; token: string } | { mode: 'environment'; variableName: string };

export const buildTelegramCreateRequest = (name: string, draft: CreateDraft): TelegramCreateConnectionRequest => ({
  name: name.trim(),
  credential: draft.mode === 'stored'
    ? { type: 'stored', token: draft.token.trim() }
    : { type: 'environment', variableName: draft.variableName.trim() },
});

export const buildTelegramUpdateRequest = (name: string, draft: UpdateDraft): TelegramUpdateConnectionRequest => ({
  name: name.trim(),
  credential: draft.mode === 'keep'
    ? { type: 'keep' }
    : draft.mode === 'replace'
      ? { type: 'replace', token: draft.token.trim() }
      : { type: 'switch-to-environment', variableName: draft.variableName.trim() },
});

export const resetTelegramCredentialDraft = (): TelegramCredentialDraft => ({
  mode: 'keep', token: '', variableName: '',
});

export const connectionLimitMessage = (used: number, limit: number | 'unlimited'): string =>
  limit === 'unlimited'
    ? `${used} connections configured.`
    : used >= limit
      ? `Connection limit reached (${used} of ${limit}).`
      : `${used} of ${limit} connections used.`;

export const deletionReferenceWarning = (count: number): string =>
  count === 0
    ? 'This connection is not referenced by any forms.'
    : `This connection is used by ${count} ${count === 1 ? 'form' : 'forms'}. Deleting it will disconnect ${count === 1 ? 'that form' : 'those forms'}.`;

export const connectionAvailability = (connection: Pick<TelegramConnectionResponse, 'active' | 'credentialConfigured'>):
  'connected' | 'disconnected' | 'environment-missing' =>
  !connection.credentialConfigured ? 'environment-missing' : connection.active ? 'connected' : 'disconnected';

export const telegramConnectionMutationPolicy = (active: boolean, canUpdate: boolean) => ({
  canEdit: active && canUpdate,
  // Deletion remains available for inactive excess records so an administrator
  // can recover to the licensed limit without first upgrading.
  canDelete: canUpdate,
});

export const telegramValidationMatches = (
  validatedFingerprint: string | null,
  currentFingerprint: string,
  bot: TelegramBotMetadataResponse | null
): boolean => bot !== null && validatedFingerprint === currentFingerprint;

export const telegramDraftCanSave = (
  mode: TelegramCredentialDraft['mode'],
  validatedFingerprint: string | null,
  currentFingerprint: string,
  validatedBot: TelegramBotMetadataResponse | null,
  existingBot: TelegramBotMetadataResponse | null
): boolean => mode === 'keep'
  ? existingBot !== null
  : telegramValidationMatches(validatedFingerprint, currentFingerprint, validatedBot);

export const telegramDraftCanSubmit = (
  name: string,
  mode: TelegramCredentialDraft['mode'],
  validatedFingerprint: string | null,
  currentFingerprint: string,
  validatedBot: TelegramBotMetadataResponse | null,
  existingBot: TelegramBotMetadataResponse | null
): boolean => name.trim().length > 0 && telegramDraftCanSave(
  mode, validatedFingerprint, currentFingerprint, validatedBot, existingBot
);

/**
 * Resolve the admin JWT the same way `@strapi/admin`'s fetch client does:
 * primarily from localStorage (`jwtToken`), falling back to a cookie.
 *
 * Read fresh on every {@link rawRequest} call (never cached) so the latest token
 * written by Strapi's session/refresh lifecycle is always used.
 *
 * Used by {@link rawRequest} for the one call the standard `useFetchClient`
 * genuinely cannot perform: raw `text/csv` (or raw JSON text) exports. That
 * client always JSON-parses the response body via `response.json()` and, for a
 * `text/csv` body, swallows the resulting `SyntaxError` and returns `data: []`,
 * discarding the export entirely. There is no `responseType`/`text` option on
 * its `FetchOptions`, so a raw download must bypass it.
 */
const getAdminToken = (): string | null => {
  try {
    const fromStorage = window.localStorage.getItem('jwtToken');
    if (fromStorage) {
      return JSON.parse(fromStorage) as string;
    }
  } catch {
    // ignore malformed storage values and fall through to the cookie
  }

  const match = document.cookie.match(/(?:^|;\s*)jwtToken=([^;]+)/);
  if (match) {
    try {
      return JSON.parse(decodeURIComponent(match[1])) as string;
    } catch {
      return decodeURIComponent(match[1]);
    }
  }

  return null;
};

/**
 * Prefix a plugin-relative URL with the configured Strapi backend URL.
 */
const withBackendUrl = (url: string): string => {
  const backendURL = (window as unknown as { strapi?: { backendURL?: string } }).strapi?.backendURL;
  const normalized = url.charAt(0) === '/' ? url : `/${url}`;
  return backendURL ? `${backendURL}${normalized}` : normalized;
};

/**
 * Options for {@link rawRequest}.
 */
export interface RawRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
  /**
   * Read the response body as a Blob instead of text. Required for binary
   * exports (xlsx/pdf) where reading via `response.text()` would corrupt the
   * bytes. When set, {@link RawRequestResult.blob} is populated and `text` is
   * empty for a successful response.
   */
  responseType?: 'text' | 'blob';
}

/**
 * Result of a {@link rawRequest} call.
 */
export interface RawRequestResult {
  ok: boolean;
  status: number;
  text: string;
  blob?: Blob;
}

/**
 * Attempt to extract a human-readable error message from a Strapi error
 * response body. Strapi serializes errors as `{ error: { message } }`; fall
 * back to the raw text (or undefined) when the body is not JSON.
 */
const extractErrorMessage = (text: string): string | undefined => {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return parsed?.error?.message || parsed?.message || undefined;
  } catch {
    return text.trim() || undefined;
  }
};

/**
 * Perform an authenticated request using the native `fetch` API and return the
 * raw response body as text. This intentionally bypasses `useFetchClient` for
 * the one case it cannot handle: downloading a `text/csv` (or raw JSON) export
 * without JSON-parsing (and discarding) it.
 *
 * KNOWN LIMITATION: unlike `useFetchClient`, this path does not participate in
 * Strapi's `401 -> refresh token -> retry` lifecycle — it attaches the token as
 * read at call time. If that token has expired the request 401s with no retry.
 * The freshest token is read on every call ({@link getAdminToken}), so this only
 * bites when the token expires mid-session with no intervening admin call to
 * refresh it. A `401` is surfaced as a clear, actionable error telling the user
 * to reload (which reissues a fresh token), rather than a generic failure.
 *
 * Throws a descriptive `Error` when the admin token cannot be resolved (so the
 * request is never sent unauthenticated) and on any non-ok response, surfacing
 * the server's error message when the body can be parsed.
 */
export const rawRequest = async (
  url: string,
  options: RawRequestOptions
): Promise<RawRequestResult> => {
  const token = getAdminToken();
  if (!token) {
    throw new Error('Your session has expired. Please reload the page and try again.');
  }

  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const init: RequestInit = {
    method: options.method,
    headers,
    signal: options.signal,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(withBackendUrl(url), init);

  if (!response.ok) {
    // On error always read the body as text — the server returns a JSON/text
    // error payload (e.g. the 402 upsell) regardless of the requested format.
    const text = await response.text();

    // A 401 here means the locally-read token expired; this raw path cannot
    // refresh/retry the way `useFetchClient` does, so steer the user to the
    // one action that reissues a valid token: reloading the page.
    if (response.status === 401) {
      throw Object.assign(
        new Error('Your session has expired. Please reload the page and try again.'),
        { status: response.status }
      );
    }

    const serverMessage = extractErrorMessage(text);
    throw Object.assign(
      new Error(serverMessage || `Request failed with status ${response.status}`),
      { status: response.status }
    );
  }

  // Binary exports (xlsx/pdf) must be read as a Blob so the bytes are preserved.
  if (options.responseType === 'blob') {
    const blob = await response.blob();
    return { ok: response.ok, status: response.status, text: '', blob };
  }

  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
};

/**
 * All supported form field type names (25 total).
 * Mirrors the server `getFieldTypes()` registry.
 */
export type FieldTypeName =
  // basic
  | 'text'
  | 'textarea'
  | 'email'
  | 'number'
  | 'phone'
  | 'url'
  | 'password'
  // choice
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'boolean'
  // datetime
  | 'date'
  | 'time'
  | 'datetime'
  // advanced
  | 'file'
  | 'hidden'
  | 'signature'
  | 'rating'
  | 'address'
  | 'richtext'
  | 'calculated'
  | 'payment'
  | 'consent'
  // layout
  | 'heading'
  | 'paragraph'
  | 'divider';

/**
 * Category grouping for field types (used by the field selector)
 */
export type FieldTypeCategory = 'basic' | 'choice' | 'datetime' | 'advanced' | 'layout';

/**
 * Validation rule for form fields
 */
export interface ValidationRule {
  type: string;
  value?: unknown;
  message: string;
}

/**
 * Option for select/radio/checkbox fields
 */
export interface FieldOption {
  label: string;
  value: string;
}

/**
 * Conditional display rule for fields
 */
export interface ConditionalRule {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';
  value?: unknown;
}

/**
 * Form field definition
 */
export interface FormField {
  id: string;
  /** One of {@link FieldTypeName}; kept as a widened `string` for forward-compatibility. */
  type: string;
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
  validation: ValidationRule[];
  options?: FieldOption[];
  defaultValue?: unknown;
  order: number;
  width?: 'full' | 'half';
  conditional?: ConditionalRule;
  attributes?: Record<string, unknown>;
  /**
   * When true, this field is omitted from CSV/JSON submission exports (e.g.
   * sensitive values such as passwords or tokens). Defaults to false/absent, so
   * existing fields continue to be exported.
   */
  excludeFromExport?: boolean;
}

/**
 * A single step in a multi-step (wizard) form
 */
export interface FormStep {
  id: string;
  title: string;
  description?: string;
  fields: string[];
}

/**
 * Per-locale content overrides for a single field (Business multi-language).
 * Only UI content is localized — label, placeholder, description and option
 * labels — never field types, names, validation or conditional logic. Mirrors
 * the server's `FieldLocaleOverride` shape consumed by `getPublicSchema`.
 */
export interface FieldLocaleOverride {
  label?: string;
  placeholder?: string;
  description?: string;
  options?: FieldOption[];
}

/**
 * One locale's content overrides for a form: a map of fieldId -> override plus
 * an optional localized success message. Mirrors the server's `FormLocaleContent`.
 */
export interface FormLocaleContent {
  fields?: Record<string, FieldLocaleOverride>;
  successMessage?: string;
}

/**
 * The `locales` JSON map on a form: locale code -> per-locale content. This is
 * the plugin's own translation map (independent of host i18n); the public
 * schema applies a single locale's overrides when `?locale=` is requested.
 */
export type FormLocales = Record<string, FormLocaleContent>;

/**
 * Email notification configuration
 */
export interface EmailNotification {
  enabled: boolean;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  replyTo?: string;
  includeData?: boolean;
  /**
   * Optional custom email-body template. When non-empty, the server renders this
   * string (substituting `{{...}}` placeholders) as the email body instead of the
   * auto-generated layout. Supported placeholders: `{{form.title}}`, `{{form.slug}}`,
   * `{{submission.id}}`, `{{submission.createdAt}}`, `{{data.fieldName}}`, and a
   * `{{data}}` block that expands to all submitted fields. When empty/omitted the
   * default auto-generated body is used.
   */
  template?: string;
  /** Pro: when true, `to` is resolved at runtime from the submitter's email field. */
  isAutoresponder?: boolean;
  /** Pro: the form field name that supplies the submitter's email. Defaults to
   *  the first email-type field in the form when omitted. */
  toField?: string;
  /** Pro: when true, the "Sent by FormFlow" footer is omitted from the email. */
  omitBranding?: boolean;
}

/**
 * Webhook event types
 */
export type WebhookEvent = 'submission.created' | 'submission.updated' | 'submission.deleted';

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  enabled: boolean;
  url: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
  events: WebhookEvent[];
  includeFormData?: boolean;
  secret?: string;
  timeout?: number;
}

/**
 * Pre-built integration configurations (Pro). Each is a discriminated union
 * member keyed by `type`, mirroring the server-side types in
 * `server/src/ee/integrations/index.ts`. Stored verbatim in
 * `FormSettings.integrations`.
 */
export interface SlackIntegrationConfig {
  type: 'slack';
  enabled: boolean;
  webhookUrl: string;
  includeData?: boolean;
}
export interface GoogleSheetsIntegrationConfig {
  type: 'google_sheets';
  enabled: boolean;
  deploymentId: string;
  sheetId?: string;
}
export interface MailchimpIntegrationConfig {
  type: 'mailchimp';
  enabled: boolean;
  apiKey: string;
  serverPrefix: string;
  listId: string;
  emailField: string;
}
export interface HubSpotIntegrationConfig {
  type: 'hubspot';
  enabled: boolean;
  portalId: string;
  formGuid: string;
}
export interface NotionIntegrationConfig {
  type: 'notion';
  enabled: boolean;
  integrationToken: string;
  databaseId: string;
}
export interface ZapierIntegrationConfig {
  type: 'zapier';
  enabled: boolean;
  webhookUrl: string;
}
export interface MakeIntegrationConfig {
  type: 'make';
  enabled: boolean;
  webhookUrl: string;
}
export type IntegrationConfig =
  | SlackIntegrationConfig
  | GoogleSheetsIntegrationConfig
  | MailchimpIntegrationConfig
  | HubSpotIntegrationConfig
  | NotionIntegrationConfig
  | ZapierIntegrationConfig
  | MakeIntegrationConfig;

/**
 * Google reCAPTCHA configuration (part of spam protection)
 */
export interface RecaptchaConfig {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
  version: 'v2' | 'v3';
  threshold?: number;
}

/**
 * Cloudflare Turnstile configuration (Pro spam provider)
 */
export interface TurnstileConfig {
  enabled: boolean;
  siteKey?: string;
  secretKey?: string;
}

/**
 * hCaptcha configuration (Pro spam provider)
 */
export interface HcaptchaConfig {
  enabled: boolean;
  siteKey?: string;
  secretKey?: string;
}

/**
 * IP/country blocklist configuration (Pro spam provider)
 */
export interface IpBlocklistConfig {
  ips?: string[];
  countryCodes?: string[];
}

/**
 * Spam protection settings
 */
export interface SpamSettings {
  honeypot: boolean;
  honeypotFieldName: string;
  recaptcha?: RecaptchaConfig;
  turnstile?: TurnstileConfig;
  hcaptcha?: HcaptchaConfig;
  ipBlocklist?: IpBlocklistConfig;
}

/**
 * Per-form rate limiting configuration
 */
export interface RateLimitConfig {
  enabled: boolean;
  maxSubmissions: number;
  windowMs: number;
}

/**
 * Form settings configuration
 */
export interface FormSettings {
  submitButtonText: string;
  resetButtonText: string;
  showResetButton: boolean;
  layout: 'single' | 'multi-step';
  steps?: FormStep[];
  emailNotifications: EmailNotification[];
  webhooks: WebhookConfig[];
  spam: SpamSettings;
  rateLimit?: RateLimitConfig;
  customCss?: string;
  integrations?: IntegrationConfig[];
}

/**
 * Form entity from the API
 */
export interface Form {
  id: number;
  documentId: string;
  title: string;
  slug: string;
  description?: string;
  fields: FormField[];
  settings: FormSettings;
  successMessage: string;
  redirectUrl?: string;
  isActive: boolean;
  submissionCount: number;
  requiresApproval?: boolean;
  locales?: FormLocales;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

/**
 * Submission status type
 */
export type SubmissionStatus = 'new' | 'read' | 'processed' | 'archived' | 'spam' | 'draft';

/**
 * Approval workflow status (Business feature). Independent of {@link SubmissionStatus}.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * Form submission entity
 */
export interface FormSubmission {
  id: number;
  documentId: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: SubmissionStatus;
  approvalStatus?: ApprovalStatus;
  approvalNote?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Form submission with form relation (returned by detail endpoint)
 */
export interface FormSubmissionDetail extends FormSubmission {
  form?: {
    documentId: string;
    title: string;
    fields: FormField[];
  };
}

/**
 * Field type definition for the form builder (returned by GET /field-types).
 *
 * NOTE: this is exported as `FieldType` for backward compatibility — existing
 * hooks/components consume `FieldType` as this object shape. Use
 * {@link FieldTypeName} for the string-literal union of the 25 type names.
 */
export interface FieldType {
  /**
   * One of {@link FieldTypeName}, widened to accept Pro type names (e.g.
   * `'signature'`, `'rating'`) the server may return before they are added to the
   * `FieldTypeName` union. `string & {}` preserves autocomplete for known names.
   */
  type: FieldTypeName | (string & {});
  label: string;
  icon: string;
  category: FieldTypeCategory;
  /** Licensing tier required to use this field type. Absent/undefined = free. */
  tier?: 'free' | 'pro' | 'business';
}

/**
 * @deprecated Alias of {@link FieldType}. Prefer `FieldType` for the definition shape.
 */
export type FieldTypeDefinition = FieldType;

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  data: T;
}

/**
 * Pagination metadata returned by paginated endpoints
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

/**
 * Paginated API response wrapper (data + meta.pagination)
 */
export interface PaginatedResponse<T> {
  data: T;
  meta: {
    pagination: PaginationMeta;
  };
}

/**
 * Paginated forms list response (matches the server contract)
 */
export type PaginatedForms = PaginatedResponse<Form[]>;

/**
 * API error response
 */
export interface ApiError {
  data: null;
  error: {
    status: number;
    name: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Form creation/update payload
 */
export interface FormPayload {
  title: string;
  slug?: string;
  description?: string;
  fields?: Partial<FormField>[];
  settings?: Partial<FormSettings>;
  successMessage?: string;
  redirectUrl?: string;
  isActive?: boolean;
  /**
   * Approval workflow toggle (Business). The server CONFIG gate
   * (`controllers/form.ts`) blocks ENABLING this when not entitled; it never
   * strips an already-enabled value.
   */
  requiresApproval?: boolean;
  /**
   * Multi-language overrides (Business). Round-trips through the form save path;
   * the server save-gate blocks NEW locale content when not entitled and never
   * strips existing locales.
   */
  locales?: FormLocales;
}

/**
 * Submission update payload
 */
export interface SubmissionUpdatePayload {
  status?: SubmissionStatus;
}

/**
 * Query parameters for listing forms
 */
export interface FormsQueryParams {
  page?: number;
  pageSize?: number;
  sort?: string;
  _q?: string;
}

/**
 * Query parameters for listing submissions
 */
export interface SubmissionsQueryParams {
  page?: number;
  pageSize?: number;
  sort?: string;
  status?: SubmissionStatus;
}

/**
 * Export format options for submissions. xlsx/pdf are Pro-only (server enforces
 * the 402); csv/json stay free.
 */
export type ExportFormat = 'csv' | 'json' | 'xlsx' | 'pdf';

/**
 * Options for exporting submissions
 */
export interface ExportOptions {
  format?: ExportFormat;
  status?: SubmissionStatus;
  includeIp?: boolean;
}

/**
 * Scheduled/emailed export config (mirrors the server EE shape) used by the
 * scheduling dialog. The persisted server config also carries `formId`, which is
 * implicit from the route here.
 */
export interface ScheduledExportConfig {
  cronExpression: string;
  recipientEmails: string[];
  format: 'xlsx' | 'pdf' | 'csv';
}

/**
 * Result returned by the save-partial endpoint (POST /api/formflow/forms/:slug/partial).
 * Requires a Pro license (saveResume feature).
 */
export interface SavePartialResult {
  resumeToken: string;
  expiresAt: string;
}

/**
 * Saved partial submission data returned by GET /api/formflow/forms/:slug/partial/:resumeToken.
 */
export interface PartialSubmissionData {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// Compliance (Business tier)
export const COMPLIANCE_API = {
  subject: `/${PLUGIN_ID}/compliance/subject`,
  audit: `/${PLUGIN_ID}/compliance/audit`,
} as const;

/**
 * A single compliance audit log entry (mirrors the server EE shape).
 */
export interface AuditEntry {
  action: 'subject.export' | 'subject.delete' | 'submission.delete' | 'submission.bulkDelete';
  actor: string;
  target: string;
  count?: number;
  timestamp: string;
}

/**
 * Per-subject export payload (GDPR right of access). `consents` is read from each
 * submission's `metadata.consents` array.
 */
export interface SubjectExportResult {
  submissions: Array<{
    documentId: string;
    createdAt: string;
    data: Record<string, unknown>;
    consents: unknown;
  }>;
  totalCount: number;
}
