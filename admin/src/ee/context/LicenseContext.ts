/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { createContext } from 'react';

import type { FeatureKey } from '../feature-map';
import type { FeatureAccess, LicenseResolution, LicenseSnapshot } from '../license-state';

/**
 * Shape exposed to consumers via {@link useLicense}. The accessors are functions
 * (not bare values) so a consumer that only needs `tier()` does not re-derive
 * the entitlement map on every render.
 */
export interface LicenseContextValue {
  access: (feature: FeatureKey) => FeatureAccess;
  can: (feature: FeatureKey) => boolean;
  tier: () => LicenseSnapshot['tier'];
  state: () => LicenseSnapshot['state'];
  resolution: LicenseResolution;
  graceUntil: () => string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * The default value is an unresolved sentinel. It never over-grants, but it
 * keeps unknown access distinct from a verified free plan until the provider
 * resolves.
 */
export const LicenseContext = createContext<LicenseContextValue>({
  access: () => 'checking',
  can: () => false,
  tier: () => 'free',
  state: () => 'free',
  resolution: 'checking',
  graceUntil: () => null,
  isLoading: true,
  isRefreshing: false,
  error: null,
  refresh: async () => undefined,
});
// DCE-guard: side-effect assignment keeps the sentinel string '__EE_ADMIN__' in
// the bundled runtime JS so check-ee-bundled.mjs can verify it survived bundling.
LicenseContext.displayName = '__EE_ADMIN__';
