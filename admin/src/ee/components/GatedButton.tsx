/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import * as React from 'react';
import { Button, Tooltip } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { FEATURE_TIER, type FeatureKey } from '../feature-map';
import { accessPresentation, type FeatureAccess } from '../license-state';

export interface GatedButtonProps {
  /** Explicit state-aware access for the gated feature. */
  access: FeatureAccess;
  /** Tooltip text shown when locked. Defaults to "Upgrade to unlock". */
  lockedTooltip?: string;
  /** Feature key used to resolve the required tier. */
  feature: FeatureKey;
  /** Forwarded to the DS Button when entitled. */
  onClick?: () => void;
  children: React.ReactNode;
  /** Any extra Button props (variant, size, startIcon, etc.). */
  [key: string]: unknown;
}

/**
 * A DS Button gated by state-aware license access.
 *
 * - entitled: a normal enabled button forwarding `onClick` and extra props.
 * - locked: a disabled button inside a focusable tooltip wrapper. The wrapper
 *   explains why access is disabled without relying on disabled-button clicks.
 */
export const GatedButton = ({
  access,
  lockedTooltip,
  feature,
  onClick,
  children,
  ...rest
}: GatedButtonProps) => {
  const { formatMessage } = useIntl();
  const presentation = accessPresentation(access);

  if (!presentation.disabled) {
    return (
      <Button onClick={onClick} {...rest}>
        {children}
      </Button>
    );
  }

  const requiredTier = FEATURE_TIER[feature] === 'business' ? 'Business' : 'Pro';
  const tooltipLabel =
    presentation.reason === 'checking'
      ? formatMessage({
          id: 'formflow.license.checking',
          defaultMessage: 'FormFlow is still verifying your license. Try again in a moment.',
        })
      : presentation.reason === 'unavailable'
        ? formatMessage({
            id: 'formflow.license.unavailable',
            defaultMessage:
              'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
          })
        : (lockedTooltip ??
          formatMessage(
            {
              id: 'formflow.license.upgradeRequired',
              defaultMessage: 'This feature requires a {tier} plan.',
            },
            { tier: requiredTier }
          ));

  return (
    <Tooltip label={tooltipLabel}>
      <span
        role="group"
        tabIndex={0}
        aria-disabled="true"
        aria-label={tooltipLabel}
        style={{ display: 'inline-flex' }}
      >
        <Button {...rest} disabled>
          {children}
        </Button>
      </span>
    </Tooltip>
  );
};
