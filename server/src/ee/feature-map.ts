/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

export type Tier = 'free' | 'pro' | 'business';
export type LimitKey = 'telegramConnections';
export type EntitlementLimit = number | 'unlimited';

export const TIER_LIMITS: Record<Tier, Record<LimitKey, EntitlementLimit>> = {
  free: { telegramConnections: 0 },
  pro: { telegramConnections: 1 },
  business: { telegramConnections: 3 },
};

export function limitForTier(tier: Tier, key: LimitKey): EntitlementLimit {
  return TIER_LIMITS[tier][key];
}

export type FeatureKey =
  // Pro — webhooks
  | 'webhooks'
  // Pro — email
  | 'email.advanced'
  | 'email.customTemplate'
  | 'email.autoresponder'
  | 'email.whiteLabel'
  // Pro — spam
  | 'spam.recaptchaV3'
  | 'spam.turnstile'
  | 'spam.hcaptcha'
  | 'spam.ipBlocklist'
  // Pro — form builder
  | 'multistep'
  | 'conditionalLogic'
  | 'whiteLabel'
  // Pro — export / analytics / engagement
  | 'export.advanced'
  | 'analytics'
  | 'saveResume'
  | 'integrations'
  // Pro — field types (advanced; file is FREE)
  | 'fields.signature'
  | 'fields.rating'
  | 'fields.address'
  | 'fields.richtext'
  | 'fields.calculated'
  | 'fields.payment'
  // Free — field types
  | 'fields.file'
  // Business — compliance
  | 'compliance.retention'
  | 'compliance.anonymizeIp'
  | 'compliance.consent'
  | 'compliance.audit'
  // Business — workflow / i18n
  | 'approval'
  | 'multiLanguage';

export const FEATURE_TIER: Record<FeatureKey, Tier> = {
  // Pro
  webhooks: 'pro',
  'email.advanced': 'pro',
  'email.customTemplate': 'pro',
  'email.autoresponder': 'pro',
  'email.whiteLabel': 'pro',
  'spam.recaptchaV3': 'pro',
  'spam.turnstile': 'pro',
  'spam.hcaptcha': 'pro',
  'spam.ipBlocklist': 'pro',
  multistep: 'pro',
  conditionalLogic: 'pro',
  whiteLabel: 'pro',
  'export.advanced': 'pro',
  analytics: 'pro',
  saveResume: 'pro',
  integrations: 'pro',
  'fields.signature': 'pro',
  'fields.rating': 'pro',
  'fields.address': 'pro',
  'fields.richtext': 'pro',
  'fields.calculated': 'pro',
  'fields.payment': 'pro',
  // Free
  'fields.file': 'free',
  // Business
  'compliance.retention': 'business',
  'compliance.anonymizeIp': 'business',
  'compliance.consent': 'business',
  'compliance.audit': 'business',
  approval: 'business',
  multiLanguage: 'business',
};

export const TIER_RANK: Record<Tier, number> = {
  free: 0,
  pro: 1,
  business: 2,
};

/** Returns the numeric rank for a tier (free=0, pro=1, business=2). */
export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

/**
 * Pure helper: is the given tier entitled to use a feature?
 * tierRank(tier) >= tierRank(FEATURE_TIER[feature])
 */
export function can(tier: Tier, feature: FeatureKey): boolean {
  return TIER_RANK[tier] >= TIER_RANK[FEATURE_TIER[feature]];
}
