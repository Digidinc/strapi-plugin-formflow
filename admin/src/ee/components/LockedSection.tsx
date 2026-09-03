/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import * as React from 'react';
import { Box } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { FEATURE_TIER, type FeatureKey } from '../feature-map';
import { accessPresentation, type FeatureAccess } from '../license-state';
import { LicenseStatusNotice } from './LicenseStatusNotice';
import { UpsellCard } from './UpsellCard';

export type LockedSectionChild = (state: {
  access: FeatureAccess;
  disabled: boolean;
}) => React.ReactNode;

interface LockedSectionBaseProps {
  /** Explicit state-aware access for the gated feature. */
  access: FeatureAccess;
  /** readonly: children rendered but all interactive controls disabled.
   *  replace: children replaced entirely with <UpsellCard>. */
  /** Forwarded to UpsellCard when mode="replace". */
  feature: FeatureKey;
  /** Optional description forwarded to UpsellCard. */
  description?: string;
}

export type LockedSectionProps = LockedSectionBaseProps &
  (
    | { mode: 'readonly'; children: LockedSectionChild }
    | { mode?: 'replace'; children: React.ReactNode }
  );

/**
 * Gates a section of the admin UI from explicit feature access.
 *
 * - entitled: renders children untouched.
 * - checking/unavailable + replace: renders state-specific status UI.
 * - unentitled + replace (default): swaps in an <UpsellCard>.
 * - locked + readonly: renders dimmed children whose controls receive real
 *   disabled/readOnly state through the render-function contract.
 */
export const LockedSection = ({
  access,
  mode = 'replace',
  feature,
  description,
  children,
}: LockedSectionProps) => {
  const { formatMessage } = useIntl();
  const presentation = accessPresentation(access);
  const renderedChildren =
    typeof children === 'function'
      ? children({ access, disabled: presentation.disabled })
      : children;
  const requiredTier = FEATURE_TIER[feature] === 'business' ? 'Business' : 'Pro';
  const lockedReason =
    access === 'checking'
      ? formatMessage({
          id: 'formflow.license.checking',
          defaultMessage: 'FormFlow is still verifying your license. Try again in a moment.',
        })
      : access === 'unavailable'
        ? formatMessage({
            id: 'formflow.license.unavailable',
            defaultMessage:
              'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
          })
        : formatMessage(
            {
              id: 'formflow.license.upgradeRequired',
              defaultMessage: 'This feature requires a {tier} plan.',
            },
            { tier: requiredTier }
          );

  if (access === 'entitled') {
    return <>{renderedChildren}</>;
  }

  if (mode === 'readonly') {
    return (
      <Box style={{ opacity: 0.6 }} role="group" aria-label={lockedReason} aria-disabled>
        {renderedChildren}
      </Box>
    );
  }

  // An unresolved check presents like `readonly`: disabled, and silent. It must
  // not fall through to the upsell, which would mis-sell an entitled customer.
  if (access === 'checking') {
    return (
      <Box style={{ opacity: 0.6 }} role="group" aria-label={lockedReason} aria-disabled>
        {renderedChildren}
      </Box>
    );
  }

  if (access === 'unavailable') {
    return <LicenseStatusNotice compact />;
  }

  return <UpsellCard access={access} feature={feature} description={description} />;
};
