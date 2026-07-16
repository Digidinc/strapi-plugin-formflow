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

const CHECKING_NOTICE_DELAY_MS = 300;

export interface LicenseStatusNoticeProps {
  compact?: boolean;
}

export const LicenseStatusNotice = ({ compact = false }: LicenseStatusNoticeProps) => {
  const { formatDate, formatMessage } = useIntl();
  const { resolution, state: licenseState, graceUntil, isRefreshing, refresh } = useLicense();
  const [showChecking, setShowChecking] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState<LicenseNoticeIdentity>(null);
  const currentState = licenseState();
  const deadline = graceUntil();
  const noticeIdentity = licenseNoticeIdentity(resolution, currentState, deadline);

  useEffect(() => {
    if (resolution !== 'checking') {
      setShowChecking(false);
      return;
    }

    const timeoutId = window.setTimeout(() => setShowChecking(true), CHECKING_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [resolution]);

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
  if (compact && resolution === 'checking') {
    if (!showChecking) return null;
    return (
      <Box>
        <Typography variant="pi" textColor="neutral600">
          {formatMessage({
            id: 'formflow.license.checking',
            defaultMessage: 'Checking FormFlow license…',
          })}
        </Typography>
      </Box>
    );
  }

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

  if (resolution === 'checking') {
    if (!showChecking) return null;

    return (
      <Alert
        closeLabel={closeLabel}
        onClose={handleClose}
        padding={compact ? 3 : 4}
        marginBottom={compact ? 0 : 4}
        variant="default"
      >
        {formatMessage({
          id: 'formflow.license.checking',
          defaultMessage: 'Checking FormFlow license…',
        })}
      </Alert>
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
