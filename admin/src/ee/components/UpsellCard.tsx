/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { Box, Flex, Typography, LinkButton } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { FEATURE_TIER, type FeatureKey } from '../feature-map';
import { useLicense } from '../hooks/useLicense';
import { accessPresentation, type FeatureAccess } from '../license-state';
import { ProBadge } from './ProBadge';

/** Single upsell destination — imported by every Phase 1+ gating point. */
export const PURCHASE_URL = 'https://hrahimi270.github.io/formflow/#pricing';

export interface UpsellCardProps {
  /** Optional explicit access state; otherwise resolved from the license context. */
  access?: FeatureAccess;
  /** Feature key whose tier label is shown (e.g. "Pro feature"). */
  feature: FeatureKey;
  /** Short one-line description shown under the tier label. */
  description?: string;
}

/**
 * Replacement body for a fully-locked panel. It renders only for confirmed
 * unentitled access, then shows the required tier, optional description and a
 * link to the purchase page.
 */
export const UpsellCard = ({ access, feature, description }: UpsellCardProps) => {
  const { formatMessage } = useIntl();
  const { access: resolveAccess } = useLicense();
  const resolvedAccess = access ?? resolveAccess(feature);

  if (!accessPresentation(resolvedAccess).showUpgrade) {
    return null;
  }

  const requiredTier = FEATURE_TIER[feature] === 'business' ? 'Business' : 'Pro';

  return (
    <Box background="neutral0" hasRadius borderColor="neutral200" padding={6} shadow="tableShadow">
      <Flex direction="column" alignItems="center" gap={3} textAlign="center">
        <ProBadge feature={feature} />
        <Typography variant="delta" fontWeight="bold">
          {formatMessage(
            {
              id: 'formflow.license.upgradeRequired',
              defaultMessage: 'This feature requires a {tier} plan.',
            },
            { tier: requiredTier }
          )}
        </Typography>
        {description ? (
          <Typography variant="omega" textColor="neutral600">
            {description}
          </Typography>
        ) : null}
        <LinkButton href={PURCHASE_URL} target="_blank" rel="noopener noreferrer">
          View plans
        </LinkButton>
      </Flex>
    </Box>
  );
};
