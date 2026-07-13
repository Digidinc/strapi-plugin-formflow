import { FEATURE_TIER, type FeatureKey, type Tier } from '../ee/feature-map';
import type { LicenseResolution } from '../ee/license-state';

export type FormApiErrorKind = 'validation' | 'payment_required' | 'other';

const FORM_SAVE_FEATURE_LABELS = {
  multistep: 'Multi-step forms',
  conditionalLogic: 'Conditional Logic',
  'fields.signature': 'Signature fields',
  'fields.rating': 'Rating / NPS fields',
  'fields.address': 'Address fields',
  'fields.richtext': 'Rich Text fields',
  'fields.calculated': 'Calculated fields',
  'fields.payment': 'Stripe Payment fields',
  'compliance.consent': 'Consent Checkbox fields',
  whiteLabel: 'Custom CSS',
  approval: 'Approval workflow',
  multiLanguage: 'Multi-language forms',
} as const satisfies Partial<Record<FeatureKey, string>>;

export type FormSaveFeatureKey = keyof typeof FORM_SAVE_FEATURE_LABELS;
export type PaymentRequiredCopy =
  | {
      kind: 'known';
      feature: FormSaveFeatureKey;
      defaultLabel: string;
      tier: Exclude<Tier, 'free'>;
    }
  | { kind: 'generic' };

export interface ConditionalConfigIssueDetails {
  fieldId?: string;
  fieldName?: string;
  code: string;
  message: string;
}

export interface FormApiErrorDetails {
  feature?: string;
  requiredTier?: Exclude<Tier, 'free'>;
  upgradeUrl?: string;
  resolution?: LicenseResolution;
  conditionalIssues?: ConditionalConfigIssueDetails[];
  [key: string]: unknown;
}

export interface FormApiError extends Error {
  details?: FormApiErrorDetails;
  status?: number;
}

interface StrapiFetchError {
  message?: string;
  status?: number;
  response?: {
    status?: number;
    data?: {
      error?: {
        message?: string;
        details?: FormApiErrorDetails;
        status?: number;
      };
    };
  };
}

/** Normalize Strapi fetch failures without discarding structured server details. */
export function toFormApiError(error: unknown, fallbackMessage: string): FormApiError {
  const fetchError = error as StrapiFetchError | undefined;
  const serverError = fetchError?.response?.data?.error;
  const message =
    serverError?.message || (error instanceof Error ? error.message : '') || fallbackMessage;

  const normalized = new Error(message) as FormApiError;
  normalized.details = serverError?.details;
  normalized.status = serverError?.status ?? fetchError?.response?.status ?? fetchError?.status;
  return normalized;
}

/** Distinguish field/config validation from an authoritative plan gate. */
export function classifyFormApiError(error: FormApiError): FormApiErrorKind {
  if (error.status === 400) return 'validation';
  if (error.status === 402) return 'payment_required';
  return 'other';
}

/** Accept only authoritative resolution values from a structured server response. */
export function paymentRequiredResolution(details?: FormApiErrorDetails): LicenseResolution | null {
  const resolution = details?.resolution;
  return resolution === 'checking' || resolution === 'resolved' || resolution === 'unavailable'
    ? resolution
    : null;
}

/** Select feature-specific copy only for server feature values known by this client. */
export function paymentRequiredCopy(details?: FormApiErrorDetails): PaymentRequiredCopy {
  const feature = details?.feature;
  if (
    typeof feature !== 'string' ||
    !Object.prototype.hasOwnProperty.call(FORM_SAVE_FEATURE_LABELS, feature)
  ) {
    return { kind: 'generic' };
  }

  const knownFeature = feature as FormSaveFeatureKey;
  const tier = FEATURE_TIER[knownFeature];
  if (tier !== 'pro' && tier !== 'business') return { kind: 'generic' };

  return {
    kind: 'known',
    feature: knownFeature,
    defaultLabel: FORM_SAVE_FEATURE_LABELS[knownFeature],
    tier,
  };
}

/** Return only absolute HTTP(S) upgrade links supplied by the server. */
export function safeUpgradeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}
