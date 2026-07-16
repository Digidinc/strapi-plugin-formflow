import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useIntl } from 'react-intl';
import {
  Box,
  Flex,
  Typography,
  Button,
  IconButton,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Checkbox,
  SingleSelect,
  SingleSelectOption,
  Dialog,
  EmptyStateLayout,
  Menu,
  Field,
  Switch,
  TextInput,
  VisuallyHidden,
} from '@strapi/design-system';
import {
  Trash,
  Download,
  Eye,
  CheckCircle,
  Archive,
  CaretDown,
  WarningCircle,
  ChartCircle,
} from '@strapi/icons';
import { EmptyDocuments } from '@strapi/icons/symbols';
import {
  Page,
  Layouts,
  BackButton,
  Pagination,
  ConfirmDialog,
  useNotification,
  useQueryParams,
  useRBAC,
} from '@strapi/strapi/admin';

import { useSubmissions } from '../hooks/useSubmissions';
import { useForm } from '../hooks/useForm';
import { PLUGIN_ID } from '../pluginId';
import { getTranslation } from '../utils/getTranslation';
import { SUBMISSION_PERMISSIONS } from '../permissions';
import { StatusBadge } from '../components/shared/StatusBadge';
import { SubmissionStatus, ExportFormat, FormField, ScheduledExportConfig } from '../utils/api';
import { useLicense } from '../ee/hooks/useLicense';
import { GatedButton } from '../ee/components/GatedButton';
import { LicenseStatusNotice } from '../ee/components/LicenseStatusNotice';
import { ProBadge } from '../ee/components/ProBadge';
import { premiumMutationPolicy } from '../ee/license-state';
import { refreshLicenseOnPaymentRequired } from '../ee/payment-required';

/**
 * Status options for the filter dropdown.
 */
const STATUS_OPTIONS: Array<{ value: SubmissionStatus; labelId: string; defaultLabel: string }> = [
  { value: 'new', labelId: getTranslation('status.new'), defaultLabel: 'New' },
  { value: 'read', labelId: getTranslation('status.read'), defaultLabel: 'Read' },
  { value: 'processed', labelId: getTranslation('status.processed'), defaultLabel: 'Processed' },
  { value: 'archived', labelId: getTranslation('status.archived'), defaultLabel: 'Archived' },
  { value: 'spam', labelId: getTranslation('status.spam'), defaultLabel: 'Spam' },
];

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_SCHEDULE_CRON = '0 8 * * 1';
const DEFAULT_SCHEDULE_FORMAT = 'xlsx' as const;

/**
 * Sentinel value for the explicit "All" option in the status filter. Selecting
 * it clears the status filter (SingleSelectOption cannot use an empty `value`,
 * which the component reserves for its unselected/placeholder state).
 */
const ALL_STATUS_VALUE = 'all';

const DisabledAdvancedExportItems = ({
  showUpgradeTier = false,
  includeSchedule = true,
}: {
  showUpgradeTier?: boolean;
  includeSchedule?: boolean;
}) => {
  const { formatMessage } = useIntl();
  const items = [
    {
      id: getTranslation('submissions.export.xlsx'),
      defaultMessage: 'Export as Excel (.xlsx)',
    },
    { id: getTranslation('submissions.export.pdf'), defaultMessage: 'Export as PDF' },
    ...(includeSchedule
      ? [
          {
            id: getTranslation('submissions.export.schedule'),
            defaultMessage: 'Schedule export…',
          },
        ]
      : []),
  ];

  return (
    <>
      {items.map((item) => (
        <Menu.Item key={item.id} disabled>
          <Flex gap={2} alignItems="center">
            {formatMessage(item)}
            {showUpgradeTier ? <ProBadge tier="pro" /> : null}
          </Flex>
        </Menu.Item>
      ))}
    </>
  );
};

/**
 * Format a date string for display.
 */
const formatDate = (dateStr: string): string => {
  try {
    return new Date(dateStr).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
};

/**
 * Get a short preview of submission data (first 2 non-empty fields).
 *
 * Each data key is the field `name`; resolve it to the field's human-readable
 * `label` via the form's field definitions, falling back to the raw key when no
 * matching field is found (e.g. legacy data or a field removed from the form).
 */
/**
 * Render a stored value to a short preview string. File-field values are media
 * references ({ url, name, ... }) or arrays of them — show the file name(s)
 * rather than a raw JSON blob.
 */
const previewValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(previewValue).join(', ');
  }
  if (value && typeof value === 'object') {
    const ref = value as { name?: unknown; url?: unknown };
    if (typeof ref.name === 'string') return ref.name;
    if (typeof ref.url === 'string') return ref.url;
    return JSON.stringify(value);
  }
  return String(value);
};

const getPreview = (data: Record<string, unknown>, fields?: FormField[]): string => {
  const labelByName = new Map((fields ?? []).map((f) => [f.name, f.label]));

  const entries = Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 2);

  if (entries.length === 0) {
    return '—';
  }

  return entries
    .map(([key, value]) => {
      const label = labelByName.get(key) || key;
      const strValue = previewValue(value);
      const truncated = strValue.length > 30 ? `${strValue.slice(0, 30)}...` : strValue;
      return `${label}: ${truncated}`;
    })
    .join(' | ');
};

interface SubmissionsQuery {
  page?: string;
  pageSize?: string;
  status?: SubmissionStatus;
}

export const SubmissionsListPage = () => {
  const { formId } = useParams<{ formId: string }>();

  // The URL query is the source of truth for page / pageSize / status so the
  // view survives a refresh and the native <Pagination> can drive it directly.
  const [{ query }, setQuery] = useQueryParams<SubmissionsQuery>();
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || DEFAULT_PAGE_SIZE;
  const status = query.status;

  const { form, isLoading: isLoadingForm } = useForm(formId);

  // `useSubmissions` keeps its own query state internally and only reads
  // `initialQueryParams` on mount, so we remount its consumer whenever the
  // page size or status (the params it has no public setter for) change by
  // keying <SubmissionsView>. Page changes — the frequent case — are pushed
  // through the hook's `setPage` without a remount.
  return (
    <SubmissionsView
      key={`${pageSize}-${status ?? 'all'}`}
      formId={formId!}
      page={page}
      pageSize={pageSize}
      status={status}
      form={form}
      isLoadingForm={isLoadingForm}
      setQuery={setQuery}
    />
  );
};

interface SubmissionsViewProps {
  formId: string;
  page: number;
  pageSize: number;
  status?: SubmissionStatus;
  form: ReturnType<typeof useForm>['form'];
  isLoadingForm: boolean;
  setQuery: (params: SubmissionsQuery) => void;
}

const SubmissionsView = ({
  formId,
  page,
  pageSize,
  status,
  form,
  isLoadingForm,
  setQuery,
}: SubmissionsViewProps) => {
  const navigate = useNavigate();
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();

  // Premium access stays distinct from RBAC: unresolved verification disables
  // only premium actions, while free inbox and CSV/JSON export remain usable.
  const { access, refresh } = useLicense();
  const analyticsAccess = access('analytics');
  const advancedExportAccess = access('export.advanced');
  const advancedExportPolicy = premiumMutationPolicy(advancedExportAccess);

  // Gate submission write/export actions. Super-admins pass all checks.
  const {
    allowedActions: { canUpdate, canDelete, canExport },
  } = useRBAC(SUBMISSION_PERMISSIONS);

  const {
    submissions,
    pagination,
    isLoading,
    isDeleting,
    isUpdating,
    isExporting,
    error,
    setPage,
    deleteSubmission,
    bulkDelete,
    bulkUpdateStatus,
    exportSubmissions,
    getScheduledExport,
    saveScheduledExport,
    removeScheduledExport,
  } = useSubmissions(formId, { page, pageSize, status });

  // Page changes flow through the URL; push them into the hook (no remount).
  // The hook already fetches the initial `page` from `initialQueryParams` on
  // mount, so skip the first run of this effect — otherwise it would call
  // `setPage(page)` with the same value, mutate the hook's query state, and
  // fire a redundant second fetch on every list load (and remount). Only
  // subsequent `page` changes (pagination clicks / URL edits) push through.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setPage(page);
  }, [page, setPage]);

  // Guard against an out-of-range page: increasing the page size (or a direct
  // URL edit) can leave `page` beyond the available `pageCount`, which would
  // request an empty page. Clamp the URL back to the last valid page so the
  // view always shows data. Only act once a real page count is known and there
  // is at least one page of results.
  useEffect(() => {
    const pageCount = pagination?.pageCount;
    if (pageCount && pageCount >= 1 && page > pageCount) {
      setQuery({ page: String(pageCount) });
    }
  }, [page, pagination?.pageCount, setQuery]);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Delete dialog state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // IP inclusion for export
  const [includeIp, setIncludeIp] = useState(false);

  // Scheduled export (Pro). `scheduledConfig` is the saved schedule (or null);
  // the dialog fields are local until saved.
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduledConfig, setScheduledConfig] = useState<ScheduledExportConfig | null>(null);
  const [scheduleCron, setScheduleCron] = useState(DEFAULT_SCHEDULE_CRON);
  const [scheduleEmails, setScheduleEmails] = useState('');
  const [scheduleFormat, setScheduleFormat] = useState<'xlsx' | 'pdf' | 'csv'>(
    DEFAULT_SCHEDULE_FORMAT
  );
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);

  // Resolved access may read a saved schedule: unentitled administrators need
  // to discover and remove existing configuration. Unknown access remains
  // fail-closed and clears every draft so stale premium state cannot reappear.
  useEffect(() => {
    if (!advancedExportPolicy.canEdit && !advancedExportPolicy.canRemove) {
      setScheduleDialogOpen(false);
      setScheduledConfig(null);
      setScheduleCron(DEFAULT_SCHEDULE_CRON);
      setScheduleEmails('');
      setScheduleFormat('xlsx');
      return;
    }

    if (!advancedExportPolicy.canEdit) {
      setScheduleDialogOpen(false);
    }

    let cancelled = false;
    getScheduledExport()
      .then((config) => {
        if (!cancelled) {
          setScheduledConfig(config);
        }
      })
      .catch(async (error: unknown) => {
        if (cancelled) return;
        await refreshLicenseOnPaymentRequired(error, refresh);
      });
    return () => {
      cancelled = true;
    };
  }, [
    advancedExportAccess,
    advancedExportPolicy.canEdit,
    advancedExportPolicy.canRemove,
    getScheduledExport,
    refresh,
  ]);

  const tabTitle = formatMessage({
    id: getTranslation('submissions.title'),
    defaultMessage: 'Submissions',
  });

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const toggleAll = (selected: boolean | 'indeterminate') => {
    setSelectedIds(selected === true ? submissions.map((s) => s.documentId) : []);
  };

  /**
   * After deleting `removedIds`, if the current page is now empty and we are
   * not on the first page, step the URL back one page so the user is not left
   * on a stranded empty page. The URL is the source of truth, so we update it
   * directly rather than fighting the hook's own page reconciliation.
   */
  const stepBackIfPageEmptied = (removedIds: string[]) => {
    const removed = new Set(removedIds);
    const remaining = submissions.filter((s) => !removed.has(s.documentId)).length;
    if (remaining === 0 && page > 1) {
      setQuery({ page: String(page - 1) });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingId) {
      return;
    }
    const idToDelete = deletingId;
    try {
      await deleteSubmission(idToDelete);
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('submissions.delete.success'),
          defaultMessage: 'Submission deleted successfully',
        }),
      });
      setSelectedIds((prev) => prev.filter((id) => id !== idToDelete));
      stepBackIfPageEmptied([idToDelete]);
    } catch {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.delete.error'),
          defaultMessage: 'Failed to delete submission',
        }),
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDeleteConfirm = async () => {
    if (selectedIds.length === 0) {
      return;
    }
    const idsToDelete = selectedIds;
    try {
      const result = await bulkDelete(idsToDelete);
      stepBackIfPageEmptied(idsToDelete);
      toggleNotification({
        type: 'success',
        message: formatMessage(
          {
            id: getTranslation('submissions.bulkDelete.success'),
            defaultMessage: '{count} submission(s) deleted successfully',
          },
          { count: result.deleted }
        ),
      });
      setSelectedIds([]);
    } catch {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.bulkDelete.error'),
          defaultMessage: 'Failed to delete submissions',
        }),
      });
    } finally {
      setBulkDeleteOpen(false);
    }
  };

  const handleBulkStatus = async (newStatus: SubmissionStatus) => {
    if (selectedIds.length === 0) {
      return;
    }
    try {
      await bulkUpdateStatus(selectedIds, newStatus);
      toggleNotification({
        type: 'success',
        message: formatMessage(
          {
            id: getTranslation('submissions.bulkStatus.success'),
            defaultMessage: '{count} submission(s) updated',
          },
          { count: selectedIds.length }
        ),
      });
      setSelectedIds([]);
    } catch {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.bulkStatus.error'),
          defaultMessage: 'Failed to update submissions',
        }),
      });
    }
  };

  const handleExport = async (format: ExportFormat) => {
    const isAdvancedFormat = format === 'xlsx' || format === 'pdf';
    if (isAdvancedFormat && !advancedExportPolicy.canEdit) {
      return;
    }

    try {
      await exportSubmissions(format, status, { includeIp });
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('submissions.export.success'),
          defaultMessage: 'Export started',
        }),
      });
    } catch (error: unknown) {
      if (isAdvancedFormat && (await refreshLicenseOnPaymentRequired(error, refresh))) {
        return;
      }
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.export.error'),
          defaultMessage: 'Failed to export submissions',
        }),
      });
    }
  };

  const openScheduleDialog = () => {
    if (!advancedExportPolicy.canEdit && !(advancedExportPolicy.canRemove && scheduledConfig)) {
      return;
    }

    // Always seed from persisted state so a removed or changed schedule cannot
    // inherit stale draft values from a previous dialog session.
    setScheduleCron(scheduledConfig?.cronExpression ?? DEFAULT_SCHEDULE_CRON);
    setScheduleEmails(scheduledConfig?.recipientEmails.join(', ') ?? '');
    setScheduleFormat(scheduledConfig?.format ?? DEFAULT_SCHEDULE_FORMAT);
    setScheduleDialogOpen(true);
  };

  const handleSaveSchedule = async () => {
    if (!advancedExportPolicy.canEdit) {
      return;
    }

    const recipientEmails = scheduleEmails
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean);

    if (!scheduleCron.trim() || recipientEmails.length === 0) {
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.export.error'),
          defaultMessage: 'Failed to export submissions',
        }),
      });
      return;
    }

    const config: ScheduledExportConfig = {
      cronExpression: scheduleCron.trim(),
      recipientEmails,
      format: scheduleFormat,
    };

    setIsSavingSchedule(true);
    try {
      await saveScheduledExport(config);
      setScheduledConfig(config);
      setScheduleDialogOpen(false);
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('submissions.export.schedule.active'),
          defaultMessage: 'Scheduled export active',
        }),
      });
    } catch (error: unknown) {
      if (await refreshLicenseOnPaymentRequired(error, refresh)) {
        return;
      }
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.export.error'),
          defaultMessage: 'Failed to export submissions',
        }),
      });
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const handleRemoveSchedule = async () => {
    if (!advancedExportPolicy.canRemove) {
      return;
    }

    setIsSavingSchedule(true);
    try {
      await removeScheduledExport();
      setScheduledConfig(null);
      setScheduleDialogOpen(false);
      toggleNotification({
        type: 'success',
        message: formatMessage({
          id: getTranslation('submissions.export.schedule.none'),
          defaultMessage: 'No schedule configured',
        }),
      });
    } catch (error: unknown) {
      if (await refreshLicenseOnPaymentRequired(error, refresh)) {
        return;
      }
      toggleNotification({
        type: 'danger',
        message: formatMessage({
          id: getTranslation('submissions.export.error'),
          defaultMessage: 'Failed to export submissions',
        }),
      });
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const handleStatusFilterChange = (value: string | number) => {
    setSelectedIds([]);
    // `ALL_STATUS_VALUE` is the explicit "All" option (and the empty value used
    // by the SingleSelect's clear button); both clear the status filter.
    if (value && value !== ALL_STATUS_VALUE) {
      setQuery({ status: value as SubmissionStatus, page: '1' });
    } else {
      setQuery({ status: undefined, page: '1' });
    }
  };

  const handleViewSubmission = (documentId: string) => {
    navigate(`/plugins/${PLUGIN_ID}/submissions/${documentId}`);
  };

  // Analytics dashboard (Pro). The page is its own license-aware route; this is
  // the visible entry point.
  const handleViewAnalytics = () => {
    navigate(`/plugins/${PLUGIN_ID}/forms/${formId}/analytics`);
  };

  if (isLoading && submissions.length === 0) {
    return <Page.Loading />;
  }

  if (error) {
    return <Page.Error />;
  }

  const numberOfSubmissions = submissions.length;
  const isAllSelected = selectedIds.length === numberOfSubmissions && numberOfSubmissions > 0;
  const isIndeterminate = selectedIds.length > 0 && selectedIds.length < numberOfSubmissions;
  // Row selection only matters if the user can act on the selection (bulk
  // status update or bulk delete). Hide it entirely for read-only viewers.
  const canSelect = canUpdate || canDelete;
  const showLicenseStatusNotice =
    analyticsAccess === 'checking' ||
    analyticsAccess === 'unavailable' ||
    advancedExportAccess === 'checking' ||
    advancedExportAccess === 'unavailable';

  let advancedExportItems: React.ReactNode;
  switch (advancedExportAccess) {
    case 'checking':
      advancedExportItems = <DisabledAdvancedExportItems />;
      break;
    case 'unavailable':
      advancedExportItems = <DisabledAdvancedExportItems />;
      break;
    case 'unentitled':
      advancedExportItems = (
        <>
          <DisabledAdvancedExportItems showUpgradeTier includeSchedule={!scheduledConfig} />
          {scheduledConfig ? (
            <Menu.Item onSelect={openScheduleDialog}>
              <Flex gap={2} alignItems="center">
                {formatMessage({
                  id: getTranslation('submissions.export.schedule.remove'),
                  defaultMessage: 'Remove schedule',
                })}
                <ProBadge tier="pro" />
              </Flex>
            </Menu.Item>
          ) : null}
        </>
      );
      break;
    case 'entitled':
      advancedExportItems = (
        <>
          <Menu.Item onSelect={() => handleExport('xlsx')}>
            {formatMessage({
              id: getTranslation('submissions.export.xlsx'),
              defaultMessage: 'Export as Excel (.xlsx)',
            })}
          </Menu.Item>
          <Menu.Item onSelect={() => handleExport('pdf')}>
            {formatMessage({
              id: getTranslation('submissions.export.pdf'),
              defaultMessage: 'Export as PDF',
            })}
          </Menu.Item>
          <Menu.Item onSelect={openScheduleDialog}>
            {formatMessage({
              id: getTranslation('submissions.export.schedule'),
              defaultMessage: 'Schedule export…',
            })}
          </Menu.Item>
        </>
      );
      break;
  }

  return (
    <Page.Main>
      <Page.Title>{tabTitle}</Page.Title>
      <Layouts.Header
        navigationAction={<BackButton disabled={false} fallback={`/plugins/${PLUGIN_ID}`} />}
        title={tabTitle}
        subtitle={
          isLoadingForm
            ? formatMessage({ id: getTranslation('common.loading'), defaultMessage: 'Loading...' })
            : form?.title ||
              formatMessage({
                id: getTranslation('submissions.unknownForm'),
                defaultMessage: 'Unknown form',
              })
        }
        secondaryAction={
          <GatedButton
            access={analyticsAccess}
            feature="analytics"
            variant="secondary"
            startIcon={<ChartCircle />}
            onClick={handleViewAnalytics}
          >
            <Flex gap={2} alignItems="center">
              {formatMessage({
                id: getTranslation('submissions.analytics'),
                defaultMessage: 'Analytics',
              })}
              {analyticsAccess === 'unentitled' ? <ProBadge tier="pro" /> : null}
            </Flex>
          </GatedButton>
        }
        primaryAction={
          canExport ? (
            <Menu.Root>
              <Menu.Trigger
                variant="secondary"
                startIcon={<Download />}
                endIcon={<CaretDown />}
                loading={isExporting}
                disabled={numberOfSubmissions === 0}
              >
                {formatMessage({
                  id: getTranslation('submissions.export'),
                  defaultMessage: 'Export',
                })}
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item onSelect={() => handleExport('csv')}>
                  {formatMessage({
                    id: getTranslation('submissions.export.csv'),
                    defaultMessage: 'Export as CSV',
                  })}
                </Menu.Item>
                <Menu.Item onSelect={() => handleExport('json')}>
                  {formatMessage({
                    id: getTranslation('submissions.export.json'),
                    defaultMessage: 'Export as JSON',
                  })}
                </Menu.Item>
                {advancedExportItems}
              </Menu.Content>
            </Menu.Root>
          ) : null
        }
      />

      {selectedIds.length > 0 && (
        <Layouts.Action
          startActions={
            <>
              <Typography variant="epsilon" textColor="neutral600">
                {formatMessage(
                  {
                    id: getTranslation('submissions.selected'),
                    defaultMessage:
                      '{count, plural, one {# submission} other {# submissions}} selected',
                  },
                  { count: selectedIds.length }
                )}
              </Typography>
              {canUpdate && (
                <Button
                  variant="secondary"
                  startIcon={<CheckCircle />}
                  onClick={() => handleBulkStatus('read')}
                  loading={isUpdating}
                >
                  {formatMessage({
                    id: getTranslation('submissions.bulk.markRead'),
                    defaultMessage: 'Mark as read',
                  })}
                </Button>
              )}
              {canUpdate && (
                <Button
                  variant="secondary"
                  startIcon={<Archive />}
                  onClick={() => handleBulkStatus('archived')}
                  loading={isUpdating}
                >
                  {formatMessage({
                    id: getTranslation('submissions.bulk.markArchived'),
                    defaultMessage: 'Mark as archived',
                  })}
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="danger-light"
                  startIcon={<Trash />}
                  onClick={() => setBulkDeleteOpen(true)}
                  loading={isDeleting}
                >
                  {formatMessage({ id: getTranslation('common.delete'), defaultMessage: 'Delete' })}
                </Button>
              )}
            </>
          }
        />
      )}

      {selectedIds.length === 0 && (
        <Layouts.Action
          startActions={
            <Flex gap={4} alignItems="end" wrap="wrap">
              <Field.Root
                name="status-filter"
                hint={formatMessage(
                  {
                    id: getTranslation('submissions.count'),
                    defaultMessage: '{count, plural, one {# submission} other {# submissions}}',
                  },
                  { count: pagination?.total ?? 0 }
                )}
              >
                <SingleSelect
                  aria-label={formatMessage({
                    id: getTranslation('submissions.filter.status'),
                    defaultMessage: 'Filter by status',
                  })}
                  placeholder={formatMessage({
                    id: getTranslation('submissions.filter.status'),
                    defaultMessage: 'Filter by status',
                  })}
                  value={status || ''}
                  onChange={handleStatusFilterChange}
                  onClear={() => handleStatusFilterChange('')}
                  clearLabel={formatMessage({
                    id: getTranslation('submissions.clearFilter'),
                    defaultMessage: 'Clear filter',
                  })}
                >
                  <SingleSelectOption value={ALL_STATUS_VALUE}>
                    {formatMessage({
                      id: getTranslation('submissions.filter.all'),
                      defaultMessage: 'All',
                    })}
                  </SingleSelectOption>
                  {STATUS_OPTIONS.map((option) => (
                    <SingleSelectOption key={option.value} value={option.value}>
                      {formatMessage({ id: option.labelId, defaultMessage: option.defaultLabel })}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
                <Field.Hint />
              </Field.Root>

              {canExport && (
                <Field.Root name="include-ip">
                  <Flex gap={2} alignItems="center" paddingBottom={2}>
                    <Switch
                      checked={includeIp}
                      onCheckedChange={(checked: boolean) => setIncludeIp(checked)}
                      onLabel={formatMessage({
                        id: getTranslation('common.on'),
                        defaultMessage: 'On',
                      })}
                      offLabel={formatMessage({
                        id: getTranslation('common.off'),
                        defaultMessage: 'Off',
                      })}
                      aria-label={formatMessage({
                        id: getTranslation('submissions.export.includeIp'),
                        defaultMessage: 'Include IP address in export',
                      })}
                      visibleLabels
                    />
                    <Typography variant="pi" textColor="neutral600">
                      {formatMessage({
                        id: getTranslation('submissions.export.includeIp'),
                        defaultMessage: 'Include IP address in export',
                      })}
                    </Typography>
                  </Flex>
                </Field.Root>
              )}
            </Flex>
          }
        />
      )}

      <Layouts.Content>
        {showLicenseStatusNotice ? (
          <Box marginBottom={4}>
            <LicenseStatusNotice compact />
          </Box>
        ) : null}
        {numberOfSubmissions > 0 ? (
          <>
            <Table
              colCount={5}
              rowCount={numberOfSubmissions + 1}
              aria-label={formatMessage({
                id: getTranslation('submissions.title'),
                defaultMessage: 'Submissions',
              })}
            >
              <Thead>
                <Tr>
                  <Th>
                    {canSelect ? (
                      <Checkbox
                        aria-label={formatMessage({
                          id: getTranslation('common.selectAll'),
                          defaultMessage: 'Select all entries',
                        })}
                        checked={isIndeterminate ? 'indeterminate' : isAllSelected}
                        onCheckedChange={toggleAll}
                      />
                    ) : null}
                  </Th>
                  <Th>
                    <Typography variant="sigma" textColor="neutral600">
                      {formatMessage({
                        id: getTranslation('submissions.column.status'),
                        defaultMessage: 'Status',
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma" textColor="neutral600">
                      {formatMessage({
                        id: getTranslation('submissions.column.submitted'),
                        defaultMessage: 'Submitted',
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma" textColor="neutral600">
                      {formatMessage({
                        id: getTranslation('submissions.column.preview'),
                        defaultMessage: 'Preview',
                      })}
                    </Typography>
                  </Th>
                  <Th>
                    <VisuallyHidden>
                      {formatMessage({
                        id: getTranslation('submissions.column.actions'),
                        defaultMessage: 'Actions',
                      })}
                    </VisuallyHidden>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {submissions.map((submission) => (
                  <Tr
                    key={submission.documentId}
                    onClick={() => handleViewSubmission(submission.documentId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Td onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                      {canSelect ? (
                        <Checkbox
                          aria-label={`${formatMessage({
                            id: getTranslation('common.select'),
                            defaultMessage: 'Select',
                          })} ${submission.documentId}`}
                          checked={selectedIds.includes(submission.documentId)}
                          onCheckedChange={() => toggleSelection(submission.documentId)}
                        />
                      ) : null}
                    </Td>
                    <Td>
                      <StatusBadge status={submission.status} />
                    </Td>
                    <Td>
                      <Typography textColor="neutral800">
                        {formatDate(submission.createdAt)}
                      </Typography>
                    </Td>
                    <Td>
                      <Typography textColor="neutral600" ellipsis>
                        {getPreview(submission.data, form?.fields)}
                      </Typography>
                    </Td>
                    <Td onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                      <Flex gap={1} justifyContent="flex-end">
                        <IconButton
                          label={formatMessage({
                            id: getTranslation('submissions.action.view'),
                            defaultMessage: 'View submission',
                          })}
                          onClick={() => handleViewSubmission(submission.documentId)}
                          variant="ghost"
                        >
                          <Eye />
                        </IconButton>
                        {canDelete && (
                          <IconButton
                            label={formatMessage({
                              id: getTranslation('submissions.action.delete'),
                              defaultMessage: 'Delete submission',
                            })}
                            onClick={() => setDeletingId(submission.documentId)}
                            variant="ghost"
                          >
                            <Trash />
                          </IconButton>
                        )}
                      </Flex>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <Pagination.Root
              pageCount={pagination?.pageCount ?? 1}
              defaultPageSize={DEFAULT_PAGE_SIZE}
              total={pagination?.total ?? 0}
            >
              <Pagination.PageSize options={['10', '25', '50', '100']} />
              <Pagination.Links />
            </Pagination.Root>
          </>
        ) : (
          <EmptyStateLayout
            icon={<EmptyDocuments width="160px" />}
            content={
              status
                ? formatMessage(
                    {
                      id: getTranslation('submissions.empty.filtered'),
                      defaultMessage: 'No submissions with status "{status}" found.',
                    },
                    { status }
                  )
                : formatMessage({
                    id: getTranslation('submissions.empty'),
                    defaultMessage: 'This form has not received any submissions yet.',
                  })
            }
            action={
              status ? (
                <Button variant="secondary" onClick={() => handleStatusFilterChange('')}>
                  {formatMessage({
                    id: getTranslation('submissions.clearFilter'),
                    defaultMessage: 'Clear filter',
                  })}
                </Button>
              ) : null
            }
          />
        )}
      </Layouts.Content>

      {/* Single delete confirmation */}
      <Dialog.Root
        open={deletingId !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setDeletingId(null);
          }
        }}
      >
        <ConfirmDialog
          onConfirm={handleDeleteConfirm}
          variant="danger-light"
          icon={<WarningCircle />}
        >
          {formatMessage({
            id: getTranslation('submissions.delete.confirm'),
            defaultMessage:
              'Are you sure you want to delete this submission? This action cannot be undone.',
          })}
        </ConfirmDialog>
      </Dialog.Root>

      {/* Bulk delete confirmation */}
      <Dialog.Root open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <ConfirmDialog
          onConfirm={handleBulkDeleteConfirm}
          variant="danger-light"
          icon={<WarningCircle />}
        >
          {formatMessage(
            {
              id: getTranslation('submissions.bulkDelete.confirm'),
              defaultMessage:
                'Are you sure you want to delete {count} submission(s)? This action cannot be undone.',
            },
            { count: selectedIds.length }
          )}
        </ConfirmDialog>
      </Dialog.Root>

      {/* Scheduled export (Pro). Unentitled access is removal-only. */}
      {advancedExportPolicy.canRemove ? (
        <Dialog.Root open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
          <Dialog.Content>
            <Dialog.Header>
              {formatMessage({
                id: getTranslation('submissions.export.schedule.dialog.title'),
                defaultMessage: 'Schedule Export',
              })}
            </Dialog.Header>
            <Dialog.Body>
              <Flex direction="column" alignItems="stretch" gap={4} width="100%">
                <Typography variant="pi" textColor="neutral600">
                  {scheduledConfig
                    ? formatMessage({
                        id: getTranslation('submissions.export.schedule.active'),
                        defaultMessage: 'Scheduled export active',
                      })
                    : formatMessage({
                        id: getTranslation('submissions.export.schedule.none'),
                        defaultMessage: 'No schedule configured',
                      })}
                </Typography>

                {advancedExportPolicy.canEdit ? (
                  <>
                    <Field.Root name="schedule-cron">
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.cron'),
                          defaultMessage: 'Cron expression',
                        })}
                      </Field.Label>
                      <TextInput
                        value={scheduleCron}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setScheduleCron(e.target.value)
                        }
                        placeholder={formatMessage({
                          id: getTranslation('submissions.export.schedule.cron.placeholder'),
                          defaultMessage: '0 8 * * 1',
                        })}
                      />
                    </Field.Root>

                    <Field.Root name="schedule-emails">
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.emails'),
                          defaultMessage: 'Recipient email addresses (comma-separated)',
                        })}
                      </Field.Label>
                      <TextInput
                        value={scheduleEmails}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setScheduleEmails(e.target.value)
                        }
                        placeholder="alice@example.com, bob@example.com"
                      />
                    </Field.Root>

                    <Field.Root name="schedule-format">
                      <Field.Label>
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.format'),
                          defaultMessage: 'Export format',
                        })}
                      </Field.Label>
                      <SingleSelect
                        value={scheduleFormat}
                        onChange={(value: string | number) =>
                          setScheduleFormat(value as 'xlsx' | 'pdf' | 'csv')
                        }
                      >
                        <SingleSelectOption value="xlsx">Excel (.xlsx)</SingleSelectOption>
                        <SingleSelectOption value="pdf">PDF</SingleSelectOption>
                        <SingleSelectOption value="csv">CSV</SingleSelectOption>
                      </SingleSelect>
                    </Field.Root>
                  </>
                ) : scheduledConfig ? (
                  <Flex direction="column" alignItems="stretch" gap={3}>
                    <Box>
                      <Typography variant="pi" fontWeight="bold">
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.cron'),
                          defaultMessage: 'Cron expression',
                        })}
                      </Typography>
                      <Typography>{scheduledConfig.cronExpression}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="pi" fontWeight="bold">
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.emails'),
                          defaultMessage: 'Recipient email addresses (comma-separated)',
                        })}
                      </Typography>
                      <Typography>{scheduledConfig.recipientEmails.join(', ')}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="pi" fontWeight="bold">
                        {formatMessage({
                          id: getTranslation('submissions.export.schedule.format'),
                          defaultMessage: 'Export format',
                        })}
                      </Typography>
                      <Typography>{scheduledConfig.format.toUpperCase()}</Typography>
                    </Box>
                  </Flex>
                ) : null}
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.Cancel>
                <Button variant="tertiary">
                  {formatMessage({ id: getTranslation('common.cancel'), defaultMessage: 'Cancel' })}
                </Button>
              </Dialog.Cancel>
              <Flex gap={2}>
                {scheduledConfig && advancedExportPolicy.canRemove ? (
                  <Button
                    variant="danger-light"
                    onClick={handleRemoveSchedule}
                    loading={isSavingSchedule}
                  >
                    {formatMessage({
                      id: getTranslation('submissions.export.schedule.remove'),
                      defaultMessage: 'Remove schedule',
                    })}
                  </Button>
                ) : null}
                {advancedExportPolicy.canEdit ? (
                  <Button onClick={handleSaveSchedule} loading={isSavingSchedule}>
                    {formatMessage({
                      id: getTranslation('submissions.export.schedule.save'),
                      defaultMessage: 'Save schedule',
                    })}
                  </Button>
                ) : null}
              </Flex>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}
    </Page.Main>
  );
};
