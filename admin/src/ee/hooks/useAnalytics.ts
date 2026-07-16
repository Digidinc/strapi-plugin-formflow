/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useState, useEffect } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';

import { API } from '../../utils/api';
import { refreshLicenseOnPaymentRequired } from '../payment-required';
import { useLicense } from './useLicense';

export interface AnalyticsStats {
  views: number;
  starts: number;
  completions: number;
  drop_offs: number;
  conversionRate: number;
}

export interface UseAnalyticsResult {
  stats: AnalyticsStats | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetch aggregated analytics for a form from `GET /formflow/forms/:id/analytics`.
 *
 * The server Pro-gates this endpoint with a 402. An authoritative 402 refreshes
 * the shared license snapshot so the page can render the current access state.
 * Any other failure sets `error` to a message string.
 */
export const useAnalytics = (formDocumentId: string): UseAnalyticsResult => {
  const { get } = useFetchClient();
  const { refresh } = useLicense();
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStats = async () => {
      if (!formDocumentId) {
        setStats(null);
        setError(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await get<{ data: AnalyticsStats }>(API.formAnalytics(formDocumentId));
        if (!cancelled) {
          setStats(response.data.data);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        if (await refreshLicenseOnPaymentRequired(err, refresh)) {
          return;
        }

        if (!cancelled) {
          setStats(null);
          setError(err instanceof Error ? err.message : 'Failed to load analytics');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchStats();

    return () => {
      cancelled = true;
    };
  }, [get, formDocumentId, refresh]);

  return { stats, isLoading, error };
};
