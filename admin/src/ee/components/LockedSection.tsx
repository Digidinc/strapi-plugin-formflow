/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import * as React from 'react';
import { Box } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { type FeatureKey } from '../feature-map';
import { accessPresentation, type FeatureAccess } from '../license-state';
import { LicenseStatusNotice } from './LicenseStatusNotice';
import { UpsellCard } from './UpsellCard';

export type LockedSectionChild = (state: {
  access: FeatureAccess;
  disabled: boolean;
}) => React.ReactNode;

export interface LockedSectionProps {
  /** State-aware access. New callers should prefer this over the legacy `can` prop. */
  access?: FeatureAccess;
  /** Temporary boolean compatibility for callers awaiting the Task 10 migration. */
  can?: boolean;
  /** readonly: children rendered but all interactive controls disabled.
   *  replace: children replaced entirely with <UpsellCard>. */
  mode?: 'readonly' | 'replace';
  /** Forwarded to UpsellCard when mode="replace". */
  feature: FeatureKey;
  /** Optional description forwarded to UpsellCard. */
  description?: string;
  children: React.ReactNode | LockedSectionChild;
}

/**
 * Gates a section of the admin UI from explicit access, with temporary boolean
 * compatibility for callers that have not migrated yet.
 *
 * - entitled: renders children untouched.
 * - checking/unavailable + replace: renders state-specific status UI.
 * - unentitled + replace (default): swaps in an <UpsellCard>.
 * - locked + readonly: renders children but blocks interaction (pointer-events
 *   off, dimmed) so existing form-state values are preserved.
 *
 * Missing access degrades to the locked state, never an error.
 */
export const LockedSection = ({
  access,
  can,
  mode = 'replace',
  feature,
  description,
  children,
}: LockedSectionProps) => {
  const { formatMessage } = useIntl();
  const resolvedAccess = access ?? (can === true ? 'entitled' : 'unentitled');
  const presentation = accessPresentation(resolvedAccess);
  const renderedChildren =
    typeof children === 'function'
      ? children({ access: resolvedAccess, disabled: presentation.disabled })
      : children;

  if (resolvedAccess === 'entitled') {
    return <>{renderedChildren}</>;
  }

  if (mode === 'readonly') {
    // TODO(Task 10): Remove pointer blocking once every caller passes real
    // disabled/readOnly state through the render-function child contract.
    return (
      <Box style={{ pointerEvents: 'none', opacity: 0.6 }} aria-disabled>
        {renderedChildren}
      </Box>
    );
  }

  if (resolvedAccess === 'checking') {
    return (
      <Box padding={4} role="status">
        {formatMessage({
          id: 'formflow.license.checking',
          defaultMessage: 'Checking FormFlow license…',
        })}
      </Box>
    );
  }

  if (resolvedAccess === 'unavailable') {
    return <LicenseStatusNotice compact />;
  }

  return <UpsellCard access={access} feature={feature} description={description} />;
};
