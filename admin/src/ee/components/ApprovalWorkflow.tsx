/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useState, type ChangeEvent } from 'react';
import {
  Box,
  Flex,
  Typography,
  Badge,
  Field,
  SingleSelect,
  SingleSelectOption,
  Textarea,
  Button,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { API, APPROVAL_STATUSES, type ApprovalStatus } from '../../utils/api';
import { getTranslation } from '../../utils/getTranslation';
import { useLicense } from '../hooks/useLicense';
import { refreshLicenseOnPaymentRequired } from '../payment-required';
import { LicenseStatusNotice } from './LicenseStatusNotice';
import { UpsellCard } from './UpsellCard';

export interface ApprovalWorkflowProps {
  /** Submission documentId the approval decision applies to. */
  submissionId: string;
  /** Current approval status (defaults to `pending` when absent). */
  approvalStatus?: ApprovalStatus;
  /** Current approval note (pre-fills the textarea). */
  approvalNote?: string;
  /** Called after a successful save so the parent can refetch the submission. */
  onUpdated?: () => void;
}

/** Badge variant for each approval status. */
const STATUS_VARIANTS: Record<ApprovalStatus, 'secondary' | 'success' | 'danger'> = {
  pending: 'secondary',
  approved: 'success',
  rejected: 'danger',
};

/**
 * Approval workflow panel (Business feature) for a single submission.
 *
 * Unresolved verification renders a neutral status notice, while a confirmed
 * unentitled plan renders the upgrade card. Fetch and mutation hooks live only
 * in the entitled child so no premium request can originate from a locked
 * branch. The server remains the authoritative gate (402 on the endpoint).
 */
const ApprovalWorkflow = (props: ApprovalWorkflowProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const approvalAccess = access('approval');

  switch (approvalAccess) {
    case 'checking':
      return <LicenseStatusNotice compact />;
    case 'unavailable':
      return <LicenseStatusNotice compact />;
    case 'unentitled':
      return (
        <UpsellCard
          access={approvalAccess}
          feature="approval"
          description={formatMessage({
            id: getTranslation('approval.upsell'),
            defaultMessage: 'Approval workflows require a Business license',
          })}
        />
      );
    case 'entitled':
      return <EntitledApprovalWorkflow {...props} />;
  }
};

const EntitledApprovalWorkflow = ({
  submissionId,
  approvalStatus = 'pending',
  approvalNote = '',
  onUpdated,
}: ApprovalWorkflowProps) => {
  const { formatMessage } = useIntl();
  const { put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { refresh } = useLicense();

  const [status, setStatus] = useState<ApprovalStatus>(approvalStatus);
  const [note, setNote] = useState<string>(approvalNote);
  const [isSaving, setIsSaving] = useState(false);

  const title = formatMessage({
    id: getTranslation('approval.title'),
    defaultMessage: 'Approval',
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await put(API.approveSubmission(submissionId), {
        approvalStatus: status,
        approvalNote: note,
      });
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('submission.status.updated'),
          defaultMessage: 'Status updated successfully',
        }),
      });
      onUpdated?.();
    } catch (error) {
      if (await refreshLicenseOnPaymentRequired(error, refresh)) {
        return;
      }

      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('common.error'),
          defaultMessage: 'Something went wrong',
        }),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
      <Flex justifyContent="space-between" alignItems="center">
        <Typography variant="delta" fontWeight="bold" tag="h2">
          {title}
        </Typography>
        <Badge variant={STATUS_VARIANTS[approvalStatus]}>
          {formatMessage({
            id: getTranslation(`approval.status.${approvalStatus}`),
            defaultMessage: approvalStatus,
          })}
        </Badge>
      </Flex>

      <Box marginTop={3}>
        <Field.Root name="approvalStatus">
          <Field.Label>
            {formatMessage({
              id: getTranslation('approval.title'),
              defaultMessage: 'Approval',
            })}
          </Field.Label>
          <SingleSelect
            value={status}
            onChange={(value: string | number) => setStatus(value as ApprovalStatus)}
            disabled={isSaving}
          >
            {APPROVAL_STATUSES.map((value) => (
              <SingleSelectOption key={value} value={value}>
                {formatMessage({
                  id: getTranslation(`approval.status.${value}`),
                  defaultMessage: value,
                })}
              </SingleSelectOption>
            ))}
          </SingleSelect>
        </Field.Root>
      </Box>

      <Box marginTop={3}>
        <Field.Root name="approvalNote">
          <Field.Label>
            {formatMessage({
              id: getTranslation('approval.note.label'),
              defaultMessage: 'Approval note',
            })}
          </Field.Label>
          <Textarea
            value={note}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setNote(event.target.value)}
            placeholder={formatMessage({
              id: getTranslation('approval.note.placeholder'),
              defaultMessage: 'Optional note for this decision',
            })}
            disabled={isSaving}
          />
        </Field.Root>
      </Box>

      <Box marginTop={4}>
        <Button onClick={handleSave} loading={isSaving} disabled={isSaving}>
          {formatMessage({
            id: getTranslation('approval.save'),
            defaultMessage: 'Save decision',
          })}
        </Button>
      </Box>
    </Box>
  );
};

export default ApprovalWorkflow;
