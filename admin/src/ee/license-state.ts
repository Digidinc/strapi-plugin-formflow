/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { FEATURE_TIER, type FeatureKey } from './feature-map';

export type LicenseResolution = 'checking' | 'resolved' | 'unavailable';
export type FeatureAccess = 'checking' | 'entitled' | 'unentitled' | 'unavailable';

export interface LicenseSnapshot {
  tier: 'free' | 'pro' | 'business';
  state: 'active' | 'grace' | 'expired' | 'free';
  resolution: LicenseResolution;
  graceUntil: string | null;
  features: Partial<Record<FeatureKey, boolean>>;
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

  const { tier, state, resolution, graceUntil, features } = value;
  if (
    typeof tier !== 'string' ||
    !TIERS.has(tier as LicenseSnapshot['tier']) ||
    typeof state !== 'string' ||
    !STATES.has(state as LicenseSnapshot['state']) ||
    typeof resolution !== 'string' ||
    !RESOLUTIONS.has(resolution as LicenseResolution) ||
    (typeof graceUntil !== 'string' && graceUntil !== null) ||
    !isObject(features) ||
    Object.values(features).some((enabled) => typeof enabled !== 'boolean')
  ) {
    throw new Error('Invalid license snapshot');
  }

  return {
    tier: tier as LicenseSnapshot['tier'],
    state: state as LicenseSnapshot['state'],
    resolution: resolution as LicenseResolution,
    graceUntil: graceUntil as string | null,
    features: { ...features } as Partial<Record<FeatureKey, boolean>>,
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

export function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 1000);
}
