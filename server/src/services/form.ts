import type { Core } from '@strapi/strapi';
import { v4 as uuidv4 } from 'uuid';

/**
 * Field type definition for the form builder
 */
export interface FieldType {
  type: string;
  label: string;
  icon: string;
  category: 'basic' | 'choice' | 'datetime' | 'advanced' | 'layout';
  tier: 'free' | 'pro' | 'business';
}

/**
 * Form field structure stored in the fields JSON array
 */
export interface FormField {
  id: string;
  type: string;
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
  validation: Array<{
    type: string;
    value?: unknown;
    message: string;
  }>;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: unknown;
  order: number;
  width?: 'full' | 'half';
  conditional?: {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains' | 'is_empty' | 'is_not_empty';
    value?: unknown;
  };
  attributes?: Record<string, unknown>;
}

/**
 * Multi-step form step definition
 */
export interface FormStep {
  id: string;
  title: string;
  description?: string;
  fields: string[];
}

/**
 * reCAPTCHA configuration. The secretKey is server-only and MUST NEVER be
 * exposed through the public schema.
 */
export interface RecaptchaConfig {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
  version: 'v2' | 'v3';
  threshold?: number;
}

/**
 * Spam protection configuration
 */
export interface SpamProtectionConfig {
  honeypot: boolean;
  honeypotFieldName: string;
  recaptcha?: RecaptchaConfig;
}

/**
 * Default form settings structure
 */
export interface FormSettings {
  submitButtonText: string;
  showResetButton: boolean;
  resetButtonText: string;
  layout: 'single' | 'multi-step';
  steps?: FormStep[];
  emailNotifications: Array<{
    enabled: boolean;
    to: string[];
    subject: string;
    template?: string;
    replyTo?: string;
  }>;
  webhooks: Array<{
    enabled: boolean;
    url: string;
    method: 'POST' | 'PUT';
    headers?: Record<string, string>;
    events: Array<'submission.created' | 'submission.updated'>;
  }>;
  spam: SpamProtectionConfig;
  /**
   * Optional raw CSS the consuming frontend may inject when rendering the form
   * (e.g. into a <style> tag). Exposed verbatim through the public schema; the
   * server never interprets it. Empty by default so existing forms are
   * unaffected.
   */
  customCss?: string;
  telegram?: {
    enabled: boolean;
    connectionId: string;
    destination: string;
    template: unknown;
  };
}

export interface TelegramFormSettingsError {
  status: 400 | 402;
  message: string;
  details?: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate only an enabled integration; disabling remains monotonic after license loss. */
export async function validateTelegramFormSettings(
  strapi: Core.Strapi,
  fields: readonly Partial<FormField>[],
  settings: unknown
): Promise<TelegramFormSettingsError | null> {
  if (!record(settings) || !Object.prototype.hasOwnProperty.call(settings, 'telegram')) return null;
  const telegram = settings.telegram;
  if (!record(telegram) || typeof telegram.enabled !== 'boolean') {
    return { status: 400, message: 'Telegram settings are invalid.' };
  }
  if (telegram.enabled === false) return null;
  if (!Object.keys(telegram).every((key) => ['enabled', 'connectionId', 'destination', 'template'].includes(key)) ||
    typeof telegram.connectionId !== 'string' || telegram.connectionId.length === 0 ||
    typeof telegram.destination !== 'string' ||
    (!/^-?[1-9]\d{0,19}$/.test(telegram.destination) && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram.destination)) ||
    !record(telegram.template)) {
    return { status: 400, message: 'Telegram connection, destination, or template is invalid.' };
  }
  const license = strapi.plugin('formflow').service('license');
  if (license.can('integrations') !== true) {
    return { status: 402, message: 'Upgrade to Pro to use feature: integrations', details: { feature: 'integrations', requiredTier: 'pro', resolution: license.resolution?.() ?? 'unresolved' } };
  }
  const { validateTemplate } = await import('../ee/telegram/template');
  const templateResult = validateTemplate(telegram.template as any, fields.map((field) => ({
    id: field.id ?? '', type: field.type ?? '', name: field.name, label: field.label ?? field.name ?? 'Field',
  })));
  if (!templateResult.valid) return { status: 400, message: 'Telegram template is invalid.', details: { errors: templateResult.errors, warnings: templateResult.warnings } };
  const connections = await strapi.plugin('formflow').service('telegram').listConnections() as Array<{ id?: unknown; active?: unknown }>;
  const connection = connections.find((item) => item.id === telegram.connectionId);
  if (!connection) return { status: 400, message: 'The selected Telegram connection does not exist.' };
  if (connection.active !== true) return {
    status: 402,
    message: 'The selected Telegram connection is inactive on the current plan.',
    details: {
      feature: 'integrations', requiredTier: 'pro', resolution: license.resolution?.() ?? 'unresolved',
      upgradeUrl: 'https://hrahimi270.github.io/formflow/#pricing',
    },
  };
  return null;
}

export class TelegramFormValidationError extends Error {
  constructor(public readonly validation: TelegramFormSettingsError) { super(validation.message); }
}

/**
 * Per-locale content overrides for a single field (Business multi-language).
 * Only UI content is localized — labels, placeholder, description and option
 * labels — never field types, names, validation or conditional logic.
 */
export interface FieldLocaleOverride {
  label?: string;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

/**
 * One locale's content overrides for a form: a map of fieldId -> override plus
 * an optional localized success message.
 */
export interface FormLocaleContent {
  fields?: Record<string, FieldLocaleOverride>;
  successMessage?: string;
}

/**
 * The `locales` JSON column on a form: locale code -> per-locale content.
 */
export type FormLocales = Record<string, FormLocaleContent>;

const CONTENT_TYPE_UID = 'plugin::formflow.form';
const SUBMISSION_CONTENT_TYPE_UID = 'plugin::formflow.form-submission';

const formService = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Find all forms with optional query parameters
   */
  async find(query: Record<string, unknown> = {}) {
    return strapi.documents(CONTENT_TYPE_UID).findMany({
      ...query,
    });
  },

  /**
   * Find a single form by documentId
   */
  async findOne(documentId: string) {
    return strapi.documents(CONTENT_TYPE_UID).findOne({
      documentId,
    });
  },

  /**
   * Find a form by its slug (used for public API)
   *
   * Returns the PUBLISHED version of the form. With draftAndPublish enabled,
   * the document service defaults to the draft version (publishedAt=null),
   * which would make published+active forms appear unpublished to the public
   * API. Passing status:'published' ensures the public-facing record is used.
   */
  async findBySlug(slug: string) {
    const forms = await strapi.documents(CONTENT_TYPE_UID).findMany({
      filters: { slug },
      status: 'published',
      limit: 1,
    });
    return forms[0] || null;
  },

  /**
   * Find the DRAFT version of a form by its slug (admin-only lookup)
   */
  async findDraftBySlug(slug: string) {
    const forms = await strapi.documents(CONTENT_TYPE_UID).findMany({
      filters: { slug },
      status: 'draft',
      limit: 1,
    });
    return forms[0] || null;
  },

  /**
   * Create a new form with auto-generated field IDs
   */
  async create(data: {
    title: string;
    slug?: string;
    description?: string;
    fields?: Partial<FormField>[];
    settings?: Partial<FormSettings>;
    successMessage?: string;
    redirectUrl?: string;
    isActive?: boolean;
    requiresApproval?: boolean;
    locales?: FormLocales;
  }) {
    // Generate UUIDs for fields if not provided and ensure proper ordering
    const processedFields = data.fields
      ? data.fields.map((field, index) => ({
          ...field,
          id: field.id || uuidv4(),
          order: field.order ?? index,
          required: field.required ?? false,
          validation: field.validation || [],
        }))
      : [];

    const mergedSettings = { ...this.getDefaultSettings(), ...data.settings };
    const telegramError = await validateTelegramFormSettings(strapi, processedFields, mergedSettings);
    if (telegramError) throw new TelegramFormValidationError(telegramError);

    return strapi.documents(CONTENT_TYPE_UID).create({
      status: 'published',
      data: {
        ...data,
        fields: processedFields,
        settings: mergedSettings,
      },
    });
  },

  /**
   * Update an existing form
   */
  async update(
    documentId: string,
    data: {
      title?: string;
      slug?: string;
      description?: string;
      fields?: Partial<FormField>[];
      settings?: Partial<FormSettings>;
      successMessage?: string;
      redirectUrl?: string;
      isActive?: boolean;
      submissionCount?: number;
      requiresApproval?: boolean;
      locales?: FormLocales;
    }
  ) {
    // Process fields to ensure they have IDs and proper ordering
    const processedData: Record<string, unknown> = { ...data };
    if (data.fields) {
      processedData.fields = data.fields.map((field, index) => ({
        ...field,
        id: field.id || uuidv4(),
        order: field.order ?? index,
      }));
    }

    if (data.fields || (data.settings && Object.prototype.hasOwnProperty.call(data.settings, 'telegram'))) {
      const existing = await this.findOne(documentId) as { fields?: Partial<FormField>[]; settings?: Record<string, unknown> } | null;
      const fields = (processedData.fields ?? existing?.fields ?? []) as Partial<FormField>[];
      const existingSettings = existing?.settings ?? {};
      const settings = {
        ...existingSettings,
        ...data.settings,
        ...(data.settings && Object.prototype.hasOwnProperty.call(data.settings, 'telegram')
          ? {
              telegram: {
                ...(record(existingSettings.telegram) ? existingSettings.telegram : {}),
                ...(record(data.settings.telegram) ? data.settings.telegram : {}),
              },
            }
          : {}),
      };
      const telegramError = await validateTelegramFormSettings(strapi, fields, settings);
      if (telegramError) throw new TelegramFormValidationError(telegramError);
      processedData.settings = settings;
    }

    return strapi.documents(CONTENT_TYPE_UID).update({
      documentId,
      status: 'published',
      data: processedData,
    });
  },

  /**
   * Delete a form and all its associated submissions
   */
  async delete(documentId: string) {
    // First, delete all associated submissions to maintain referential integrity
    const submissions = await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).findMany({
      filters: { form: { documentId } },
    });

    // Delete submissions in parallel for better performance
    await Promise.all(
      submissions.map((submission) =>
        strapi.documents(SUBMISSION_CONTENT_TYPE_UID).delete({
          documentId: submission.documentId,
        })
      )
    );

    // Now delete the form itself
    return strapi.documents(CONTENT_TYPE_UID).delete({
      documentId,
    });
  },

  /**
   * Generate a slug for a duplicated form that is unique across existing forms.
   *
   * Derives a base of `${original}-copy` and, if that is already taken, appends
   * an incrementing suffix (`-copy-2`, `-copy-3`, ...) until a free slug is
   * found. A null/empty base falls back to `form-copy`.
   */
  async generateUniqueSlug(baseSlug: string) {
    const base = `${baseSlug || 'form'}-copy`;

    let candidate = base;
    let suffix = 2;

    // Check against the draft version: every document has a draft row, so this
    // reliably detects any existing form using the candidate slug.
    while (
      (
        await strapi.documents(CONTENT_TYPE_UID).findMany({
          filters: { slug: candidate },
          status: 'draft',
          limit: 1,
        })
      ).length > 0
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  },

  /**
   * Prepare the exact create payload for a duplicated form.
   *
   * Field IDs are regenerated, and every configuration keyed by those IDs is
   * remapped before the payload is validated or persisted.
   */
  async prepareDuplicate(documentId: string) {
    const original = await this.findOne(documentId);

    if (!original) {
      throw new Error('Form not found');
    }

    // Extract only the data fields we need, excluding system fields
    const {
      title,
      slug,
      description,
      fields,
      settings,
      successMessage,
      redirectUrl,
      isActive,
      requiresApproval,
      locales,
    } = original;

    const fieldIdMap = new Map<string, string>();
    const duplicatedFields = Array.isArray(fields)
      ? fields.map((field: FormField) => {
          const nextId = uuidv4();
          fieldIdMap.set(field.id, nextId);
          return { ...field, id: nextId };
        })
      : [];

    const originalSettings = (settings ?? {}) as Partial<FormSettings>;
    const duplicatedSettings: Partial<FormSettings> = {
      ...originalSettings,
      ...(Array.isArray(originalSettings.steps)
        ? {
            steps: originalSettings.steps.map((step) => ({
              ...step,
              fields: step.fields
                .map((fieldId) => fieldIdMap.get(fieldId))
                .filter((fieldId): fieldId is string => Boolean(fieldId)),
            })),
          }
        : {}),
    };

    const originalLocales = (locales ?? {}) as FormLocales;
    const duplicatedLocales = Object.fromEntries(
      Object.entries(originalLocales).map(([locale, content]) => {
        const remappedFields = content.fields
          ? Object.fromEntries(
              Object.entries(content.fields).flatMap(([fieldId, override]) => {
                const nextId = fieldIdMap.get(fieldId);
                return nextId ? [[nextId, override]] : [];
              })
            )
          : undefined;

        return [
          locale,
          {
            ...content,
            ...(remappedFields === undefined ? {} : { fields: remappedFields }),
          },
        ];
      })
    ) as FormLocales;

    const newSlug = await this.generateUniqueSlug(slug as string);

    return {
      title: `${title} (Copy)`,
      slug: newSlug,
      description,
      fields: duplicatedFields,
      settings: duplicatedSettings,
      successMessage,
      redirectUrl,
      isActive,
      requiresApproval,
      locales: duplicatedLocales,
    };
  },

  /**
   * Duplicate an existing form with a new title and a unique slug.
   *
   * create() does not backfill a slug, so the prepared payload must include one;
   * otherwise the copy is saved with slug:null, which breaks the editor and
   * 404s the public API.
   */
  async duplicate(documentId: string) {
    return this.create(await this.prepareDuplicate(documentId));
  },

  /**
   * Get form schema for public API consumption (sanitized).
   *
   * When `options.locale` is provided and the form has a matching entry in its
   * `locales` JSON map, the per-field content (label/placeholder/description/
   * options) and the success message are replaced with that locale's overrides.
   * Only the requested locale's content is applied — the raw `locales` map (which
   * holds every locale) is never exposed. Serving a configured locale is always
   * permitted; the entitlement gate lives only at form save time.
   */
  async getPublicSchema(slug: string, options: { locale?: string } = {}) {
    const form = await this.findBySlug(slug);

    if (!form || !form.isActive) {
      return null;
    }

    const settings = (form.settings || {}) as FormSettings;
    const fields = (form.fields || []) as FormField[];

    // Resolve the requested locale's content overrides (if any). Absent/unknown
    // locale falls through to the default content unchanged.
    const locales = (form.locales || {}) as FormLocales;
    const localeContent = options.locale ? locales[options.locale] : undefined;
    const fieldOverrides = localeContent?.fields ?? {};

    // Fire-and-forget view event — must not block or throw
    strapi.plugin('formflow').service('analytics').recordEvent(form.documentId, 'view');

    // Return only public-safe data, excluding sensitive settings
    return {
      title: form.title,
      description: form.description,
      slug: form.slug,
      // Localized success message takes precedence; omitted when neither the
      // locale nor the form provides one (keeps the default response shape).
      ...(localeContent?.successMessage ? { successMessage: localeContent.successMessage } : {}),
      fields: fields.map((field) => {
        const override = fieldOverrides[field.id] ?? {};
        return {
          id: field.id,
          type: field.type,
          name: field.name,
          label: override.label ?? field.label,
          placeholder: override.placeholder ?? field.placeholder,
          description: override.description ?? field.description,
          required: field.required,
          options: override.options ?? field.options,
          defaultValue: field.defaultValue,
          order: field.order,
          width: field.width,
          conditional: field.conditional,
          validation: (field.validation || []).map((v) => ({
            type: v.type,
            value: v.value,
            message: v.message,
          })),
        };
      }),
      settings: {
        submitButtonText: settings.submitButtonText || 'Submit',
        showResetButton: settings.showResetButton || false,
        resetButtonText: settings.resetButtonText || 'Reset',
        layout: settings.layout || 'single',
        // Expose steps only for multi-step layouts so the frontend can render them
        ...(settings.layout === 'multi-step' && settings.steps ? { steps: settings.steps } : {}),
        // Expose custom CSS only when set so the consuming frontend can inject
        // it (e.g. into a <style> tag). Omitted entirely when empty, keeping the
        // response shape unchanged for existing forms.
        ...(settings.customCss ? { customCss: settings.customCss } : {}),
        spam: {
          honeypot: settings.spam?.honeypot || false,
          honeypotFieldName: settings.spam?.honeypotFieldName,
          // Expose only public-safe reCAPTCHA fields (NEVER the secretKey)
          ...(settings.spam?.recaptcha?.enabled
            ? {
                recaptcha: {
                  siteKey: settings.spam.recaptcha.siteKey,
                  version: settings.spam.recaptcha.version,
                },
              }
            : {}),
        },
      },
    };
  },

  /**
   * Get default settings for a new form
   */
  getDefaultSettings(): FormSettings {
    return {
      submitButtonText: 'Submit',
      showResetButton: false,
      resetButtonText: 'Reset',
      layout: 'single',
      emailNotifications: [],
      webhooks: [],
      spam: {
        honeypot: true,
        honeypotFieldName: '_gotcha',
      },
      customCss: '',
    };
  },

  /**
   * Get all supported field types for the form builder
   */
  getFieldTypes(): FieldType[] {
    return [
      // Basic input fields
      { type: 'text', label: 'Text', icon: 'text', category: 'basic', tier: 'free' },
      { type: 'textarea', label: 'Text Area', icon: 'text', category: 'basic', tier: 'free' },
      { type: 'email', label: 'Email', icon: 'mail', category: 'basic', tier: 'free' },
      { type: 'number', label: 'Number', icon: 'number', category: 'basic', tier: 'free' },
      { type: 'phone', label: 'Phone', icon: 'phone', category: 'basic', tier: 'free' },
      { type: 'url', label: 'URL', icon: 'link', category: 'basic', tier: 'free' },
      { type: 'password', label: 'Password', icon: 'lock', category: 'basic', tier: 'free' },

      // Choice fields
      {
        type: 'select',
        label: 'Dropdown',
        icon: 'chevron-down',
        category: 'choice',
        tier: 'free',
      },
      {
        type: 'radio',
        label: 'Radio Buttons',
        icon: 'circle',
        category: 'choice',
        tier: 'free',
      },
      {
        type: 'checkbox',
        label: 'Checkboxes',
        icon: 'check-square',
        category: 'choice',
        tier: 'free',
      },
      {
        type: 'boolean',
        label: 'Yes/No Toggle',
        icon: 'toggle',
        category: 'choice',
        tier: 'free',
      },

      // Date/Time fields
      { type: 'date', label: 'Date', icon: 'calendar', category: 'datetime', tier: 'free' },
      { type: 'time', label: 'Time', icon: 'clock', category: 'datetime', tier: 'free' },
      {
        type: 'datetime',
        label: 'Date & Time',
        icon: 'calendar',
        category: 'datetime',
        tier: 'free',
      },

      // Advanced fields
      {
        type: 'file',
        label: 'File Upload',
        icon: 'upload',
        category: 'advanced',
        tier: 'free',
      },
      {
        type: 'hidden',
        label: 'Hidden Field',
        icon: 'eye-off',
        category: 'advanced',
        tier: 'free',
      },

      // Layout elements
      { type: 'heading', label: 'Heading', icon: 'type', category: 'layout', tier: 'free' },
      {
        type: 'paragraph',
        label: 'Paragraph',
        icon: 'align-left',
        category: 'layout',
        tier: 'free',
      },
      { type: 'divider', label: 'Divider', icon: 'minus', category: 'layout', tier: 'free' },

      // Pro field types (Phase 2 validates/sanitizes; admin shows locked tiles)
      {
        type: 'signature',
        label: 'Signature',
        icon: 'pen-tool',
        category: 'advanced',
        tier: 'pro',
      },
      { type: 'rating', label: 'Rating / NPS', icon: 'star', category: 'advanced', tier: 'pro' },
      {
        type: 'address',
        label: 'Address + Map',
        icon: 'map-pin',
        category: 'advanced',
        tier: 'pro',
      },
      {
        type: 'richtext',
        label: 'Rich Text',
        icon: 'align-left',
        category: 'advanced',
        tier: 'pro',
      },
      {
        type: 'calculated',
        label: 'Calculated Field',
        icon: 'hash',
        category: 'advanced',
        tier: 'pro',
      },
      {
        type: 'payment',
        label: 'Stripe Payment',
        icon: 'credit-card',
        category: 'advanced',
        tier: 'pro',
      },

      // Business field types (GDPR consent capture)
      {
        type: 'consent',
        label: 'Consent Checkbox',
        icon: 'check-square',
        category: 'advanced',
        tier: 'business',
      },
    ];
  },

  /**
   * Recompute and persist the submission count for a form.
   *
   * Rather than a racy read-modify-write on the draft, this derives the count
   * from the authoritative number of related submissions so concurrent
   * submissions cannot clobber each other.
   *
   * IMPORTANT: this must NOT call documents().update({ status: 'published' }).
   * That writes the count to the draft and then publishes the WHOLE draft over
   * the published version, force-publishing any in-progress unpublished admin
   * edits to title/fields/settings on every public submit. Instead we:
   *   1. Write the count to the DRAFT via a normal document service update
   *      (no status change, so this stays draft-only and triggers no publish).
   *   2. Patch ONLY the published row's `submissionCount` column directly via
   *      the lower-level query engine, which does not run publish() and so
   *      leaves the rest of the published record untouched.
   * Both draft and published rows therefore stay in sync without leaking draft
   * edits into the published, public-facing form.
   */
  async incrementSubmissionCount(documentId: string) {
    const total = await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).count({
      filters: { form: { documentId }, status: { $ne: 'draft' } },
    });

    // 1. Write to the draft only (default target for the document service).
    const updated = await strapi.documents(CONTENT_TYPE_UID).update({
      documentId,
      data: { submissionCount: total } as Record<string, unknown>,
    });

    // 2. Patch the published row's column directly (if a published version
    // exists) WITHOUT triggering publish(), so the public schema reflects the
    // same count without copying unpublished draft edits over the published
    // record. updateMany is a no-op when no published row matches.
    try {
      await strapi.db.query(CONTENT_TYPE_UID).updateMany({
        where: { documentId, publishedAt: { $notNull: true } },
        data: { submissionCount: total },
      });
    } catch (error) {
      strapi.log.warn(
        `[FormFlow] Failed to sync published submissionCount for form ${documentId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }

    return updated;
  },

  /**
   * Count forms matching optional filters
   */
  async count(filters: Record<string, unknown> = {}) {
    return strapi.documents(CONTENT_TYPE_UID).count({
      filters,
    });
  },
});

export default formService;
