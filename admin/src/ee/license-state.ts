/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { FEATURE_TIER, type EntitlementLimit, type FeatureKey, type LimitKey } from './feature-map';

export type LicenseResolution = 'checking' | 'resolved' | 'unavailable';
export type FeatureAccess = 'checking' | 'entitled' | 'unentitled' | 'unavailable';
export type LicenseNoticeIdentity = 'checking' | 'unavailable' | `grace:${string}` | null;

export interface AccessPresentation {
  disabled: boolean;
  showUpgrade: boolean;
  showRetry: boolean;
  reason: 'checking' | 'unentitled' | 'unavailable' | null;
}

export interface PremiumMutationPolicy {
  canEdit: boolean;
  canRemove: boolean;
}

export interface LicenseSnapshot {
  tier: 'free' | 'pro' | 'business';
  state: 'active' | 'grace' | 'expired' | 'free';
  resolution: LicenseResolution;
  graceUntil: string | null;
  features: Partial<Record<FeatureKey, boolean>>;
  limits: Record<LimitKey, EntitlementLimit>;
}

const TIERS = new Set<LicenseSnapshot['tier']>(['free', 'pro', 'business']);
const STATES = new Set<LicenseSnapshot['state']>(['active', 'grace', 'expired', 'free']);
const RESOLUTIONS = new Set<LicenseResolution>(['checking', 'resolved', 'unavailable']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLicenseSnapshot(value: unknown): LicenseSnapshot {
  if (!isObject(value)) {
    throw new Error('Invalid license snapshot');
  }

  const { tier, state, resolution, graceUntil, features, limits } = value;
  if (
    typeof tier !== 'string' ||
    !TIERS.has(tier as LicenseSnapshot['tier']) ||
    typeof state !== 'string' ||
    !STATES.has(state as LicenseSnapshot['state']) ||
    typeof resolution !== 'string' ||
    !RESOLUTIONS.has(resolution as LicenseResolution) ||
    (typeof graceUntil !== 'string' && graceUntil !== null) ||
    !isObject(features) ||
    Object.values(features).some((enabled) => typeof enabled !== 'boolean') ||
    !isObject(limits) ||
    (typeof limits.telegramConnections !== 'number' && limits.telegramConnections !== 'unlimited')
  ) {
    throw new Error('Invalid license snapshot');
  }

  return {
    tier: tier as LicenseSnapshot['tier'],
    state: state as LicenseSnapshot['state'],
    resolution: resolution as LicenseResolution,
    graceUntil: graceUntil as string | null,
    features: { ...features } as Partial<Record<FeatureKey, boolean>>,
    limits: { telegramConnections: limits.telegramConnections as EntitlementLimit },
  };
}

export function featureAccess(
  snapshot: LicenseSnapshot | null,
  feature: FeatureKey
): FeatureAccess {
  if (FEATURE_TIER[feature] === 'free') return 'entitled';
  if (!snapshot || snapshot.resolution === 'checking') return 'checking';
  if (snapshot.resolution === 'unavailable') return 'unavailable';
  return snapshot.features[feature] === true ? 'entitled' : 'unentitled';
}

export function resolveFeatureAccess(
  contextAccess: FeatureAccess,
  access?: FeatureAccess,
  can?: boolean
): FeatureAccess {
  if (access !== undefined) return access;
  if (can === undefined) return contextAccess;
  if (contextAccess === 'checking' || contextAccess === 'unavailable') return contextAccess;
  return can ? 'entitled' : 'unentitled';
}

export function licenseNoticeIdentity(
  resolution: LicenseResolution,
  state: LicenseSnapshot['state'],
  graceUntil: string | null
): LicenseNoticeIdentity {
  if (resolution === 'checking') return 'checking';
  if (resolution === 'unavailable') return 'unavailable';
  if (state === 'grace') return `grace:${graceUntil ?? 'missing'}`;
  return null;
}

export function reconcileDismissedNotice(
  dismissedIdentity: LicenseNoticeIdentity,
  currentIdentity: LicenseNoticeIdentity
): LicenseNoticeIdentity {
  return dismissedIdentity === currentIdentity ? dismissedIdentity : null;
}

export function accessPresentation(access: FeatureAccess): AccessPresentation {
  return {
    disabled: access !== 'entitled',
    showUpgrade: access === 'unentitled',
    showRetry: access === 'unavailable',
    reason: access === 'entitled' ? null : access,
  };
}

/**
 * Premium authoring fails closed while access is unresolved. A confirmed
 * entitlement lapse still permits monotonic cleanup so administrators are not
 * forced to retain configuration they can no longer edit.
 */
export function premiumMutationPolicy(access: FeatureAccess): PremiumMutationPolicy {
  return {
    canEdit: access === 'entitled',
    canRemove: access === 'entitled' || access === 'unentitled',
  };
}

/** Keep confirmed access stable while a replacement snapshot is being fetched. */
export function refreshStartResolution(current: LicenseResolution): LicenseResolution {
  return current === 'resolved' ? 'resolved' : 'checking';
}

/** Retain last-known confirmed access when only its replacement request fails. */
export function refreshFailureResolution(current: LicenseResolution): LicenseResolution {
  return current === 'resolved' ? 'resolved' : 'unavailable';
}

export function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 1000);
}
