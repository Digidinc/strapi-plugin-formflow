/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { Box, Grid, Flex, Typography, Loader } from '@strapi/design-system';
import { Page, Layouts, BackButton } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { PLUGIN_ID } from '../../pluginId';
import { getTranslation } from '../../utils/getTranslation';
import { useLicense } from '../hooks/useLicense';
import { useAnalytics, type AnalyticsStats } from '../hooks/useAnalytics';
import { LicenseStatusNotice } from '../components/LicenseStatusNotice';
import { UpsellCard } from '../components/UpsellCard';

export interface AnalyticsPageProps {
  formDocumentId: string;
}

/** A single metric tile: a big number with a label underneath. */
const MetricCard = ({ label, value }: { label: string; value: string }) => (
  <Box background="neutral0" hasRadius borderColor="neutral200" padding={5} shadow="tableShadow">
    <Flex direction="column" alignItems="flex-start" gap={2}>
      <Typography variant="alpha" fontWeight="bold" textColor="neutral800">
        {value}
      </Typography>
      <Typography variant="pi" textColor="neutral600">
        {label}
      </Typography>
    </Flex>
  </Box>
);

/**
 * Pro analytics dashboard for a single form (route `forms/:formId/analytics`).
 *
 * Display gating keeps unresolved verification distinct from a confirmed
 * unentitled plan. Only the entitled child calls `useAnalytics`; the server is
 * still the authoritative gate (402 on the read endpoint).
 */
export const AnalyticsPage = ({ formDocumentId }: AnalyticsPageProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();

  const title = formatMessage({
    id: getTranslation('analytics.title'),
    defaultMessage: 'Analytics',
  });

  const analyticsAccess = access('analytics');
  let content = null;

  switch (analyticsAccess) {
    case 'checking':
      content = <Flex justifyContent="center" padding={6}>
          <Loader small>
            {formatMessage({
              id: getTranslation('common.loading'),
              defaultMessage: 'Loading...',
            })}
          </Loader>
        </Flex>;
      break;
    case 'unavailable':
      content = <LicenseStatusNotice compact />;
      break;
    case 'unentitled':
      content = (
        <UpsellCard
          access={analyticsAccess}
          feature="analytics"
          description={formatMessage({
            id: getTranslation('analytics.upsell'),
            defaultMessage:
              'Track views, starts, completions and drop-offs with a FormFlow Pro license.',
          })}
        />
      );
      break;
    case 'entitled':
      content = <EntitledAnalytics formDocumentId={formDocumentId} />;
      break;
  }

  return (
    <Page.Main>
      <Page.Title>{title}</Page.Title>
      <Layouts.Header
        navigationAction={<BackButton disabled={false} fallback={`/plugins/${PLUGIN_ID}`} />}
        title={title}
        subtitle={formatMessage({
          id: getTranslation('analytics.subtitle'),
          defaultMessage: 'Views, starts, completions and drop-offs for this form.',
        })}
      />
      <Layouts.Content>{content}</Layouts.Content>
    </Page.Main>
  );
};

/**
 * Entitled branch — split into its own component so `useAnalytics` is only
 * called when the user is entitled (the upsell branch must not fetch).
 */
const EntitledAnalytics = ({ formDocumentId }: { formDocumentId: string }) => {
  const { formatMessage } = useIntl();
  const { stats, isLoading, error } = useAnalytics(formDocumentId);

  if (isLoading) {
    return (
      <Flex justifyContent="center" padding={8}>
        <Loader>
          {formatMessage({
            id: getTranslation('analytics.loading'),
            defaultMessage: 'Loading analytics…',
          })}
        </Loader>
      </Flex>
    );
  }

  if (error) {
    return (
      <Box background="danger100" hasRadius borderColor="danger200" padding={4}>
        <Typography textColor="danger600">{error}</Typography>
      </Box>
    );
  }

  const metrics: Array<{ label: string; value: string }> = [
    {
      label: formatMessage({ id: getTranslation('analytics.views'), defaultMessage: 'Views' }),
      value: formatNumber(stats?.views),
    },
    {
      label: formatMessage({ id: getTranslation('analytics.starts'), defaultMessage: 'Starts' }),
      value: formatNumber(stats?.starts),
    },
    {
      label: formatMessage({
        id: getTranslation('analytics.completions'),
        defaultMessage: 'Completions',
      }),
      value: formatNumber(stats?.completions),
    },
    {
      label: formatMessage({
        id: getTranslation('analytics.dropOffs'),
        defaultMessage: 'Drop-offs',
      }),
      value: formatNumber(stats?.drop_offs),
    },
    {
      label: formatMessage({
        id: getTranslation('analytics.conversionRate'),
        defaultMessage: 'Conversion rate',
      }),
      value: formatRate(stats),
    },
  ];

  return (
    <Grid.Root gap={4} gridCols={12}>
      {metrics.map((metric) => (
        <Grid.Item key={metric.label} col={4} xs={12} s={6} direction="column" alignItems="stretch">
          <MetricCard label={metric.label} value={metric.value} />
        </Grid.Item>
      ))}
    </Grid.Root>
  );
};

/** Render a count, defaulting to 0 while/if stats are absent. */
const formatNumber = (value: number | undefined): string => String(value ?? 0);

/** Render the conversion rate (a 0–1 fraction) as a whole-percentage string. */
const formatRate = (stats: AnalyticsStats | null): string => {
  const rate = stats?.conversionRate ?? 0;
  return `${Math.round(rate * 100)}%`;
};
