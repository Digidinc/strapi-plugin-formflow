/**
 * Shared validation-rule catalog and helpers.
 *
 * This module is the single source of truth describing which validation rules
 * apply to which field type (mirroring the "Validation System" matrix in
 * architecture.md) and the conditional-display logic used to decide whether a
 * field is currently visible. The validation service imports from here so the
 * matrix lives in one place and can be reused by other layers (e.g. an admin
 * rule editor) later.
 */

/**
 * Operators supported by a field's conditional-display rule.
 */
export type ConditionalOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty';

/**
 * Conditional display logic attached to a field. When present, the field is
 * only shown (and therefore only validated) if the rule evaluates truthy
 * against the rest of the submitted data.
 */
export interface ConditionalRule {
  /** Name of the other field whose value is inspected. */
  field: string;
  /** Comparison operator. */
  operator: ConditionalOperator;
  /** Value to compare against (unused for is_empty / is_not_empty). */
  value?: unknown;
}

/**
 * Field types that render layout/content only and never carry a value to
 * validate or sanitize (heading, paragraph, divider).
 */
export const LAYOUT_FIELD_TYPES = ['heading', 'paragraph', 'divider'] as const;

/**
 * Returns true when the given field type is a layout-only type.
 *
 * @param type - Field type to test
 */
export const isLayoutField = (type: string): boolean =>
  (LAYOUT_FIELD_TYPES as readonly string[]).includes(type);

/**
 * Validation rule matrix: maps each validation rule type to the set of field
 * types it may legitimately be applied to. Mirrors the matrix documented in
 * architecture.md ("Validation System" → "Validation Rules").
 *
 * The validation service applies any rule that is present on a field, but this
 * catalog lets callers (e.g. the admin UI or future schema validators)
 * determine which rules are meaningful for a given field type.
 */
export const VALIDATION_RULE_MATRIX: Record<string, readonly string[]> = {
  minLength: ['text', 'textarea', 'password'],
  maxLength: ['text', 'textarea', 'password'],
  min: ['number'],
  max: ['number'],
  pattern: ['text', 'phone'],
  email: ['email'],
  url: ['url'],
  matches: ['text', 'textarea', 'email', 'password', 'phone', 'url', 'number'],
  minDate: ['date', 'datetime'],
  maxDate: ['date', 'datetime'],
  minTime: ['time'],
  maxTime: ['time'],
  minSelected: ['checkbox'],
  maxSelected: ['checkbox'],
  maxSize: ['file'],
  allowedTypes: ['file'],
};

/**
 * Returns true when a validation rule type is applicable to the given field
 * type, per VALIDATION_RULE_MATRIX. Unknown rule types are treated as
 * applicable (permissive) so custom/unmatched rules are not silently dropped.
 *
 * @param ruleType - Validation rule type (e.g. 'minLength')
 * @param fieldType - Field type (e.g. 'text')
 */
export const isRuleApplicable = (ruleType: string, fieldType: string): boolean => {
  const applicableTypes = VALIDATION_RULE_MATRIX[ruleType];
  if (!applicableTypes) {
    return true;
  }
  return applicableTypes.includes(fieldType);
};

/**
 * Minimal metadata describing an uploaded file, taken from the multipart parser
 * (formidable). Only the fields needed for server-side validation are required;
 * different parsers expose slightly different property names so we accept the
 * common aliases.
 */
export interface UploadedFileMeta {
  /** Original file name as provided by the client (formidable: originalFilename). */
  originalFilename?: string | null;
  /** Alternative name field used by some parsers. */
  name?: string | null;
  /** Declared MIME type (formidable: mimetype). */
  mimetype?: string | null;
  /** Alternative MIME field used by some parsers. */
  type?: string | null;
  /** File size in bytes. */
  size?: number;
}

/**
 * Extract the file name and declared MIME type from an uploaded file regardless
 * of which multipart parser produced it.
 *
 * @param file - Uploaded file metadata
 */
export const getUploadedFileInfo = (
  file: UploadedFileMeta
): { fileName: string; mimeType: string; size: number } => ({
  fileName: file.originalFilename || file.name || 'file',
  mimeType: (file.mimetype || file.type || '').toLowerCase(),
  size: typeof file.size === 'number' ? file.size : 0,
});

/**
 * Test whether a file's MIME type (and extension as a fallback) is permitted by
 * a comma-separated allow list. Supports wildcard categories (e.g. `image/*`)
 * and bare extensions (e.g. `.pdf` / `pdf`).
 *
 * @param mimeType - The file's declared MIME type (lowercased)
 * @param fileName - The file's original name (used for extension matching)
 * @param allowedTypesRaw - Comma-separated list of allowed MIME types / extensions
 */
export const isFileTypeAllowed = (
  mimeType: string,
  fileName: string,
  allowedTypesRaw: string
): boolean => {
  const allowedTypes = allowedTypesRaw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  if (allowedTypes.length === 0) {
    // No constraint configured -> allow.
    return true;
  }

  const lowerName = fileName.toLowerCase();

  return allowedTypes.some((allowed) => {
    if (allowed.endsWith('/*')) {
      // Wildcard category, e.g. image/* matches image/png.
      const category = allowed.slice(0, -1); // keep trailing slash -> "image/"
      return mimeType.startsWith(category);
    }
    if (allowed.startsWith('.')) {
      // Bare extension, e.g. ".pdf".
      return lowerName.endsWith(allowed);
    }
    if (!allowed.includes('/')) {
      // Bare extension without dot, e.g. "pdf".
      return lowerName.endsWith(`.${allowed}`);
    }
    // Exact MIME type match.
    return mimeType === allowed;
  });
};

/**
 * Validate a single uploaded file against a field's `maxSize` / `allowedTypes`
 * validation rules. `maxSize` is expressed in MEGABYTES (matching the admin
 * rule editor and the existing validation-service convention).
 *
 * @param file - Uploaded file metadata from the multipart parser
 * @param rules - The field's validation rules (only maxSize/allowedTypes apply)
 * @returns An array of human-readable error messages (empty when the file is valid)
 */
export const validateUploadedFile = (
  file: UploadedFileMeta,
  rules: Array<{ type: string; value?: unknown; message?: string }> = []
): string[] => {
  const errors: string[] = [];
  const { fileName, mimeType, size } = getUploadedFileInfo(file);

  for (const rule of rules) {
    if (rule.type === 'maxSize') {
      const maxSizeMb = Number(rule.value);
      if (!Number.isNaN(maxSizeMb) && maxSizeMb > 0) {
        const maxSizeBytes = maxSizeMb * 1024 * 1024;
        if (size > maxSizeBytes) {
          errors.push(
            rule.message || `File "${fileName}" exceeds the maximum size of ${maxSizeMb}MB`
          );
        }
      }
    } else if (rule.type === 'allowedTypes') {
      if (typeof rule.value === 'string' && rule.value.trim().length > 0) {
        if (!isFileTypeAllowed(mimeType, fileName, rule.value)) {
          errors.push(
            rule.message || `File "${fileName}" type is not allowed. Accepted types: ${rule.value}`
          );
        }
      }
    }
  }

  return errors;
};

/**
 * Determine whether a value counts as "empty" for conditional/required checks.
 * Kept consistent with the validation service's isEmpty semantics.
 *
 * @param value - Value to test
 */
export const isEmptyValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
};

/**
 * Evaluate a field's conditional rule against the full submission data.
 *
 * @param conditional - The conditional rule to evaluate
 * @param data - The full submitted data, keyed by field name
 * @returns true if the condition is satisfied (field should be shown), false otherwise
 */
export const evaluateConditional = (
  conditional: ConditionalRule,
  data: Record<string, unknown>
): boolean => {
  const target = data[conditional.field];

  switch (conditional.operator) {
    case 'equals':
      // Compare as strings for type-agnostic equality (form values arrive as strings).
      return String(target ?? '') === String(conditional.value ?? '');

    case 'not_equals':
      return String(target ?? '') !== String(conditional.value ?? '');

    case 'contains': {
      const needle = String(conditional.value ?? '');
      if (Array.isArray(target)) {
        return target.map((v) => String(v)).includes(needle);
      }
      if (typeof target === 'string') {
        return target.includes(needle);
      }
      return false;
    }

    case 'is_empty':
      return isEmptyValue(target);

    case 'is_not_empty':
      return !isEmptyValue(target);

    default:
      // Unknown operator: default to visible so we never silently hide a field.
      return true;
  }
};

/**
 * Decide whether a field is currently visible given the submission data.
 * A field with no conditional rule is always visible. A field with a
 * conditional rule is visible only when that rule evaluates truthy.
 *
 * Hidden fields should be skipped entirely during validation (no required
 * enforcement, no rule evaluation).
 *
 * @param conditional - The field's optional conditional rule
 * @param data - The full submitted data
 * @returns true if the field is visible, false if hidden by its condition
 */
export const isFieldVisible = (
  conditional: ConditionalRule | undefined,
  data: Record<string, unknown>
): boolean => {
  if (!conditional || !conditional.field) {
    return true;
  }
  return evaluateConditional(conditional, data);
};

export const partitionFieldsByVisibility = <
  T extends {
    conditional?: ConditionalRule;
  },
>(
  fields: T[],
  data: Record<string, unknown>
): { visible: T[]; hidden: T[] } => {
  const visible: T[] = [];
  const hidden: T[] = [];

  for (const field of fields) {
    (isFieldVisible(field.conditional, data) ? visible : hidden).push(field);
  }

  return { visible, hidden };
};
