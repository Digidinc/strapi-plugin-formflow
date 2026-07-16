import { randomBytes } from 'crypto';

import type { Core } from '@strapi/strapi';

import { isEmptyValue, partitionFieldsByVisibility } from '../utils/validation-rules';
import type { ValidatableField, UploadedFileMeta, UploadedFilesMap } from './validation';

/**
 * Re-export the multipart file types so the controller can type the files map it
 * forwards into {@link submissionService.submit} without reaching into the
 * validation service directly.
 */
export type { UploadedFileMeta, UploadedFilesMap };

/**
 * Media-library reference stored in submission.data for a `file` field.
 * Mirrors the public-safe subset of a Strapi upload file record.
 */
export interface SubmissionFileRef {
  /** Numeric media id. */
  id: number;
  /** Document id (Strapi v5); present on persisted upload records. */
  documentId?: string;
  /** Public URL of the uploaded file. */
  url: string;
  /** Stored file name. */
  name: string;
  /** Detected/declared MIME type. */
  mime?: string;
  /** File size in bytes. */
  size?: number;
}

/**
 * Content type UID for form submissions
 */
const SUBMISSION_CONTENT_TYPE_UID = 'plugin::formflow.form-submission';

/**
 * Plugin config id used to read privacy options (anonymizeIp, dataRetentionDays).
 */
const PLUGIN_CONFIG_ID = 'plugin::formflow';

/**
 * Request-body control field used to request validate-only, step-scoped
 * validation for a multi-step form. Its value is a step id or a zero-based step
 * index. It is a control field (never a real form field) and is always stripped
 * from submission data before validation/storage, like the honeypot field.
 */
export const STEP_INDICATOR_FIELD = '_step';

/**
 * Submission status values. `draft` marks a partial (save & resume) record that
 * has not yet been submitted in full; it is never surfaced in the admin inbox.
 */
export type SubmissionStatus = 'new' | 'read' | 'processed' | 'archived' | 'spam' | 'draft';

/**
 * Approval workflow status (Business feature). Independent of {@link SubmissionStatus}:
 * a submission carries both an inbox status and an approval decision. New
 * submissions default to `pending`; admins transition to `approved`/`rejected`.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * Metadata collected from the submission request
 */
export interface SubmissionMetadata {
  ipAddress: string;
  userAgent?: string;
  referrer?: string;
  submittedAt: string;
  formVersion?: string;
}

/**
 * Form submission record structure
 */
export interface FormSubmission {
  documentId: string;
  form: { documentId: string };
  data: Record<string, unknown>;
  metadata: SubmissionMetadata;
  status: SubmissionStatus;
  approvalStatus?: ApprovalStatus;
  approvalNote?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Query options for finding submissions
 */
export interface SubmissionQuery {
  filters?: Record<string, unknown>;
  sort?: Record<string, 'asc' | 'desc'> | string;
  limit?: number;
  // Document Service findMany uses offset-notation 'start' (not 'offset').
  start?: number;
  populate?: string[];
}

/**
 * Result of a successful submission
 */
export interface SubmissionResult {
  submission: FormSubmission;
  successMessage?: string;
  redirectUrl?: string;
}

/**
 * Custom validation error with field-level details
 */
class ValidationError extends Error {
  name = 'ValidationError' as const;
  details: Record<string, string[]>;

  constructor(details: Record<string, string[]>) {
    super('Validation failed');
    this.details = details;
  }
}

/**
 * Multi-step form step definition. `fields` holds the stable field IDs that
 * belong to the step (matching `FormField.id`), NOT field names.
 */
export interface FormStepDefinition {
  id: string;
  title?: string;
  description?: string;
  fields: string[];
}

/**
 * Result of a validate-only step check. Reports validity and field-level errors
 * for the requested step WITHOUT persisting any submission. `step` echoes the
 * resolved step id (or the raw indicator when a step could not be resolved).
 */
export interface StepValidationResult {
  valid: boolean;
  errors: Record<string, string[]>;
  step: string;
}

/**
 * Result of persisting a partial (save & resume) submission. The `resumeToken`
 * is the opaque key the client stores and replays to resume; `expiresAt` is an
 * ISO timestamp 7 days out, advisory for the frontend.
 */
export interface PartialSubmissionResult {
  resumeToken: string;
  expiresAt: string;
}

/**
 * A previously-saved partial submission, returned when resuming by token.
 */
export interface PartialSubmissionData {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Form structure for submission processing
 */
export interface SubmittableForm {
  documentId: string;
  slug: string;
  title: string;
  isActive: boolean;
  fields: ValidatableField[];
  settings?: {
    layout?: 'single' | 'multi-step';
    steps?: FormStepDefinition[];
    spam?: {
      honeypot?: boolean;
      honeypotFieldName?: string;
    };
    emailNotifications?: Array<{
      enabled: boolean;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      template?: string;
      replyTo?: string;
      includeData?: boolean;
      isAutoresponder?: boolean;
      toField?: string;
      omitBranding?: boolean;
    }>;
    webhooks?: Array<{
      enabled: boolean;
      url: string;
      method?: 'POST' | 'PUT';
      headers?: Record<string, string>;
      events?: Array<'submission.created' | 'submission.updated'>;
    }>;
  };
  successMessage?: string;
  redirectUrl?: string;
  submissionCount?: number;
  /**
   * Form-level approval toggle (Business feature). When true, every new
   * submission is created with `approvalStatus: 'pending'` so it lands in the
   * pending-approval queue. The entitlement is enforced at config time (admin
   * toggle + server form-save gate) and at the approve action — submit() never
   * gates on it.
   */
  requiresApproval?: boolean;
  updatedAt: string;
}

/**
 * Merge a default `status: { $ne: 'draft' }` into a query's filters so save &
 * resume drafts are hidden from inbox/count/export by default.
 *
 * An explicit caller-supplied `status` filter always wins (a direct value or any
 * `$ne`/`$eq`/`$in`/etc. operator the caller set on purpose), so the internal
 * draft lookups and per-status counts are never overridden. Only when `status`
 * is absent is the default exclusion applied.
 */
const withDefaultDraftExclusion = (
  filters: Record<string, unknown> = {}
): Record<string, unknown> => {
  if (filters && Object.prototype.hasOwnProperty.call(filters, 'status')) {
    return filters;
  }
  return { ...filters, status: { $ne: 'draft' } };
};

/**
 * Submission service for handling form submissions
 * Coordinates validation, sanitization, storage, and post-submission hooks
 */
const submissionService = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Submit form data
   * Complete submission workflow: validate, sanitize, store, trigger hooks
   *
   * @param slug - Form slug identifier
   * @param data - Raw submission data (non-file fields)
   * @param metadata - Client metadata (IP, user agent, etc.)
   * @param files - Uploaded files keyed by field name (from multipart parser).
   *   Optional so plain JSON submissions keep working unchanged.
   * @returns Submission result with success message/redirect
   * @throws ValidationError if validation fails
   * @throws Error if form not found or inactive
   */
  async submit(
    slug: string,
    data: Record<string, unknown>,
    metadata: SubmissionMetadata,
    files: UploadedFilesMap = {}
  ): Promise<SubmissionResult> {
    const formService = strapi.plugin('formflow').service('form');
    const validationService = strapi.plugin('formflow').service('validation');

    // Get form by slug
    const form = (await formService.findBySlug(slug)) as SubmittableForm | null;

    if (!form) {
      throw new Error('Form not found');
    }

    if (!form.isActive) {
      throw new Error('Form is not accepting submissions');
    }

    // Create a mutable copy of submission data
    const submissionData = { ...data };

    // Strip the step-indicator control field. It is only meaningful for the
    // validate-only step check (see validateStep) and must never be validated
    // against form fields or persisted, even if a full submission includes it.
    delete submissionData[STEP_INDICATOR_FIELD];

    // Spam handling (honeypot + reCAPTCHA) lives in the spam-check middleware,
    // which runs before this controller/service. Defensively strip the honeypot
    // field here so it never reaches validation or storage.
    if (form.settings?.spam?.honeypot) {
      const honeypotFieldName = form.settings.spam.honeypotFieldName || '_gotcha';
      delete submissionData[honeypotFieldName];
    }

    const formFields = form.fields || [];
    const visibilityData = { ...submissionData };
    for (const field of formFields) {
      if (field.type === 'file') {
        // Multipart files live outside the request body. Mirror their raw
        // presence into this one-time visibility snapshot so file sources work
        // with is_empty/is_not_empty before validation or upload. This value is
        // never written back to submissionData, so only uploaded media refs are
        // persisted later.
        visibilityData[field.name] = files[field.name];
      } else if (field.type === 'checkbox') {
        // Formidable returns one repeated multipart field as a scalar and two or
        // more as an array. Restore the checkbox's multi-value shape before
        // evaluating visibility so `contains` always means exact membership.
        const value = visibilityData[field.name];
        if (value !== undefined && value !== null && !Array.isArray(value)) {
          visibilityData[field.name] = isEmptyValue(value) ? [] : [value];
        }
      }
    }
    const { visible: visibleFields, hidden: hiddenFields } = partitionFieldsByVisibility(
      formFields,
      visibilityData
    );
    const discardedHiddenFields = hiddenFields
      .filter((field) => !isEmptyValue(visibilityData[field.name]))
      .map((field) => field.name);
    if (discardedHiddenFields.length > 0) {
      strapi.log.warn(
        `[FormFlow] Discarding non-empty values for fields hidden by conditional visibility: ${JSON.stringify(discardedHiddenFields)}. Their rule failed or a source field resolved hidden or invalid.`
      );
    }

    // Validate non-file submission data against form field definitions.
    const validationResult = validationService.validate(visibleFields, visibilityData);

    // Validate uploaded files (required/maxSize/allowedTypes) BEFORE persisting
    // anything to the media library, so oversize/disallowed files never land.
    const fileValidationResult = validationService.validateFiles(
      visibleFields,
      files,
      visibilityData
    );

    // Merge field-level errors from both passes and reject as one response.
    const combinedErrors: Record<string, string[]> = {
      ...validationResult.errors,
      ...fileValidationResult.errors,
    };

    if (Object.keys(combinedErrors).length > 0) {
      throw new ValidationError(combinedErrors);
    }

    // Files passed validation: upload them to the media library and place the
    // resulting media references into the submission data under each field name.
    await this.processFileUploads(visibleFields, files, submissionData);

    // Sanitize data before storage
    const sanitizedData = validationService.sanitize(visibleFields, submissionData);

    // Optionally anonymize the submitter IP before it is persisted. When the
    // plugin config `anonymizeIp` is false (the default) the raw IP is stored
    // exactly as before. When enabled, the masked IP is stored in BOTH the
    // top-level `ipAddress` column and `metadata.ipAddress` so no raw IP is
    // retained anywhere.
    //
    // IP anonymization is a Business feature (compliance.anonymizeIp). When the
    // license is not entitled the raw IP is stored regardless of the config flag.
    // The entitlement check must never fail the submission, so it fails closed to
    // "not entitled" (raw IP) if the license service ever throws.
    let canAnonymize = false;
    try {
      canAnonymize = strapi.plugin('formflow').service('license').can('compliance.anonymizeIp');
    } catch {
      canAnonymize = false;
    }
    const config = strapi.config.get(PLUGIN_CONFIG_ID, {}) as {
      anonymizeIp?: boolean;
    };
    let storedIpAddress = metadata.ipAddress;
    if (canAnonymize && config?.anonymizeIp && metadata.ipAddress) {
      // Lazy + guarded: in a stripped MIT fork `ee/compliance` is absent, so the
      // import throws and we fall back to storing the raw IP (free behaviour).
      // `can(...)` is false when EE is stripped, so this load is in practice only
      // reached when the module is present.
      try {
        const { anonymizeIpAddress } = await import('../ee/compliance');
        storedIpAddress = anonymizeIpAddress(metadata.ipAddress);
      } catch {
        storedIpAddress = metadata.ipAddress;
      }
    }

    // Create submission record.
    //
    // When the parent form requires approval, the record enters the
    // pending-approval queue with `approvalStatus: 'pending'`. This is a free
    // runtime capture concern — submission is NEVER gated; the `approval`
    // entitlement is enforced at config time (admin toggle + form-save gate) and
    // at the approve action. When the form does not require approval, no
    // `approvalStatus` is written (unchanged behaviour for non-approval forms).
    const submission = (await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).create({
      data: {
        form: form.documentId,
        data: sanitizedData,
        metadata: {
          ...metadata,
          ipAddress: storedIpAddress,
          formVersion: form.updatedAt,
        },
        status: 'new' as SubmissionStatus,
        ...(form.requiresApproval ? { approvalStatus: 'pending' as ApprovalStatus } : {}),
        ipAddress: storedIpAddress,
        userAgent: metadata.userAgent,
      },
    })) as unknown as FormSubmission;

    // Update form submission count
    await formService.incrementSubmissionCount(form.documentId);

    // Capture structured consent records (Business: compliance.consent). The row
    // is already persisted above with the consent booleans inside `data`; this
    // EXEC gate only adds the structured `metadata.consents` array in a follow-up
    // update, so it can never block or fail the submission. When the license is
    // not entitled the array is simply never written. The gate fails closed to
    // "not entitled" if the license service throws, and the update is wrapped so
    // a write failure never surfaces to the submitter.
    let canConsent = false;
    try {
      canConsent = strapi.plugin('formflow').service('license').can('compliance.consent');
    } catch {
      canConsent = false;
    }
    if (canConsent) {
      try {
        const capturedAt = new Date().toISOString();
        const consents = visibleFields
          .filter((field) => field.type === 'consent')
          .map((field) => ({
            field: field.name,
            label: field.label,
            accepted: sanitizedData[field.name] === true,
            capturedAt,
          }));

        if (consents.length > 0) {
          await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).update({
            documentId: submission.documentId,
            data: {
              metadata: {
                ...metadata,
                ipAddress: storedIpAddress,
                formVersion: form.updatedAt,
                consents,
              },
            } as Record<string, unknown>,
          });
        }
      } catch (error) {
        strapi.log.error('[FormFlow] Consent capture error:', error);
      }
    }

    // Fire-and-forget: analytics completion — must not block or throw
    strapi.plugin('formflow').service('analytics').recordEvent(form.documentId, 'completion');

    // Trigger post-submission hooks asynchronously (don't block response)
    this.triggerPostSubmissionHooks(form, submission, sanitizedData).catch((error: Error) => {
      strapi.log.error('[FormFlow] Post-submission hook error:', error);
    });

    return {
      submission,
      successMessage: form.successMessage || 'Thank you for your submission',
      redirectUrl: form.redirectUrl,
    };
  },

  /**
   * Validate a SINGLE step of a multi-step form WITHOUT persisting anything.
   *
   * This is the step-aware counterpart to {@link submit}: it powers per-step
   * (wizard) validation so a frontend can confirm a step is valid before letting
   * the user advance. It is VALIDATION-ONLY — no submission is ever created,
   * no files are uploaded, no hooks fire, and the submission count is untouched.
   * Persistence happens exclusively through a full {@link submit} call (one with
   * no step indicator).
   *
   * Only the non-file fields whose ids/names belong to the requested step are
   * checked, reusing the same per-field logic as a full submission (conditional
   * visibility against the full data, required, rules, type, options). File
   * fields are intentionally not validated here (uploads are deferred to the
   * final submit). The returned errors use the identical
   * `{ valid, errors }` shape as full validation (errors keyed by field name),
   * with an added `step` echoing the resolved step id.
   *
   * @param slug - Form slug identifier
   * @param data - Raw submission data accumulated so far (keyed by field name)
   * @param stepIndicator - Step id or zero-based step index to validate
   * @returns StepValidationResult (valid flag + field errors + resolved step)
   * @throws Error if the form is not found, inactive, not multi-step, or the
   *   step indicator cannot be resolved to a defined step
   */
  async validateStep(
    slug: string,
    data: Record<string, unknown>,
    stepIndicator: string | number
  ): Promise<StepValidationResult> {
    const formService = strapi.plugin('formflow').service('form');
    const validationService = strapi.plugin('formflow').service('validation');

    const form = (await formService.findBySlug(slug)) as SubmittableForm | null;

    if (!form) {
      throw new Error('Form not found');
    }

    if (!form.isActive) {
      throw new Error('Form is not accepting submissions');
    }

    const settings = form.settings;
    const steps = settings?.steps;

    // Step validation only applies to multi-step forms with defined steps.
    if (settings?.layout !== 'multi-step' || !steps?.length) {
      throw new Error('Form is not multi-step');
    }

    const step = this.resolveStep(steps, stepIndicator);

    if (!step) {
      throw new Error('Step not found');
    }

    // Fire-and-forget: analytics start (step 0) / drop-off (later steps) — the
    // last validated step is the furthest the user reached. Never blocks/throws.
    const isFirstStep = steps.indexOf(step) === 0;
    strapi
      .plugin('formflow')
      .service('analytics')
      .recordEvent(
        form.documentId,
        isFirstStep ? 'start' : 'drop_off',
        isFirstStep ? undefined : step.id
      );

    // Work on a copy with control/spam fields stripped, mirroring submit().
    const submissionData = { ...data };
    delete submissionData[STEP_INDICATOR_FIELD];

    if (settings?.spam?.honeypot) {
      const honeypotFieldName = settings.spam.honeypotFieldName || '_gotcha';
      delete submissionData[honeypotFieldName];
    }

    // Validate only the fields belonging to this step. Step membership is keyed
    // by stable field id; validateSubset also matches by name defensively.
    const validationResult = validationService.validateSubset(
      form.fields || [],
      step.fields || [],
      submissionData
    );

    return {
      valid: validationResult.valid,
      errors: validationResult.errors,
      step: step.id,
    };
  },

  /**
   * Resolve a step indicator (a step id, or a zero-based index passed as a
   * number or numeric string) to its {@link FormStepDefinition}.
   *
   * Id matching takes precedence over index so a purely-numeric step id is not
   * accidentally treated as an index. Returns null when no step matches.
   *
   * @param steps - The form's defined steps
   * @param indicator - Step id or zero-based index
   */
  resolveStep(steps: FormStepDefinition[], indicator: string | number): FormStepDefinition | null {
    // Prefer an exact id match.
    const byId = steps.find((s) => s.id === String(indicator));
    if (byId) {
      return byId;
    }

    // Fall back to a zero-based numeric index (number or numeric string).
    if (typeof indicator === 'number' || /^\d+$/.test(String(indicator))) {
      const index = Number(indicator);
      if (Number.isInteger(index) && index >= 0 && index < steps.length) {
        return steps[index];
      }
    }

    return null;
  },

  /**
   * Upload the validated files for each `file` field to the Strapi media library
   * and write the resulting media reference(s) into `submissionData` under the
   * field name.
   *
   * Must be called only AFTER {@link ValidationService.validateFiles} has
   * accepted the files, so oversize/disallowed files are never persisted. Uses
   * the core upload plugin's programmatic service (always present — `upload` is
   * a core Strapi plugin). A single uploaded file is stored as one reference
   * object; multiple files as an array of references.
   *
   * @param fields - Form field definitions (only `file` fields are processed)
   * @param files - Uploaded files keyed by field name (from the multipart parser)
   * @param submissionData - Mutable submission data; file refs are written here
   */
  async processFileUploads(
    fields: ValidatableField[],
    files: UploadedFilesMap,
    submissionData: Record<string, unknown>
  ): Promise<void> {
    const uploadService = strapi.plugin('upload').service('upload');

    for (const field of fields) {
      if (field.type !== 'file') {
        continue;
      }

      const uploaded = files[field.name];
      const fileList: UploadedFileMeta[] = uploaded
        ? Array.isArray(uploaded)
          ? uploaded
          : [uploaded]
        : [];

      if (fileList.length === 0) {
        continue;
      }

      // The upload service accepts an array of files in a single call and
      // returns the array of persisted media records.
      const created = (await uploadService.upload({
        data: {},
        files: fileList,
      })) as Array<Record<string, unknown>>;

      const refs = created.map((file) => this.toFileRef(file));

      // Preserve single-vs-multiple semantics: a single uploaded file is stored
      // as one object, multiple files as an array.
      submissionData[field.name] = refs.length === 1 ? refs[0] : refs;
    }
  },

  /**
   * Map a persisted upload-plugin file record to the public-safe media reference
   * we store in submission data.
   *
   * @param file - Raw file record returned by the upload service
   */
  toFileRef(file: Record<string, unknown>): SubmissionFileRef {
    // The upload record stores `size` in KILOBYTES and `sizeInBytes` in bytes.
    // Prefer the byte-accurate field for the stored reference.
    const sizeBytes =
      typeof file.sizeInBytes === 'number'
        ? file.sizeInBytes
        : typeof file.size === 'number'
          ? file.size
          : undefined;

    return {
      id: file.id as number,
      ...(typeof file.documentId === 'string' ? { documentId: file.documentId } : {}),
      url: (file.url as string) ?? '',
      name: (file.name as string) ?? '',
      ...(typeof file.mime === 'string' ? { mime: file.mime } : {}),
      ...(sizeBytes !== undefined ? { size: sizeBytes } : {}),
    };
  },

  /**
   * Find submissions for a specific form
   *
   * @param formId - Form documentId
   * @param query - Query options (filters, sort, pagination)
   * @returns Array of submission records
   */
  async find(formId: string, query: SubmissionQuery = {}): Promise<FormSubmission[]> {
    const results = await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).findMany({
      ...query,
      filters: {
        // Hide save & resume drafts by default: every inbox/export path goes
        // through find(). When the caller pins `status` explicitly (e.g. the
        // savePartial/getPartial draft lookups, which query findMany directly,
        // or a specific status selected in the inbox), that filter wins.
        ...withDefaultDraftExclusion(query.filters),
        form: { documentId: formId },
      },
      sort: query.sort || { createdAt: 'desc' },
      populate: query.populate || ['form'],
    });

    return results as unknown as FormSubmission[];
  },

  /**
   * Find a single submission by documentId
   *
   * @param documentId - Submission documentId
   * @returns Submission record or null
   */
  async findOne(documentId: string): Promise<FormSubmission | null> {
    const result = await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).findOne({
      documentId,
      populate: ['form'],
    });

    return result as unknown as FormSubmission | null;
  },

  /**
   * Update a submission record
   *
   * When a submission's status or data changes, fires the `submission.updated`
   * webhook event (in the background) for any webhook subscribed to it.
   *
   * @param documentId - Submission documentId
   * @param data - Fields to update
   * @returns Updated submission record
   */
  async update(
    documentId: string,
    data: Partial<{
      status: SubmissionStatus;
      data: Record<string, unknown>;
      metadata: Partial<SubmissionMetadata>;
    }>,
    options: { triggerWebhooks?: boolean } = {}
  ): Promise<FormSubmission> {
    const { triggerWebhooks = true } = options;

    const result = (await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).update({
      documentId,
      data: data as Record<string, unknown>,
      populate: ['form'],
    })) as unknown as FormSubmission;

    // Fire the submission.updated webhook event in the background.
    // Don't block the update response on webhook delivery. System-driven
    // updates (e.g. auto-mark-as-read on first view) pass triggerWebhooks:false
    // so merely opening a submission does not emit a webhook.
    if (triggerWebhooks) {
      this.triggerUpdateWebhooks(result, data).catch((error: Error) => {
        strapi.log.error('[FormFlow] submission.updated webhook error:', error);
      });
    }

    return result;
  },

  /**
   * Transition a submission's approval status (Business feature).
   *
   * Validates the requested status, updates `approvalStatus`/`approvalNote`, and
   * fires the `submission.updated` webhook so approval decisions are observable.
   * The license check lives in the controller (see {@link controllers/submission})
   * — this method keeps the MIT service free of entitlement logic.
   *
   * @param documentId - Submission documentId
   * @param approvalStatus - New approval status (`pending`|`approved`|`rejected`)
   * @param approvalNote - Optional note explaining the decision
   * @returns Updated submission record
   */
  async approveSubmission(
    documentId: string,
    approvalStatus: ApprovalStatus,
    approvalNote?: string
  ): Promise<FormSubmission> {
    if (!APPROVAL_STATUSES.includes(approvalStatus)) {
      throw new Error(`Invalid approvalStatus. Must be one of: ${APPROVAL_STATUSES.join(', ')}`);
    }

    const changed = { approvalStatus, approvalNote: approvalNote ?? null };

    const result = (await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).update({
      documentId,
      data: changed as Record<string, unknown>,
      populate: ['form'],
    })) as unknown as FormSubmission;

    // Surface approval transitions in webhooks, in the background.
    this.triggerUpdateWebhooks(result, changed).catch((error: Error) => {
      strapi.log.error('[FormFlow] submission.updated (approval) webhook error:', error);
    });

    return result;
  },

  /**
   * Trigger `submission.updated` webhooks for an updated submission.
   *
   * Loads the parent form (with settings) and dispatches to any webhook whose
   * events include `submission.updated`.
   *
   * @param submission - The updated submission record (populated with form)
   * @param changed - The fields that were updated (forwarded as webhook data)
   */
  async triggerUpdateWebhooks(
    submission: FormSubmission,
    changed: Record<string, unknown>
  ): Promise<void> {
    // Webhooks are a Pro feature. When not entitled, skip dispatch entirely —
    // the update has already persisted in the caller.
    if (!strapi.plugin('formflow').service('license').can('webhooks')) {
      strapi.log.info('[FormFlow] Webhooks skipped (submission.updated): not entitled');
      return;
    }

    const formRef = submission.form as { documentId?: string } | undefined;
    if (!formRef?.documentId) {
      return;
    }

    const formService = strapi.plugin('formflow').service('form');
    const form = (await formService.findOne(formRef.documentId)) as SubmittableForm | null;

    const webhooks = form?.settings?.webhooks;
    if (!webhooks?.length) {
      return;
    }

    const webhookService = strapi.plugin('formflow').service('webhook');

    const webhookFormContext = {
      documentId: form!.documentId,
      title: form!.title,
      slug: form!.slug,
    };

    const webhookSubmissionContext = {
      documentId: submission.documentId,
      status: submission.status,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    };

    // The webhook payload data is the submission's current data when available,
    // otherwise the changed fields.
    const payloadData =
      submission.data && typeof submission.data === 'object'
        ? submission.data
        : (changed.data as Record<string, unknown> | undefined);

    await webhookService.triggerAll(
      webhooks,
      'submission.updated',
      webhookFormContext,
      webhookSubmissionContext,
      payloadData
    );
  },

  /**
   * Delete a single submission
   *
   * @param documentId - Submission documentId
   * @returns Deleted submission record
   */
  async delete(documentId: string): Promise<FormSubmission> {
    const result = await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).delete({
      documentId,
    });

    return result as unknown as FormSubmission;
  },

  /**
   * Delete multiple submissions
   *
   * @param formId - Form documentId (for verification)
   * @param submissionIds - Array of submission documentIds
   * @returns Array of deleted submission records
   */
  async deleteMany(formId: string, submissionIds: string[]): Promise<FormSubmission[]> {
    const results: FormSubmission[] = [];

    for (const id of submissionIds) {
      // Verify submission belongs to the form before deleting
      const submission = await this.findOne(id);

      if (submission && submission.form?.documentId === formId) {
        const deleted = await this.delete(id);
        results.push(deleted);
      }
    }

    return results;
  },

  /**
   * Delete every submission older than `days` days (data-retention purge).
   *
   * Used by the daily retention cron job registered in bootstrap when the plugin
   * config `dataRetentionDays` is greater than 0. Delegates to the EE compliance
   * engine, which performs the batched purge. A non-positive `days` is treated as
   * a no-op (retention disabled) and returns 0, so this is always safe to call.
   *
   * @param days - Retention window in days; submissions older than this are purged
   * @returns The number of submissions deleted
   */
  async deleteOlderThan(days: number): Promise<number> {
    // Lazy + guarded: in a stripped MIT fork `ee/compliance` is absent, so the
    // retention purge is a no-op (returns 0). The retention cron is only
    // registered when entitled, so this is in practice only reached with EE present.
    try {
      const { deleteOlderThan: deleteOlderThanEE } = await import('../ee/compliance');
      return deleteOlderThanEE(strapi, days);
    } catch {
      return 0;
    }
  },

  /**
   * Count submissions for a form
   *
   * @param formId - Form documentId
   * @param filters - Additional filters
   * @returns Submission count
   */
  async count(formId: string, filters: Record<string, unknown> = {}): Promise<number> {
    return strapi.documents(SUBMISSION_CONTENT_TYPE_UID).count({
      filters: {
        // Mirror find(): exclude drafts from the pagination total by default,
        // unless the caller pins `status` explicitly (e.g. getStats counts each
        // non-draft status by name).
        ...withDefaultDraftExclusion(filters),
        form: { documentId: formId },
      },
    });
  },

  /**
   * Get submission statistics for a form
   *
   * @param formId - Form documentId
   * @returns Object with counts by status
   */
  async getStats(formId: string): Promise<Record<SubmissionStatus | 'total', number>> {
    const statuses: SubmissionStatus[] = ['new', 'read', 'processed', 'archived', 'spam'];
    const stats: Record<string, number> = { total: 0 };

    for (const status of statuses) {
      const count = await this.count(formId, { status });
      stats[status] = count;
      stats.total += count;
    }

    return stats as Record<SubmissionStatus | 'total', number>;
  },

  /**
   * Mark a submission as read
   *
   * @param documentId - Submission documentId
   * @returns Updated submission record
   */
  async markAsRead(
    documentId: string,
    options: { triggerWebhooks?: boolean } = {}
  ): Promise<FormSubmission> {
    return this.update(documentId, { status: 'read' }, options);
  },

  /**
   * Mark a submission as processed
   *
   * @param documentId - Submission documentId
   * @returns Updated submission record
   */
  async markAsProcessed(documentId: string): Promise<FormSubmission> {
    return this.update(documentId, { status: 'processed' });
  },

  /**
   * Mark a submission as spam
   *
   * @param documentId - Submission documentId
   * @returns Updated submission record
   */
  async markAsSpam(documentId: string): Promise<FormSubmission> {
    return this.update(documentId, { status: 'spam' });
  },

  /**
   * Archive a submission
   *
   * @param documentId - Submission documentId
   * @returns Updated submission record
   */
  async archive(documentId: string): Promise<FormSubmission> {
    return this.update(documentId, { status: 'archived' });
  },

  /**
   * Trigger post-submission hooks (notifications, webhooks)
   * This runs asynchronously after the submission is stored
   *
   * @param form - Form configuration
   * @param submission - Created submission record
   * @param data - Sanitized submission data
   */
  async triggerPostSubmissionHooks(
    form: SubmittableForm,
    submission: FormSubmission,
    data: Record<string, unknown>
  ): Promise<void> {
    const settings = form.settings || {};
    const licenseService = strapi.plugin('formflow').service('license');

    // Email notifications
    if (settings.emailNotifications?.length) {
      const emailService = strapi.plugin('formflow').service('email');

      // Multiple email notifications are a Pro feature (email.advanced). When not
      // entitled only the FIRST enabled notification fires; the rest are skipped.
      const canAdvancedEmail = licenseService.can('email.advanced');
      let sentCount = 0;

      // Prepare form context for email
      const formContext = {
        documentId: form.documentId,
        title: form.title,
        slug: form.slug,
        fields: form.fields?.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
        })),
      };

      // Prepare submission context for email
      const submissionContext = {
        documentId: submission.documentId,
        createdAt: submission.createdAt,
        ipAddress: submission.ipAddress,
      };

      // Send all configured notifications
      for (const notification of settings.emailNotifications) {
        if (notification.enabled && notification.to?.length) {
          // On the free tier the single admin email is reserved for a regular
          // (non-autoresponder) notification. Autoresponders are dispatched by the
          // Pro-only Gate #6 below and are skipped on free, so they must never
          // consume the one free admin slot — otherwise a free user who ordered
          // [autoresponder, admin-notification] would receive no email at all.
          if (!canAdvancedEmail && notification.isAutoresponder) {
            continue;
          }
          // Without email.advanced, stop after the first sent notification.
          if (sentCount >= 1 && !canAdvancedEmail) {
            break;
          }
          sentCount += 1;

          // Run in background to not block response
          emailService
            .sendSubmissionNotification(notification, formContext, submissionContext, data)
            .catch((error: Error) => {
              strapi.log.error(
                `[FormFlow] Email notification failed for form "${form.title}": ${error.message}`
              );
            });
        }
      }

      // --- Gate #6: autoresponder (Pro) ---
      // Dispatch a separate email to the submitter for each autoresponder-flagged
      // notification. EXEC gate: the submission is already persisted, so this must
      // never throw or block the response. When not entitled the block is skipped
      // silently — the free admin notification loop above already fired.
      try {
        if (licenseService.can('email.autoresponder')) {
          const { resolveAutoresponderRecipient } = await import('../ee/email/index');
          for (const notification of settings.emailNotifications) {
            if (!notification.enabled || !notification.isAutoresponder) continue;

            // Resolve recipient from the submitted email field.
            const recipient = resolveAutoresponderRecipient(
              data,
              form.fields ?? [],
              notification.toField
            );
            if (!recipient) {
              strapi.log.warn(
                `[FormFlow] Autoresponder skipped for form "${form.title}": no email field found in submission`
              );
              continue;
            }

            // Override `to` with the submitter's email; cc/bcc are forwarded as-is.
            const autoConfig = { ...notification, to: [recipient] };
            emailService
              .sendSubmissionNotification(autoConfig, formContext, submissionContext, data)
              .catch((error: Error) => {
                strapi.log.error(
                  `[FormFlow] Autoresponder email failed for form "${form.title}": ${error.message}`
                );
              });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        strapi.log.error(
          `[FormFlow] Autoresponder dispatch failed for form "${form.title}": ${message}`
        );
      }
      // --- End Gate #6 ---
    }

    // Webhooks
    if (settings.webhooks?.length) {
      // Webhooks are a Pro feature. When not entitled, skip dispatch entirely —
      // the submission is already persisted at this point.
      if (!licenseService.can('webhooks')) {
        strapi.log.info('[FormFlow] Webhooks skipped: not entitled (upgrade to Pro)');
        return;
      }

      const webhookService = strapi.plugin('formflow').service('webhook');

      // Prepare form context for webhook
      const webhookFormContext = {
        documentId: form.documentId,
        title: form.title,
        slug: form.slug,
      };

      // Prepare submission context for webhook
      const webhookSubmissionContext = {
        documentId: submission.documentId,
        status: submission.status,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
      };

      // Trigger all webhooks in background to not block response
      webhookService
        .triggerAll(
          settings.webhooks,
          'submission.created',
          webhookFormContext,
          webhookSubmissionContext,
          data
        )
        .catch((error: Error) => {
          strapi.log.error(
            `[FormFlow] Webhook trigger failed for form "${form.title}": ${error.message}`
          );
        });
    }

    // Pre-built integrations (Pro)
    // EXEC gate: the submission is already persisted, so this is fire-and-forget
    // and must never throw or block the response. The dynamic import keeps this
    // MIT-licensed file free of a static dependency on EE code, and the
    // `integrationsList.length` guard means there is zero runtime cost (no import,
    // no license lookup) when a form configures no integrations.
    // We import the `../ee` barrel (already eagerly loaded at plugin start via
    // `import './ee'` in server/src/index.ts) rather than the deep
    // `../ee/integrations/index` path: importing the deep path is BOTH a dynamic
    // target here AND statically re-exported by the barrel, which makes the bundler
    // hoist the integration senders into a standalone _chunks file. Routing through
    // the barrel resolves to the entry-resident module, so the senders ship inline
    // in dist/server/index.{js,mjs} (the EE sentinel/bundling guard scans that file).
    const integrationsList: unknown[] =
      ((settings as Record<string, unknown>).integrations as unknown[]) ?? [];
    if (integrationsList.length) {
      if (licenseService.can('integrations')) {
        const { integrationsServiceFactory } = await import('../ee');
        const intSvc = integrationsServiceFactory(strapi);
        intSvc.dispatch(
          integrationsList as import('../ee/integrations/index').IntegrationConfig[],
          'submission.created',
          { documentId: form.documentId, title: form.title, slug: form.slug },
          {
            documentId: submission.documentId,
            status: submission.status,
            createdAt: submission.createdAt as string,
          },
          data
        );
      }
    }
  },

  /**
   * Persist (or update) a partial submission for save & resume.
   *
   * Unlike {@link submit} this stores INCOMPLETE form data under a `draft`
   * status and never validates it, uploads files, fires hooks, or bumps the
   * submission count. The returned `resumeToken` is stored in the draft's
   * metadata; replaying it (via `resumeToken`) updates the same draft in place
   * instead of creating a new one.
   *
   * Save & resume is a Pro feature: the call throws a typed 402 when the license
   * is not entitled (the public controller maps it to an HTTP 402). It must
   * NEVER silently no-op.
   *
   * @param slug - Form slug identifier
   * @param partialData - Raw, possibly-incomplete submission data (keyed by name)
   * @param metadata - Client metadata (IP, user agent, etc.)
   * @param resumeToken - When provided, updates the matching existing draft
   * @returns The resume token and an ISO expiry 7 days out
   * @throws { status: 402 } when the license is not entitled
   * @throws Error if the form is not found or inactive
   */
  async savePartial(
    slug: string,
    partialData: Record<string, unknown>,
    metadata: SubmissionMetadata,
    resumeToken?: string
  ): Promise<PartialSubmissionResult> {
    if (!strapi.plugin('formflow').service('license').can('saveResume')) {
      throw {
        status: 402,
        name: 'PaymentRequiredError',
        message: 'Save & resume requires a Pro license',
      };
    }

    const formService = strapi.plugin('formflow').service('form');
    const validationService = strapi.plugin('formflow').service('validation');

    const form = (await formService.findBySlug(slug)) as SubmittableForm | null;

    if (!form) {
      throw new Error('Form not found');
    }

    if (!form.isActive) {
      throw new Error('Form is not accepting submissions');
    }

    // Create a mutable copy of the partial data and strip control/honeypot
    // fields exactly as a full submit would, so neither is ever persisted.
    const draftData = { ...partialData };
    delete draftData[STEP_INDICATOR_FIELD];

    if (form.settings?.spam?.honeypot) {
      const honeypotFieldName = form.settings.spam.honeypotFieldName || '_gotcha';
      delete draftData[honeypotFieldName];
    }

    // Partial data is incomplete by definition: sanitize (strip unknown fields,
    // coerce types) but do NOT validate, upload files, or trigger hooks.
    const sanitizedData = validationService.sanitize(form.fields || [], draftData);

    // Resume an existing draft when a token is replayed, otherwise create a new one.
    if (resumeToken) {
      // The token lives inside the `metadata` JSON column. Querying JSON sub-keys
      // is not portable across DB connectors, so filter by the relational/enum
      // columns (form + draft status) and match the token in memory. Drafts per
      // form are bounded, so this stays cheap.
      const drafts = (await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).findMany({
        filters: {
          status: 'draft',
          form: { documentId: form.documentId },
        },
      })) as unknown as Array<{ documentId: string; metadata?: Record<string, unknown> }>;

      const existing = drafts.find((d) => d.metadata?.resumeToken === resumeToken);

      if (existing) {
        await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).update({
          documentId: existing.documentId,
          data: {
            data: sanitizedData,
            metadata: {
              ...(existing.metadata || {}),
              resumeToken,
              updatedAt: new Date().toISOString(),
            },
          } as Record<string, unknown>,
        });

        return {
          resumeToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
      }
    }

    const newToken = randomBytes(32).toString('hex');

    await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).create({
      data: {
        form: form.documentId,
        data: sanitizedData,
        metadata: {
          ...metadata,
          resumeToken: newToken,
          formVersion: form.updatedAt,
        },
        status: 'draft' as SubmissionStatus,
      },
    });

    return {
      resumeToken: newToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  },

  /**
   * Retrieve a previously-saved partial submission by its resume token.
   *
   * Save & resume is a Pro feature: throws a typed 402 when unentitled (the
   * public controller maps it to HTTP 402). Returns `null` when no draft matches
   * the token (the controller maps that to a 404).
   *
   * @param slug - Form slug identifier
   * @param resumeToken - The token returned by {@link savePartial}
   * @returns The stored partial data + metadata, or null if no draft matches
   * @throws { status: 402 } when the license is not entitled
   * @throws Error if the form is not found
   */
  async getPartial(slug: string, resumeToken: string): Promise<PartialSubmissionData | null> {
    if (!strapi.plugin('formflow').service('license').can('saveResume')) {
      throw {
        status: 402,
        name: 'PaymentRequiredError',
        message: 'Save & resume requires a Pro license',
      };
    }

    const formService = strapi.plugin('formflow').service('form');
    const form = (await formService.findBySlug(slug)) as SubmittableForm | null;

    if (!form) {
      throw new Error('Form not found');
    }

    // Match the token in memory: JSON sub-key filters are not portable across
    // DB connectors, so narrow by form + draft status and find the token here.
    const drafts = (await strapi.documents(SUBMISSION_CONTENT_TYPE_UID).findMany({
      filters: {
        status: 'draft',
        form: { documentId: form.documentId },
      },
    })) as unknown as Array<{
      data: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>;

    const record = drafts.find((d) => d.metadata?.resumeToken === resumeToken);

    if (!record) {
      return null;
    }

    return { data: record.data, metadata: record.metadata };
  },
});

export default submissionService;
