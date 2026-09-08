import type { Core } from '@strapi/strapi';

/**
 * Fact collection for anonymous telemetry.
 *
 * PRIVACY RULE (enforced here, not by convention): every value that leaves this
 * module must come from a vocabulary WE authored — field type names from the
 * plugin's own catalog, feature keys from `ee/feature-map`, fixed enums, counts
 * and booleans. Nothing an operator or end user typed (form titles, slugs,
 * field labels, success messages, redirect URLs, submission values, hostnames)
 * is ever read here, and unknown/custom values are dropped rather than passed
 * through. Anything added to this file must satisfy that rule.
 */

/** Hard cap on forms inspected per collection pass, so a large install never pays for telemetry. */
const MAX_FORMS_SCANNED = 500;

/**
 * Feature keys mirror `ee/feature-map.ts`. Kept as a plain string list rather
 * than importing the EE type so a stripped MIT fork still compiles.
 */
export type DetectedFeature = string;

export interface TelemetryFacts {
  license_state: string;
  forms_count: number;
  active_forms_count: number;
  submissions_bucket: string;
  max_fields_per_form: number;
  field_types_used: string[];
  features_configured: DetectedFeature[];
  db_client: string;
  os_platform: string;
  node_env: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/**
 * Coarse buckets instead of a raw total. A customer's exact submission volume
 * is commercially sensitive to them; the bucket answers "how big is this
 * install" without recording their business numbers.
 */
export const bucketCount = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 100) return '11-100';
  if (n <= 1000) return '101-1000';
  if (n <= 10000) return '1001-10000';
  return '10000+';
};

/**
 * Detectors run against one form's stored JSON and return feature keys from the
 * fixed `FeatureKey` vocabulary. They answer "is this configured", NOT "is this
 * entitled" — an unentitled install can still have leftover config, and knowing
 * that is the point.
 */
const detectFormFeatures = (form: Record<string, unknown>, into: Set<string>): void => {
  const settings = asRecord(form.settings);
  const fields = asArray(form.fields);

  if (settings.layout === 'multi-step' || asArray(settings.steps).length > 0) {
    into.add('multistep');
  }
  if (fields.some((field) => isRecord(field) && field.conditional != null)) {
    into.add('conditionalLogic');
  }
  if (asArray(settings.webhooks).length > 0) into.add('webhooks');
  if (asArray(settings.integrations).length > 0) into.add('integrations');

  const notifications = asArray(settings.emailNotifications);
  if (notifications.length > 0) {
    into.add('email.notifications');
    for (const notification of notifications) {
      const entry = asRecord(notification);
      if (entry.template != null) into.add('email.customTemplate');
      if (entry.isAutoresponder === true) into.add('email.autoresponder');
      if (entry.omitBranding === true) into.add('email.whiteLabel');
    }
  }

  const spam = asRecord(settings.spam);
  if (spam.honeypot === true) into.add('spam.honeypot');
  if (asRecord(spam.recaptcha).enabled === true) into.add('spam.recaptchaV3');
  if (asRecord(spam.turnstile).enabled === true) into.add('spam.turnstile');
  if (asRecord(spam.hcaptcha).enabled === true) into.add('spam.hcaptcha');
  if (asRecord(spam.ipBlocklist).enabled === true) into.add('spam.ipBlocklist');

  if (asRecord(settings.saveResume).enabled === true) into.add('saveResume');
  if (form.requiresApproval === true) into.add('approval');
  if (Object.keys(asRecord(form.locales)).length > 0) into.add('multiLanguage');
};

/**
 * The set of field type names the plugin itself ships. Used as an allowlist:
 * a type string that is not in this catalog is dropped rather than reported, so
 * a hand-edited or third-party type name can never become free text on the wire.
 */
const knownFieldTypes = (strapi: Core.Strapi): Set<string> => {
  try {
    const catalog = strapi.plugin('formflow').service('form').getFieldTypes() as {
      type?: unknown;
    }[];
    return new Set(
      catalog.map((entry) => String(entry?.type ?? '')).filter((type) => type.length > 0)
    );
  } catch {
    return new Set<string>();
  }
};

/**
 * Collect one snapshot of install-level facts. Every step is independently
 * guarded: a failure anywhere degrades that single value rather than losing the
 * whole ping.
 */
export const collectFacts = async (strapi: Core.Strapi): Promise<TelemetryFacts> => {
  const facts: TelemetryFacts = {
    license_state: 'free',
    forms_count: 0,
    active_forms_count: 0,
    submissions_bucket: '0',
    max_fields_per_form: 0,
    field_types_used: [],
    features_configured: [],
    db_client: 'unknown',
    os_platform: process.platform,
    node_env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  };

  try {
    facts.license_state = strapi.plugin('formflow').service('license').state();
  } catch {
    // License service unavailable (stripped MIT fork) — stays 'free'.
  }

  try {
    facts.db_client = String(strapi.config.get('database.connection.client') ?? 'unknown');
  } catch {
    // Config shape differs across Strapi versions — stays 'unknown'.
  }

  try {
    facts.forms_count = await strapi.documents('plugin::formflow.form').count({});
  } catch {
    // Best-effort.
  }

  try {
    facts.submissions_bucket = bucketCount(
      await strapi.documents('plugin::formflow.form-submission').count({})
    );
  } catch {
    // Best-effort.
  }

  try {
    const allowedTypes = knownFieldTypes(strapi);
    const usedTypes = new Set<string>();
    const usedFeatures = new Set<string>();

    const forms = (await strapi.documents('plugin::formflow.form').findMany({
      fields: ['fields', 'settings', 'locales', 'isActive', 'requiresApproval'],
      limit: MAX_FORMS_SCANNED,
    })) as unknown as Record<string, unknown>[];

    for (const form of forms) {
      if (form.isActive === true) facts.active_forms_count += 1;

      const fields = asArray(form.fields);
      if (fields.length > facts.max_fields_per_form) facts.max_fields_per_form = fields.length;

      for (const field of fields) {
        if (!isRecord(field)) continue;
        const type = String(field.type ?? '');
        // Allowlist check: unknown type names are dropped, never reported.
        if (allowedTypes.has(type)) usedTypes.add(type);
      }

      detectFormFeatures(form, usedFeatures);
    }

    facts.field_types_used = [...usedTypes].sort();
    facts.features_configured = [...usedFeatures].sort();
  } catch {
    // Best-effort: a failed scan leaves the defaults above in place.
  }

  return facts;
};
