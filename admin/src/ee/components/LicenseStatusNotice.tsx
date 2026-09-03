/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Typography } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { useLicense } from '../hooks/useLicense';
import {
  licenseNoticeIdentity,
  reconcileDismissedNotice,
  type LicenseNoticeIdentity,
} from '../license-state';

export interface LicenseStatusNoticeProps {
  compact?: boolean;
}

export const LicenseStatusNotice = ({ compact = false }: LicenseStatusNoticeProps) => {
  const { formatDate, formatMessage } = useIntl();
  const { resolution, state: licenseState, graceUntil, isRefreshing, refresh } = useLicense();
  const [dismissedNotice, setDismissedNotice] = useState<LicenseNoticeIdentity>(null);
  const currentState = licenseState();
  const deadline = graceUntil();
  const noticeIdentity = licenseNoticeIdentity(resolution, currentState, deadline);

  useEffect(() => {
    setDismissedNotice((current) => reconcileDismissedNotice(current, noticeIdentity));
  }, [noticeIdentity]);

  const closeLabel = formatMessage({
    id: 'formflow.common.close',
    defaultMessage: 'Close',
  });
  const handleClose = () => setDismissedNotice(noticeIdentity);

  if (noticeIdentity === null || dismissedNotice === noticeIdentity) return null;

  // The plugin shell owns the single live alert and Retry action. Compact
  // instances only provide adjacent, readable context for a locked section.
  // Neither surfaces `checking`: it is silent, so `licenseNoticeIdentity`
  // already returned null above and nothing below is reached while it runs.
  if (compact && resolution === 'unavailable') {
    return (
      <Box>
        <Typography variant="pi" textColor="neutral600">
          {formatMessage({
            id: 'formflow.license.unavailable',
            defaultMessage:
              'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
          })}
        </Typography>
      </Box>
    );
  }

  if (resolution === 'unavailable') {
    return (
      <Alert
        action={
          <Button
            type="button"
            size="S"
            variant="secondary"
            loading={isRefreshing}
            onClick={() => void refresh()}
          >
            {formatMessage({
              id: 'formflow.license.retry',
              defaultMessage: 'Retry license verification',
            })}
          </Button>
        }
        closeLabel={closeLabel}
        onClose={handleClose}
        padding={compact ? 3 : 4}
        marginBottom={compact ? 0 : 4}
        variant="warning"
      >
        {formatMessage({
          id: 'formflow.license.unavailable',
          defaultMessage:
            'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
        })}
      </Alert>
    );
  }

  if (currentState === 'grace') {
    const timestamp = deadline === null ? Number.NaN : Date.parse(deadline);

    if (Number.isFinite(timestamp)) {
      return (
        <Alert
          closeLabel={closeLabel}
          onClose={handleClose}
          padding={compact ? 3 : 4}
          marginBottom={compact ? 0 : 4}
          variant="warning"
        >
          {formatMessage(
            {
              id: 'formflow.license.grace',
              defaultMessage: 'FormFlow is using cached license access until {date}.',
            },
            {
              date: formatDate(timestamp, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }),
            }
          )}
        </Alert>
      );
    }
  }

  return null;
};
