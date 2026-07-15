import type { Core } from '@strapi/strapi';
import {
  isLayoutField,
  isFieldVisible,
  isEmptyValue,
  partitionFieldsByVisibility,
  validateUploadedFile,
  type ConditionalRule,
  type UploadedFileMeta,
} from '../utils/validation-rules';
import {
  escapeHtml,
  cleanString,
  coerceNumber,
  coerceBoolean,
  stripControlChars,
} from '../utils/sanitize';

/**
 * Validation result structure returned by the validate method
 */
export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string[]>;
}

/**
 * Validation rule definition
 */
export interface ValidationRule {
  type: string;
  value?: unknown;
  message?: string;
}

/**
 * Form field structure for validation purposes
 */
export interface ValidatableField {
  /**
   * Stable field id (present on stored form fields). Used to resolve multi-step
   * step membership, since `settings.steps[].fields` stores field IDs while
   * submission data is keyed by field `name`. Optional so ad-hoc field lists
   * (without ids) still validate by name.
   */
  id?: string;
  type: string;
  name: string;
  label: string;
  required?: boolean;
  requiredMessage?: string;
  validation?: ValidationRule[];
  options?: Array<{ label: string; value: string }>;
  /** Conditional display logic; if the field is hidden, it is skipped entirely. */
  conditional?: ConditionalRule;
}

// Re-export the conditional rule type so consumers importing from the service
// (e.g. submission service) have access to it alongside the validation types.
export type { ConditionalRule, UploadedFileMeta };

/**
 * Map of uploaded files keyed by form field name. Each entry is either a single
 * uploaded file or an array of them (for multi-file fields). Mirrors the shape
 * of `ctx.request.files` produced by koa-body for a multipart submission.
 */
export type UploadedFilesMap = Record<string, UploadedFileMeta | UploadedFileMeta[] | undefined>;

/**
 * Validation service for form submissions
 * Validates form submission data against field definitions and validation rules
 * Returns detailed error messages for each field that fails validation
 */
const validationService = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Validate form submission data against field definitions
   * @param fields - Array of form field definitions
   * @param data - Submission data to validate
   * @returns ValidationResult with valid flag and error messages by field name
   */
  validate(fields: ValidatableField[], data: Record<string, unknown>): ValidationResult {
    const errors: Record<string, string[]> = {};

    for (const field of fields) {
      // Skip layout fields (heading, paragraph, divider)
      if (isLayoutField(field.type)) {
        continue;
      }

      // File fields carry uploaded file metadata, not a value in `data`. They are
      // validated separately by validateFiles() (called from the submission
      // service with the multipart files map), so skip them here.
      if (field.type === 'file') {
        continue;
      }

      // Skip fields that are hidden by their conditional rule. A hidden field
      // is not displayed to the user, so it must not enforce 'required' or any
      // validation rule against (typically empty) submitted data.
      if (!isFieldVisible(field.conditional, data)) {
        continue;
      }

      const value = data[field.name];
      const fieldErrors: string[] = [];

      // Check required field validation. A required `consent` field is special:
      // an unchecked consent arrives as a *non-empty* falsy value (false /
      // 'false' / 0), so `isEmpty` does not catch it — acceptance is required
      // only when the consent coerces to `true`.
      if (field.required) {
        const consentNotAccepted = field.type === 'consent' && coerceBoolean(value) !== true;
        if (this.isEmpty(value) || consentNotAccepted) {
          fieldErrors.push(field.requiredMessage || `${field.label} is required`);
        }
      }

      // Skip other validations if value is empty and field is not required
      if (this.isEmpty(value) && !field.required) {
        continue;
      }

      // Only run further validation if we have a non-empty value
      if (!this.isEmpty(value)) {
        // Run custom validation rules
        for (const rule of field.validation || []) {
          const error = this.runValidationRule(rule, value, field, data);
          if (error) {
            fieldErrors.push(error);
          }
        }

        // Run built-in type-specific validation
        const typeError = this.validateFieldType(field.type, value);
        if (typeError) {
          fieldErrors.push(typeError);
        }

        // Validate choice field values against allowed options
        const optionError = this.validateFieldOptions(field, value);
        if (optionError) {
          fieldErrors.push(optionError);
        }
      }

      if (fieldErrors.length > 0) {
        errors[field.name] = fieldErrors;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
    };
  },

  /**
   * Validate only a SUBSET of a form's fields, identified by field id or name.
   *
   * Used by step-aware (multi-step) validation: only the fields belonging to a
   * single wizard step are checked, so the frontend can validate one step at a
   * time before the user advances. The filtered subset is then run through the
   * identical per-field logic as {@link validate} (conditional visibility,
   * required, custom rules, type checks, option whitelist), guaranteeing the
   * per-step pass behaves exactly like the corresponding fields would in a full
   * submission.
   *
   * Matching: a field is included when its `id` OR its `name` is present in
   * `fieldKeys`. Step definitions store field IDs (`settings.steps[].fields`),
   * but matching on name as well keeps the helper usable with name-based lists.
   * Conditional visibility is resolved against the FULL field graph and `data`
   * object, so a step field that depends on a visible value entered on an
   * earlier step is resolved correctly while descendants of hidden sources stay
   * hidden.
   *
   * @param fields - Full array of form field definitions
   * @param fieldKeys - Field ids and/or names that belong to the subset
   * @param data - Submission data to validate (full data, keyed by field name)
   * @returns ValidationResult covering only the matched subset of fields
   */
  validateSubset(
    fields: ValidatableField[],
    fieldKeys: string[] | Set<string>,
    data: Record<string, unknown>
  ): ValidationResult {
    const keySet = fieldKeys instanceof Set ? fieldKeys : new Set(fieldKeys);

    const { visible } = partitionFieldsByVisibility(fields, data);
    const subset = visible.filter(
      (field) => (field.id !== undefined && keySet.has(field.id)) || keySet.has(field.name)
    );

    // Reuse the exact full-form per-field validation on the visible subset.
    return this.validate(subset, data);
  },

  /**
   * Validate uploaded files against the form's `file` field definitions.
   *
   * Runs BEFORE the files are uploaded to the media library, so oversize or
   * disallowed files are rejected without ever being persisted. Enforces:
   *  - `required`: a required file field with no uploaded file errors,
   *  - per-file `maxSize` (MB) and `allowedTypes` (MIME / extension) rules.
   *
   * Hidden file fields (by conditional rule) are skipped. Non-file fields are
   * untouched (handled by {@link validate}).
   *
   * @param fields - Array of form field definitions
   * @param files - Uploaded files keyed by field name (from the multipart parser)
   * @param data - The non-file submission data (used for conditional visibility)
   * @returns ValidationResult with valid flag and error messages by field name
   */
  validateFiles(
    fields: ValidatableField[],
    files: UploadedFilesMap,
    data: Record<string, unknown> = {}
  ): ValidationResult {
    const errors: Record<string, string[]> = {};

    for (const field of fields) {
      if (field.type !== 'file') {
        continue;
      }

      // A file field hidden by its conditional rule is not shown to the user and
      // therefore must not enforce required/size/type constraints.
      if (!isFieldVisible(field.conditional, data)) {
        continue;
      }

      const uploaded = files[field.name];
      const fileList: UploadedFileMeta[] = uploaded
        ? Array.isArray(uploaded)
          ? uploaded
          : [uploaded]
        : [];

      const fieldErrors: string[] = [];

      if (fileList.length === 0) {
        if (field.required) {
          fieldErrors.push(field.requiredMessage || `${field.label} is required`);
        }
        // No file uploaded and field optional -> nothing else to validate.
        if (fieldErrors.length > 0) {
          errors[field.name] = fieldErrors;
        }
        continue;
      }

      // Validate each uploaded file against the field's size/type rules.
      for (const file of fileList) {
        fieldErrors.push(...validateUploadedFile(file, field.validation || []));
      }

      if (fieldErrors.length > 0) {
        errors[field.name] = fieldErrors;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
    };
  },

  /**
   * Check if a value is considered empty
   * @param value - Value to check
   * @returns true if the value is empty, false otherwise
   */
  isEmpty(value: unknown): boolean {
    return isEmptyValue(value);
  },

  /**
   * Execute a single validation rule against a value
   * @param rule - Validation rule to execute
   * @param value - Value to validate
   * @param field - Field definition for context
   * @param data - Full submission data (used by cross-field rules like 'matches')
   * @returns Error message if validation fails, null otherwise
   */
  runValidationRule(
    rule: ValidationRule,
    value: unknown,
    field: ValidatableField,
    data: Record<string, unknown> = {}
  ): string | null {
    const ruleValue = rule.value;

    switch (rule.type) {
      case 'minLength': {
        const minLength = Number(ruleValue);
        if (typeof value === 'string' && value.length < minLength) {
          return rule.message || `${field.label} must be at least ${minLength} characters`;
        }
        break;
      }

      case 'maxLength': {
        const maxLength = Number(ruleValue);
        if (typeof value === 'string' && value.length > maxLength) {
          return rule.message || `${field.label} must be no more than ${maxLength} characters`;
        }
        break;
      }

      case 'min': {
        const minValue = Number(ruleValue);
        const numericValue = Number(value);
        if (!isNaN(numericValue) && numericValue < minValue) {
          return rule.message || `${field.label} must be at least ${minValue}`;
        }
        break;
      }

      case 'max': {
        const maxValue = Number(ruleValue);
        const numericValue = Number(value);
        if (!isNaN(numericValue) && numericValue > maxValue) {
          return rule.message || `${field.label} must be no more than ${maxValue}`;
        }
        break;
      }

      case 'pattern': {
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          try {
            const regex = new RegExp(ruleValue);
            if (!regex.test(value)) {
              return rule.message || `${field.label} format is invalid`;
            }
          } catch {
            // Invalid regex pattern - skip validation but log warning
            strapi.log.warn(`Invalid regex pattern in validation rule: ${ruleValue}`);
          }
        }
        break;
      }

      case 'minSelected': {
        const minSelected = Number(ruleValue);
        if (Array.isArray(value) && value.length < minSelected) {
          return (
            rule.message || `Select at least ${minSelected} option${minSelected !== 1 ? 's' : ''}`
          );
        }
        break;
      }

      case 'maxSelected': {
        const maxSelected = Number(ruleValue);
        if (Array.isArray(value) && value.length > maxSelected) {
          return (
            rule.message ||
            `Select no more than ${maxSelected} option${maxSelected !== 1 ? 's' : ''}`
          );
        }
        break;
      }

      case 'minDate': {
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          const minDate = new Date(ruleValue);
          const valueDate = new Date(value);
          if (!isNaN(minDate.getTime()) && !isNaN(valueDate.getTime()) && valueDate < minDate) {
            return rule.message || `${field.label} must be on or after ${ruleValue}`;
          }
        }
        break;
      }

      case 'maxDate': {
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          const maxDate = new Date(ruleValue);
          const valueDate = new Date(value);
          if (!isNaN(maxDate.getTime()) && !isNaN(valueDate.getTime()) && valueDate > maxDate) {
            return rule.message || `${field.label} must be on or before ${ruleValue}`;
          }
        }
        break;
      }

      case 'minTime': {
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          // Compare time strings in HH:MM format
          if (value < ruleValue) {
            return rule.message || `${field.label} must be at or after ${ruleValue}`;
          }
        }
        break;
      }

      case 'maxTime': {
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          // Compare time strings in HH:MM format
          if (value > ruleValue) {
            return rule.message || `${field.label} must be at or before ${ruleValue}`;
          }
        }
        break;
      }

      case 'maxSize': {
        // File size validation - value should be file size in bytes, ruleValue in MB
        const maxSizeBytes = Number(ruleValue) * 1024 * 1024;
        const fileSize = Number(value);
        if (!isNaN(fileSize) && fileSize > maxSizeBytes) {
          return rule.message || `File size must be no more than ${ruleValue}MB`;
        }
        break;
      }

      case 'allowedTypes': {
        // File type validation - check against allowed MIME types or extensions
        if (typeof ruleValue === 'string' && typeof value === 'string') {
          const allowedTypes = ruleValue.split(',').map((t) => t.trim().toLowerCase());
          const fileType = value.toLowerCase();
          const matches = allowedTypes.some((allowed) => {
            if (allowed.endsWith('/*')) {
              // Wildcard type (e.g., image/*)
              const category = allowed.slice(0, -2);
              return fileType.startsWith(category);
            }
            return fileType === allowed || fileType.endsWith(allowed);
          });
          if (!matches) {
            return rule.message || `File type not allowed. Accepted types: ${ruleValue}`;
          }
        }
        break;
      }

      case 'matches': {
        // Cross-field equality (e.g. password confirmation).
        // rule.value is the NAME of the other field this value must equal.
        if (typeof ruleValue === 'string') {
          const otherValue = data[ruleValue];
          // Compare as strings so '1' (text input) matches 1, etc.
          if (String(value) !== String(otherValue)) {
            return rule.message || `${field.label} does not match`;
          }
        }
        break;
      }

      case 'custom': {
        // Safe no-op stub. Custom validation would require sandboxed evaluation
        // of user-provided logic, which is intentionally not implemented here.
        break;
      }
    }

    return null;
  },

  /**
   * Validate field value against built-in type-specific rules
   * @param type - Field type
   * @param value - Value to validate
   * @returns Error message if validation fails, null otherwise
   */
  validateFieldType(type: string, value: unknown): string | null {
    switch (type) {
      case 'email': {
        // RFC 5322 simplified email regex
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (typeof value === 'string' && !emailRegex.test(value)) {
          return 'Invalid email address';
        }
        break;
      }

      case 'url': {
        if (typeof value === 'string') {
          try {
            const url = new URL(value);
            // Ensure protocol is http or https
            if (!['http:', 'https:'].includes(url.protocol)) {
              return 'URL must start with http:// or https://';
            }
          } catch {
            return 'Invalid URL format';
          }
        }
        break;
      }

      case 'number': {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          return 'Must be a valid number';
        }
        break;
      }

      case 'phone': {
        // Allow digits, spaces, hyphens, plus sign, and parentheses
        const phoneRegex = /^[\d\s\-+()]+$/;
        if (typeof value === 'string') {
          // Remove all formatting to check minimum digits
          const digitsOnly = value.replace(/\D/g, '');
          if (!phoneRegex.test(value)) {
            return 'Invalid phone number format';
          }
          if (digitsOnly.length < 7) {
            return 'Phone number must have at least 7 digits';
          }
          if (digitsOnly.length > 15) {
            return 'Phone number is too long';
          }
        }
        break;
      }

      case 'date': {
        if (typeof value === 'string') {
          const date = new Date(value);
          if (isNaN(date.getTime())) {
            return 'Invalid date format';
          }
        }
        break;
      }

      case 'time': {
        // Validate time format (HH:MM or HH:MM:SS)
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
        if (typeof value === 'string' && !timeRegex.test(value)) {
          return 'Invalid time format (use HH:MM)';
        }
        break;
      }

      case 'datetime': {
        if (typeof value === 'string') {
          const datetime = new Date(value);
          if (isNaN(datetime.getTime())) {
            return 'Invalid date and time format';
          }
        }
        break;
      }

      case 'boolean': {
        if (
          typeof value !== 'boolean' &&
          value !== 'true' &&
          value !== 'false' &&
          value !== 1 &&
          value !== 0
        ) {
          return 'Must be true or false';
        }
        break;
      }

      case 'signature': {
        // Base64 image data URL captured from the signature pad.
        if (typeof value !== 'string' || !value.startsWith('data:image/')) {
          return 'Signature must be a valid image data URL';
        }
        break;
      }

      case 'rating': {
        // Whole-number rating / NPS score on a 1–10 scale.
        const n = Number(value);
        if (!(!isNaN(n) && n >= 1 && n <= 10 && Number.isInteger(n))) {
          return 'Rating must be a whole number between 1 and 10';
        }
        break;
      }

      case 'address': {
        // Either a raw address string or an object with at least one truthy
        // string field (e.g. street). Reject empty string / empty object.
        if (typeof value === 'string') {
          if (value.trim() === '') {
            return 'Address must be a non-empty value';
          }
        } else if (value && typeof value === 'object') {
          const hasField = Object.values(value as Record<string, unknown>).some(
            (v) => typeof v === 'string' && v.trim() !== ''
          );
          if (!hasField) {
            return 'Address must be a non-empty value';
          }
        }
        break;
      }

      case 'richtext': {
        // HTML or Markdown string; no further validation (escaped on output).
        break;
      }

      case 'calculated': {
        // Read-only value computed server-side; accept any non-null value.
        break;
      }

      case 'payment': {
        // Capture-only: a Stripe PaymentIntent ID. No Stripe API call here.
        if (typeof value !== 'string' || !value.startsWith('pi_')) {
          return 'Payment reference must be a valid Stripe PaymentIntent ID';
        }
        break;
      }

      case 'consent': {
        // A consent checkbox. Any value is accepted at the type level — whether
        // a *required* consent must be checked is enforced in the per-field
        // required check (which has access to `field.required`), since an
        // unchecked consent (false/'false'/0) is non-empty and otherwise valid.
        break;
      }
    }

    return null;
  },

  /**
   * Validate that choice field values are within allowed options
   * @param field - Field definition with options
   * @param value - Value(s) to validate
   * @returns Error message if validation fails, null otherwise
   */
  validateFieldOptions(field: ValidatableField, value: unknown): string | null {
    // Only validate choice fields with defined options
    if (!['select', 'radio', 'checkbox'].includes(field.type) || !field.options?.length) {
      return null;
    }

    const allowedValues = field.options.map((opt) => opt.value);

    if (field.type === 'checkbox') {
      // Checkbox allows multiple values. Normalize a non-array value (e.g. a
      // single selected option submitted as a scalar) to an array so every
      // element is still checked against the allowed-options whitelist.
      const values = Array.isArray(value) ? value : [value];
      const invalidValues = values.filter((v) => !allowedValues.includes(String(v)));
      if (invalidValues.length > 0) {
        return `Invalid selection: ${invalidValues.join(', ')}`;
      }
    } else if (['select', 'radio'].includes(field.type)) {
      // Select and radio allow single value
      if (!allowedValues.includes(String(value))) {
        return 'Invalid selection';
      }
    }

    return null;
  },

  /**
   * Sanitize form submission data for safe storage
   * Removes unexpected fields and applies type-specific sanitization
   * @param fields - Array of form field definitions
   * @param data - Raw submission data
   * @returns Sanitized data object with only expected fields
   */
  sanitize(fields: ValidatableField[], data: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const field of fields) {
      // Skip layout fields
      if (isLayoutField(field.type)) {
        continue;
      }

      const value = data[field.name];

      // Only include fields that have values in the submission
      if (value !== undefined) {
        sanitized[field.name] = this.sanitizeValue(field.type, value);
      }
    }

    return sanitized;
  },

  /**
   * Sanitize a single value based on field type for RAW storage.
   *
   * ESCAPE-ON-OUTPUT MODEL: Values are stored raw-but-cleaned. String values are
   * stripped of null bytes / control characters and trimmed, but are NOT
   * HTML-entity-escaped here. Escaping happens at each OUTPUT boundary instead:
   *   - email HTML rendering must call escapeHtml() on interpolated values,
   *   - CSV export must apply CSV escaping,
   *   - admin UI relies on React's automatic escaping.
   * Do NOT reintroduce escapeHtml() in this function — that would double-escape
   * at the output boundaries and corrupt stored data.
   *
   * @param type - Field type
   * @param value - Value to sanitize
   * @returns Sanitized value
   */
  sanitizeValue(type: string, value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    switch (type) {
      case 'text':
      case 'textarea':
      case 'email':
      case 'url':
      case 'phone':
      case 'password': {
        // Strip control chars and trim; store RAW (escaped on output).
        return cleanString(value);
      }

      case 'number': {
        return coerceNumber(value);
      }

      case 'boolean':
      case 'consent': {
        // Coerce to a real boolean so `submission.ts` can compare with `=== true`
        // and store an accurate `metadata.consents[].accepted` flag.
        return coerceBoolean(value);
      }

      case 'checkbox': {
        // Ensure checkbox values are always an array of cleaned strings.
        if (Array.isArray(value)) {
          return value.map((v) => cleanString(v));
        }
        return [cleanString(value)];
      }

      case 'select':
      case 'radio': {
        // Single selection, cleaned string (raw, escaped on output).
        return cleanString(value);
      }

      case 'date':
      case 'time':
      case 'datetime': {
        // Return as-is if valid, null otherwise
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (type === 'time') {
            // Time format validation
            const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
            return timeRegex.test(trimmed) ? trimmed : null;
          }
          // Date/datetime validation
          const date = new Date(trimmed);
          return isNaN(date.getTime()) ? null : trimmed;
        }
        return null;
      }

      case 'hidden': {
        // Hidden fields - strip control chars but preserve value (raw, no trim
        // to avoid altering machine-generated tokens). Escaped on output.
        return stripControlChars(typeof value === 'string' ? value : String(value));
      }

      case 'file': {
        // File fields are resolved by the submission service: by the time this
        // runs, the value is already a media reference (or array of them) of the
        // shape { id, documentId, url, name, mime, size }. Store it verbatim.
        return value;
      }

      case 'signature': {
        // Base64 data URL stored raw-but-cleaned (escaped on output).
        return cleanString(value);
      }

      case 'rating': {
        return coerceNumber(value);
      }

      case 'address': {
        // Raw string, or an object whose string fields are cleaned individually.
        if (typeof value === 'string') {
          return cleanString(value);
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const cleaned: Record<string, unknown> = {};
          for (const [key, fieldValue] of Object.entries(value)) {
            cleaned[key] = typeof fieldValue === 'string' ? cleanString(fieldValue) : fieldValue;
          }
          return cleaned;
        }
        return value;
      }

      case 'richtext': {
        // Strip control chars but do NOT HTML-escape (escape-on-output).
        return cleanString(value);
      }

      case 'calculated': {
        // Server-computed value, already safe — store verbatim.
        return value;
      }

      case 'payment': {
        return cleanString(value);
      }

      default:
        return value;
    }
  },

  /**
   * Escape HTML entities to prevent XSS.
   *
   * Provided for OUTPUT-boundary use (e.g. building email HTML). Under the
   * escape-on-output model stored values are NOT escaped, so callers rendering
   * stored data into HTML should escape with this helper at render time.
   * Delegates to the shared util so the implementation lives in one place.
   *
   * @param str - String to escape
   * @returns Escaped string
   */
  escapeHtml(str: string): string {
    return escapeHtml(str);
  },

  /**
   * Validate honeypot field for spam detection
   * Returns true if the submission appears to be spam (honeypot field has a value)
   * @param data - Submission data
   * @param honeypotFieldName - Name of the honeypot field
   * @returns true if spam detected, false otherwise
   */
  isSpam(data: Record<string, unknown>, honeypotFieldName: string): boolean {
    const honeypotValue = data[honeypotFieldName];
    // If honeypot field has any non-empty value, it's likely spam
    return !this.isEmpty(honeypotValue);
  },
});

export default validationService;
